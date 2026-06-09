import { spawn, ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Electron-side wrapper around the Swift NotchHelper sidecar.
 *
 * Mirrors the AXHelper pattern (`electron/capture/axHelper.ts`): spawn the
 * Swift binary, read one JSON event per stdout line, restart on crash.
 *
 * This milestone is UI-only — the wrapper exposes a `send` event that
 * fires whenever the user submits text into the notch chat bar. Nothing
 * is routed into the LLM yet; main.ts just logs it. Functional wiring
 * lands in a follow-up.
 */

export type NotchSendEvent = {
  ts: number;
  text: string;
};

type Events = {
  ready: () => void;
  send: (e: NotchSendEvent) => void;
  exit: (code: number | null) => void;
};

export class NotchHelper extends EventEmitter {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private binPath: string;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(binPath: string) {
    super();
    this.binPath = binPath;
  }

  on<K extends keyof Events>(event: K, listener: Events[K]): this {
    return super.on(event, listener as any);
  }
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean {
    return super.emit(event, ...args);
  }

  start() {
    if (this.proc) return;
    if (!fs.existsSync(this.binPath)) {
      console.warn(
        `[notch-helper] binary missing at ${this.binPath} — feature disabled. Run: npm run build:notch`
      );
      return;
    }

    const proc = spawn(this.binPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[notch-helper] ${chunk}`);
    });

    proc.on('exit', (code) => {
      this.proc = null;
      this.emit('exit', code);
      // Auto-restart on unexpected exit. Code 0 = clean shutdown, leave it.
      if (code !== 0) {
        this.restartTimer = setTimeout(() => this.start(), 3000);
      }
    });
  }

  stop() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }

  /** Future use: tell sidecar to show/hide the notch. No-op until then. */
  sendCommand(cmd: 'show' | 'hide') {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(JSON.stringify({ cmd }) + '\n');
    } catch {
      // pipe closed mid-write — sidecar likely restarting, ignore
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj?.event === 'ready') {
      this.emit('ready');
    } else if (obj?.event === 'send' && typeof obj.text === 'string') {
      this.emit('send', { ts: Number(obj.ts) || Date.now(), text: obj.text });
    }
  }
}

/**
 * Find the NotchHelper binary in dev OR packaged builds. Search order
 * mirrors resolveAXBinPath so the two sidecars behave identically.
 */
export function resolveNotchBinPath(appPath: string): string {
  const roots = [
    appPath,
    path.join(appPath, '..'),
    path.join(appPath, '..', '..'),
    process.cwd()
  ];
  const candidates: string[] = [];
  for (const r of roots) {
    candidates.push(path.join(r, 'native', 'notch-helper', '.build', 'debug', 'NotchHelper'));
    candidates.push(path.join(r, 'native', 'notch-helper', '.build', 'release', 'NotchHelper'));
  }
  candidates.push(path.join(appPath, 'bin', 'notch-helper'));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'notch-helper'));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[0];
}
