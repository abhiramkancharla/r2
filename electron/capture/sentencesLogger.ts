import * as fs from 'fs';
import * as path from 'path';
import type { AXHelper, CapturedMessage } from './axHelper';

/**
 * Captures every user-typed sentence (Enter-submitted text) into a daily
 * JSON in the R2Obsidian vault.
 *
 *   ~/Downloads/R2Obsidian/messages_raw/msg-<YYYY-MM-DD>.json
 *
 * Flush rules (whichever fires first):
 *   • Buffer hits FLUSH_WORDS (40 words) of NEW content, OR
 *   • FLUSH_INTERVAL_MS (8 min) since last flush AND buffer is non-empty.
 * Also flushes on stop() so quit doesn't lose pending sentences.
 */
const FLUSH_WORDS = 40;
const FLUSH_INTERVAL_MS = 8 * 60_000; // 8 minutes (in the user's 5–10 min window)
const TIMER_TICK_MS = 60_000;          // check every minute

type Sentence = {
  ts: number;
  app: string;
  window: string;
  text: string;
};

export class SentencesLogger {
  private dir: string;
  private ax: AXHelper;
  private pending: Sentence[] = [];
  private pendingWords = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastFlushAt = 0;

  constructor(opts: { obsidianDir: string; ax: AXHelper }) {
    this.dir = path.join(opts.obsidianDir, 'messages_raw');
    this.ax = opts.ax;
    fs.mkdirSync(this.dir, { recursive: true });
    this.lastFlushAt = Date.now();
  }

  start() {
    this.ax.on('message', (m) => this.onMessage(m));
    this.timer = setInterval(() => this.maybeFlush(), TIMER_TICK_MS);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Final flush so quit doesn't lose buffered text.
    if (this.pending.length) this.flushNow();
  }

  private onMessage(m: CapturedMessage) {
    if (m.kind !== 'sentence') return;
    const text = (m.text ?? '').trim();
    if (!text) return;
    this.pending.push({
      ts: m.ts,
      app: m.app || '',
      window: m.window || '',
      text
    });
    this.pendingWords += wordCount(text);
    if (this.pendingWords >= FLUSH_WORDS) this.flushNow();
  }

  private maybeFlush() {
    if (this.pending.length === 0) return;
    if (Date.now() - this.lastFlushAt >= FLUSH_INTERVAL_MS) this.flushNow();
  }

  private flushNow() {
    if (this.pending.length === 0) return;
    // Group flushed sentences by local date so writes split correctly at midnight.
    const byDate = new Map<string, Sentence[]>();
    for (const s of this.pending) {
      const d = localDate(s.ts);
      const arr = byDate.get(d) ?? [];
      arr.push(s);
      byDate.set(d, arr);
    }
    this.pending = [];
    this.pendingWords = 0;
    this.lastFlushAt = Date.now();

    for (const [date, batch] of byDate) {
      try {
        this.appendDay(date, batch);
      } catch (err) {
        console.error('[sentences] flush failed', date, err);
      }
    }
    console.log(`[sentences] flushed ${[...byDate.values()].reduce((n, a) => n + a.length, 0)} sentences`);
  }

  private appendDay(date: string, batch: Sentence[]) {
    const file = path.join(this.dir, `msg-${date}.json`);
    let log: { date: string; sentences: Sentence[] };
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(log.sentences)) log.sentences = [];
    } catch {
      log = { date, sentences: [] };
    }
    log.sentences.push(...batch);
    log.sentences.sort((a, b) => a.ts - b.ts);

    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
