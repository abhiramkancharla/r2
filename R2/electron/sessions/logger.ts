import { randomUUID } from 'crypto';
import type { ActivityTracker, ActivitySnapshot } from '../tracker/activity';
import type { AXHelper, CapturedMessage } from '../capture/axHelper';
import { categorize, classifySubmission } from './categorize';
import { FileWriter } from './fileWriter';
import type { DayLog, Session, SessionEvent } from './types';

const IDLE_THRESHOLD_S = 60;
const TITLE_DEBOUNCE_MS = 1000;
const MIN_SESSION_MS = 1500; // discard ultra-short flicker sessions

type Opts = {
  tracker: ActivityTracker;
  ax: AXHelper;
  dir: string;
  // Bundle ID can't be derived from active-win in all cases; pass-through if known.
  // Optional override hooks for tests.
  now?: () => number;
};

export class SessionLogger {
  private tracker: ActivityTracker;
  private ax: AXHelper;
  private writer: FileWriter;
  private now: () => number;

  // In-memory state for current day
  private currentDate: string = '';
  private dayLog: DayLog | null = null;
  private current: Session | null = null;

  // Pending change debouncing — title flap protection
  private pendingChange: { snap: ActivitySnapshot; firstSeenAt: number } | null = null;

  private wasIdle = false;

  constructor(opts: Opts) {
    this.tracker = opts.tracker;
    this.ax = opts.ax;
    this.writer = new FileWriter(opts.dir);
    this.now = opts.now ?? (() => Date.now());
  }

  start() {
    // Re-hydrate today's file if it exists so we append rather than overwrite
    this.currentDate = this.dateOf(this.now());
    const existing = this.writer.read(this.currentDate);
    this.dayLog = existing ?? { date: this.currentDate, generatedAt: this.now(), sessions: [] };
    // Any session in the file with endTs === null was left open from a prior
    // run — close it now with its last known timing.
    for (const s of this.dayLog.sessions) {
      if (s.endTs == null) {
        s.endTs = s.startTs;
        s.durationMs = 0;
      }
    }

    this.tracker.on('snapshot', (snap) => this.onSnapshot(snap));
    this.ax.on('message', (m) => this.onMessage(m));
  }

  // Called on tracker poll (~5s)
  private onSnapshot(snap: ActivitySnapshot) {
    const ts = snap.ts;
    this.rolloverIfNewDay(ts);

    const idle = snap.idleSeconds >= IDLE_THRESHOLD_S;

    // Idle handling: close any open session, mark wasIdle, skip until activity resumes
    if (idle) {
      if (this.current) this.closeCurrent(ts);
      this.wasIdle = true;
      this.pendingChange = null;
      return;
    }

    const justResumed = this.wasIdle;
    this.wasIdle = false;

    // Empty app reading — keep current session open, don't churn
    if (!snap.app) return;

    if (!this.current || justResumed) {
      this.openSession(snap, ts);
      this.persist();
      return;
    }

    const sameApp = this.current.app === snap.app;
    const sameTitle = this.current.title === (snap.title ?? '');
    const sameUrl = this.current.url === (snap.url ?? null);

    if (sameApp && sameTitle && sameUrl) {
      // Nothing changed — extend current session implicitly (endTs filled on close)
      this.pendingChange = null;
      return;
    }

    // Title-only flap protection: require the change to persist beyond debounce
    const onlyTitleChange = sameApp && !sameTitle && sameUrl;
    if (onlyTitleChange) {
      if (!this.pendingChange || this.pendingChange.snap.title !== snap.title) {
        this.pendingChange = { snap, firstSeenAt: ts };
        return;
      }
      if (ts - this.pendingChange.firstSeenAt < TITLE_DEBOUNCE_MS) {
        return;
      }
      // Debounce satisfied — fall through and roll the session
      this.pendingChange = null;
    } else {
      this.pendingChange = null;
    }

    // Switch sessions
    this.closeCurrent(ts);
    this.openSession(snap, ts);
    this.persist();
  }

  // Called by main when an AI reply has been captured. Pushes it onto the
  // current session's events so the diary can reason over both sides.
  recordAssistantReply(turn: { ts: number; app: string; assistantText: string }) {
    if (!this.current) return;
    if (turn.app && this.current.app && turn.app !== this.current.app) return;
    const ev: SessionEvent = {
      kind: 'assistant_reply',
      ts: turn.ts,
      text: turn.assistantText
    };
    this.current.events.push(ev);
    this.persist();
  }

  // Called on each captured user-submitted sentence
  private onMessage(m: CapturedMessage) {
    if (m.kind !== 'sentence') return;
    if (!this.current) return;

    // Only attribute the event to the current session if the message came
    // from the same app currently in focus. Avoids the wrong session getting
    // an event right at a switch boundary.
    if (m.app && this.current.app && m.app !== this.current.app) return;

    const kind = classifySubmission(this.current.category, this.current.url, this.current.title);
    const ev: SessionEvent = {
      kind,
      ts: m.ts,
      text: m.text
    };
    this.current.events.push(ev);
    this.persist();
  }

  // Lifecycle helpers ------------------------------------------------------

  private openSession(snap: ActivitySnapshot, ts: number) {
    const app = snap.app ?? 'Unknown';
    const title = snap.title ?? '';
    const url = snap.url ?? null;
    const category = categorize({ app, title, url });
    const session: Session = {
      id: randomUUID(),
      startTs: ts,
      endTs: null,
      durationMs: null,
      app,
      title,
      url,
      bundleId: null,
      category,
      events: []
    };
    this.current = session;
    if (this.dayLog) this.dayLog.sessions.push(session);
  }

  private closeCurrent(ts: number) {
    if (!this.current) return;
    this.current.endTs = ts;
    this.current.durationMs = ts - this.current.startTs;

    // Discard ultra-short flicker sessions with no events
    if (this.current.durationMs < MIN_SESSION_MS && this.current.events.length === 0) {
      if (this.dayLog && this.dayLog.sessions[this.dayLog.sessions.length - 1] === this.current) {
        this.dayLog.sessions.pop();
      }
    }
    this.current = null;
  }

  private rolloverIfNewDay(ts: number) {
    const d = this.dateOf(ts);
    if (d === this.currentDate) return;
    // Close current session at midnight boundary, write final state, start fresh file
    if (this.current) this.closeCurrent(ts);
    if (this.dayLog) {
      this.dayLog.generatedAt = ts;
      this.writer.schedule(this.dayLog);
      this.writer.flush();
    }
    this.currentDate = d;
    this.dayLog = { date: d, generatedAt: ts, sessions: [] };
  }

  private dateOf(ts: number): string {
    const date = new Date(ts);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private persist() {
    if (!this.dayLog) return;
    this.dayLog.generatedAt = this.now();
    this.writer.schedule(this.dayLog);
  }

  // Flush + close on shutdown
  flush() {
    if (this.current) this.closeCurrent(this.now());
    this.writer.flush();
  }
}
