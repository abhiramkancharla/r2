import * as fs from 'fs';
import * as path from 'path';
import type { DayLog } from './types';

// Atomic, debounced JSON writer. Writes to <path>.tmp then renames over the
// real file so readers never see a partial document.
export class FileWriter {
  private dir: string;
  private debounceMs: number;
  private pending: Map<string, DayLog> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string, debounceMs = 500) {
    this.dir = dir;
    this.debounceMs = debounceMs;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  schedule(dayLog: DayLog) {
    this.pending.set(dayLog.date, dayLog);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [date, log] of this.pending) {
      const file = path.join(this.dir, `${date}.json`);
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        // Don't crash the app over a write failure; surface and move on.
        console.error('[sessions] write failed', file, err);
      }
    }
    this.pending.clear();
  }

  read(date: string): DayLog | null {
    const file = path.join(this.dir, `${date}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw) as DayLog;
    } catch {
      return null;
    }
  }
}
