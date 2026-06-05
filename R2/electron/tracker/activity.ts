import { EventEmitter } from 'events';
import { powerMonitor } from 'electron';

export type ActivitySnapshot = {
  ts: number;
  app: string | null;
  title: string | null;
  url: string | null;
  pid: number | null;
  bundleId: string | null;
  idleSeconds: number;
};

type Options = { pollMs: number; idleMs: number };

export class ActivityTracker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private opts: Options;
  private last: ActivitySnapshot | null = null;
  private running = false;

  constructor(opts: Options) {
    super();
    this.opts = opts;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
  }

  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  stop() {
    this.pause();
    this.removeAllListeners();
  }

  lastSnapshot() {
    return this.last;
  }

  private async tick() {
    try {
      // active-win is ESM-only; lazy dynamic import keeps CJS Electron happy
      const mod = await import('active-win');
      const activeWin = (mod as any).default ?? mod;
      const win = await activeWin();
      const idle = powerMonitor.getSystemIdleTime();

      const snap: ActivitySnapshot = {
        ts: Date.now(),
        app: win?.owner?.name ?? null,
        title: win?.title ?? null,
        url: (win as any)?.url ?? null,
        pid: (win as any)?.owner?.processId ?? null,
        bundleId: (win as any)?.owner?.bundleId ?? null,
        idleSeconds: idle
      };

      this.last = snap;
      this.emit('snapshot', snap);
    } catch (err) {
      // permission denied / unsupported platform — emit empty snapshot
      const snap: ActivitySnapshot = {
        ts: Date.now(),
        app: null,
        title: null,
        url: null,
        pid: null,
        bundleId: null,
        idleSeconds: powerMonitor.getSystemIdleTime()
      };
      this.last = snap;
      this.emit('snapshot', snap);
    }
  }
}
