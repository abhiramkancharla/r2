import * as path from 'path';
import chokidar from 'chokidar';
import { generateFormNotes } from '../llm/forms';

const DEBOUNCE_MS = 60_000; // settle 60s after last sessions write

/**
 * Watches ~/R2Vault/sessions/*.json. When a day file changes (new sessions or
 * new events), debounce 60s then re-scan ALL sessions for form activity and
 * regenerate any affected form notes. LLM calls go through the global
 * llmCoordinator (already serialized).
 *
 * Cheap fast path: detection is pure file-read; the LLM only fires for forms
 * that actually have new responses. (generateFormNotes overwrites md per
 * form — same form across days produces one consolidated file.)
 */
export class FormsWatcher {
  private vaultDir: string;
  private watcher: chokidar.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
  }

  start() {
    const sessionsGlob = path.join(this.vaultDir, 'sessions', '*.json');
    this.watcher = chokidar.watch(sessionsGlob, {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    });
    this.watcher.on('add', () => this.schedule());
    this.watcher.on('change', () => this.schedule());
    this.watcher.on('error', (err) => console.error('[forms] watch error', err));
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.watcher) { try { this.watcher.close(); } catch { /* */ } this.watcher = null; }
  }

  /** Run a scan now (boot-time catch-up). */
  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const results = await generateFormNotes({ vaultDir: this.vaultDir });
      if (results.length === 0) {
        console.log(`[forms] no form sessions detected`);
        return;
      }
      for (const r of results) {
        if (r.ok) console.log(`[forms] ✓ ${r.formName} → ${r.outputPath} (${r.sessionCount} sessions, ${r.totalDurationMs}ms)`);
        else      console.log(`[forms] skipped ${r.formName ?? '?'}: ${r.reason}`);
      }
    } catch (err: any) {
      console.error('[forms] scan failed', err?.message ?? err);
    } finally {
      this.running = false;
    }
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.runOnce(); }, DEBOUNCE_MS);
  }
}
