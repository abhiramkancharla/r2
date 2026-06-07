import { spawn, ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { redact } from './redaction';

export type CapturedMessage = {
  ts: number;
  kind: 'word' | 'sentence';
  app: string;
  bundleId: string;
  window: string;
  text: string;
  redacted: string[];
};

export type CapturedAiTurn = {
  ts: number;
  app: string;
  bundleId: string;
  window: string;
  site: string;
  chatName: string;
  url: string;
  userText: string;
  assistantText: string;
};

export type AXStatus =
  | { kind: 'ax_ok' }
  | { kind: 'ax_denied'; message: string }
  | { kind: 'blocked_bundle'; bundleId: string }
  | { kind: 'blocked_title'; title: string; app: string };

type Events = {
  message: (m: CapturedMessage) => void;
  aiTurn: (t: CapturedAiTurn) => void;
  urlHint: (h: { ts: number; pid: number; url: string }) => void;
  status: (s: AXStatus) => void;
  exit: (code: number | null) => void;
};

export class AXHelper extends EventEmitter {
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
    if (!fs.existsSync(this.binPath)) {
      this.emit('status', { kind: 'ax_denied', message: `ax-helper binary missing at ${this.binPath}. Run: npm run build:ax` });
      return;
    }
    if (this.proc) return;

    const proc = spawn(this.binPath, [], {
      // stdin must be writable so we can pipe site hints (URL → site) to Swift.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } // R2_DEBUG opt-in only
    });
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    proc.stderr.on('data', (chunk) => {
      // forward swift stderr to console for debugging; do not store
      process.stderr.write(`[ax-helper] ${chunk}`);
    });

    proc.on('exit', (code) => {
      this.proc = null;
      this.emit('exit', code);
      // Auto-restart on unexpected exit (but not on permission denial — exit code 2)
      if (code !== 2 && code !== 0) {
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

  /**
   * Tell the Swift helper that a given pid is currently on an AI-chat site.
   * Use empty `site` to clear. Sent as one JSON line on the helper's stdin.
   */
  sendSiteHint(pid: number, site: string) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    const payload = JSON.stringify({ cmd: 'siteHint', pid, site }) + '\n';
    try {
      this.proc.stdin.write(payload);
    } catch {
      // pipe closed mid-write — helper likely restarting, ignore
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.type === 'status') {
      this.emit('status', { kind: obj.kind, ...obj });
      return;
    }
    if (obj.type === 'message') {
      const { text, redacted } = redact(String(obj.text ?? ''));
      if (!text) return;
      const kind = obj.kind === 'word' ? 'word' : 'sentence';
      const m: CapturedMessage = {
        ts: Number(obj.ts),
        kind,
        app: String(obj.app ?? ''),
        bundleId: String(obj.bundleId ?? ''),
        window: String(obj.window ?? ''),
        text,
        redacted
      };
      this.emit('message', m);
      return;
    }

    if (obj.type === 'url_hint') {
      this.emit('urlHint', {
        ts: Number(obj.ts) || Date.now(),
        pid: Number(obj.pid) || 0,
        url: String(obj.url ?? '')
      });
      return;
    }

    if (obj.type === 'ai_turn') {
      const t: CapturedAiTurn = {
        ts: Number(obj.ts),
        app: String(obj.app ?? ''),
        bundleId: String(obj.bundleId ?? ''),
        window: String(obj.window ?? ''),
        site: String(obj.site ?? 'unknown'),
        chatName: String(obj.chatName ?? ''),
        url: String(obj.url ?? ''),
        userText: String(obj.userText ?? ''),
        assistantText: String(obj.assistantText ?? '')
      };
      this.emit('aiTurn', t);
      return;
    }
  }
}

export function resolveAXBinPath(appPath: string): string {
  // Candidates, in order:
  //   1. repo root (dev): <repo>/native/ax-helper/.build/release/AXHelper
  //      — when running from compiled dist/electron, appPath points there, so
  //        we also walk up one and two levels.
  //   2. process.cwd() — dev runs are launched from repo root.
  //   3. packaged app: <Resources>/bin/ax-helper.
  const repoRoots = [
    appPath,
    path.join(appPath, '..'),
    path.join(appPath, '..', '..'),
    process.cwd()
  ];
  const candidates: string[] = [];
  for (const root of repoRoots) {
    candidates.push(path.join(root, 'native', 'ax-helper', '.build', 'debug', 'AXHelper'));
    candidates.push(path.join(root, 'native', 'ax-helper', '.build', 'release', 'AXHelper'));
  }
  candidates.push(path.join(appPath, 'bin', 'ax-helper'));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'ax-helper'));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Return the most informative default so the error message points somewhere useful
  return candidates[0];
}
