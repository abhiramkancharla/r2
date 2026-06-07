import * as fs from 'fs';
import * as path from 'path';
import type { ActivityTracker, ActivitySnapshot } from '../tracker/activity';
import type { AXHelper, CapturedMessage } from '../capture/axHelper';
import { routeUrl, routeSentence } from './router';
import type { MediaDayLog, MediaEvent, MediaSite, MediaEventKind } from './types';

const MIN_DWELL_MS = 5_000;
// Video-content kinds require longer dwell before they count toward
// "watch history". Browsing the YouTube home page = 5s threshold; actively
// watching a video = 60s threshold.
const VIDEO_KINDS = new Set<MediaEventKind>(['yt_video', 'yt_short', 'tt_video']);
const MIN_DWELL_MS_VIDEO = 60_000;
const IDLE_THRESHOLD_S = 60;

type Opts = {
  rootDir: string; // ~/R2Vault
  tracker: ActivityTracker;
  ax: AXHelper;
};

type Active = {
  site: MediaSite;
  kind: MediaEventKind;
  url: string;
  title: string;
  startedAt: number;
  lastTickAt: number;
  params: Partial<MediaEvent>;
};

/**
 * Captures social-media activity to ~/R2Vault/media_raw/<site>/<date>.json.
 *
 * - Subscribes to tracker snapshots: routes URL → site+event, tracks dwell
 *   while same URL stays focused, writes one event when the visit ends.
 * - Subscribes to AX sentences: when frontmost URL is a media site, routes
 *   the sentence to a search/dm_sent/comment_drafted event tied to that site.
 */
export class MediaLogger {
  private dir: string;
  private tracker: ActivityTracker;
  private ax: AXHelper;
  private active: Active | null = null;
  private lastSnap: ActivitySnapshot | null = null;

  constructor(opts: Opts) {
    this.dir = path.join(opts.rootDir, 'media_raw');
    this.tracker = opts.tracker;
    this.ax = opts.ax;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  start() {
    this.tracker.on('snapshot', (s) => this.onSnapshot(s));
    this.ax.on('message', (m) => this.onMessage(m));
  }

  // ----- snapshot path -----

  private onSnapshot(snap: ActivitySnapshot) {
    this.lastSnap = snap;
    const ts = snap.ts;
    const idle = snap.idleSeconds >= IDLE_THRESHOLD_S;

    // Idle or no URL → end any active visit and stop.
    if (idle || !snap.url) {
      if (this.active) this.endActive(ts);
      return;
    }

    const routed = routeUrl(snap.url, snap.title);
    if (!routed) {
      // Not a media site
      if (this.active) this.endActive(ts);
      return;
    }

    // Same URL as the current active visit → just extend dwell.
    if (this.active && this.active.url === snap.url) {
      this.active.lastTickAt = ts;
      return;
    }

    // Different URL (or starting fresh) → close prior, open new.
    if (this.active) this.endActive(ts);
    this.active = {
      site: routed.site,
      kind: routed.kind,
      url: snap.url,
      title: snap.title ?? '',
      startedAt: ts,
      lastTickAt: ts,
      params: routed.params
    };
  }

  private endActive(now: number) {
    if (!this.active) return;
    const closing = this.active;
    this.active = null;
    const dwellMs = Math.max(0, closing.lastTickAt - closing.startedAt);

    const isVideo = VIDEO_KINDS.has(closing.kind);
    const minDwell = isVideo ? MIN_DWELL_MS_VIDEO : MIN_DWELL_MS;
    if (dwellMs < minDwell) return;

    const ev: MediaEvent = {
      ts: closing.startedAt,
      kind: closing.kind,
      dwellMs,
      url: closing.url,
      title: closing.title || undefined,
      ...closing.params,
      // Flag video sessions that cleared the 60s bar as watch history so
      // downstream consumers (diary, persona) can filter them quickly.
      ...(isVideo ? { watchHistory: true } : {})
    };
    this.appendEvent(closing.site, ev);
  }

  // ----- AX sentence path (search queries, DMs, etc) -----

  private onMessage(m: CapturedMessage) {
    if (m.kind !== 'sentence') return;
    const snap = this.lastSnap;
    if (!snap?.url) return;
    const routed = routeSentence(snap.url, snap.title);
    if (!routed) return;

    const ev: MediaEvent = {
      ts: m.ts,
      kind: routed.kind,
      url: snap.url,
      title: snap.title ?? undefined,
      text: m.text,
      // search queries already arrive as the text payload
      query: routed.kind.endsWith('_search') || routed.kind.endsWith('search') ? m.text : undefined
    };
    this.appendEvent(routed.site, ev);
  }

  // ----- write path -----

  private appendEvent(site: MediaSite, ev: MediaEvent) {
    const date = localDate(ev.ts);
    const siteDir = path.join(this.dir, site);
    fs.mkdirSync(siteDir, { recursive: true });
    const file = path.join(siteDir, `${date}.json`);

    let log: MediaDayLog;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      log = JSON.parse(raw) as MediaDayLog;
      if (!Array.isArray(log.events)) log.events = [];
    } catch {
      log = {
        site,
        date,
        startedAt: ev.ts,
        updatedAt: ev.ts,
        totalDwellMs: 0,
        events: []
      };
    }
    log.events.push(ev);
    log.events.sort((a, b) => a.ts - b.ts);
    log.updatedAt = Math.max(log.updatedAt, ev.ts);
    log.totalDwellMs = log.events.reduce((sum, e) => sum + (e.dwellMs ?? 0), 0);

    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Flush any open visit (call on app quit). */
  flush() {
    if (this.active) this.endActive(Date.now());
  }
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
