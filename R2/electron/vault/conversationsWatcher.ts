import * as path from 'path';
import chokidar from 'chokidar';
import { generateProjectFromConversation } from '../llm/projects';

const INITIAL_DELAY_MS = 10 * 60_000;   // 10-minute buffer after first creation
const MODIFY_SETTLE_MS = 2_000;          // debounce burst writes to ~2s settle

/**
 * Watches ~/R2Vault/conversations/**\/*.json and triggers project-idea
 * extraction:
 *   - On file add → schedule analysis 10 minutes later (lets the chat develop).
 *   - On file modification → debounce 2s, then run analysis. If a project .md
 *     already exists for this chat, write a versioned <chatName>-N.md.
 *
 * Serializes calls to the local LLM (one at a time) so we don't thrash.
 */
export class ConversationsWatcher {
  private vaultDir: string;
  private convDir: string;
  private watcher: chokidar.FSWatcher | null = null;

  private initialTimers = new Map<string, NodeJS.Timeout>();
  private modifyTimers = new Map<string, NodeJS.Timeout>();
  private addedRecently = new Set<string>(); // files for which initial is still pending

  private queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
    this.convDir = path.join(vaultDir, 'conversations');
  }

  start() {
    this.watcher = chokidar.watch(`${this.convDir}/**/*.json`, {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    });

    this.watcher
      .on('add',    (p) => this.onAdd(p))
      .on('change', (p) => this.onChange(p))
      .on('error',  (err) => console.error('[conv-watch] error', err));
  }

  stop() {
    for (const t of this.initialTimers.values()) clearTimeout(t);
    for (const t of this.modifyTimers.values()) clearTimeout(t);
    this.initialTimers.clear();
    this.modifyTimers.clear();
    this.addedRecently.clear();
    this.queue = [];
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = null;
    }
  }

  // ----------- handlers -----------

  private onAdd(jsonPath: string) {
    if (!jsonPath.endsWith('.json')) return;
    if (path.basename(jsonPath).startsWith('.')) return;
    if (this.initialTimers.has(jsonPath)) return;

    console.log(`[conv-watch] add ${path.relative(this.vaultDir, jsonPath)} — scheduling initial in 10 min`);
    this.addedRecently.add(jsonPath);
    const timer = setTimeout(() => {
      this.initialTimers.delete(jsonPath);
      this.addedRecently.delete(jsonPath);
      this.enqueue(() => this.runInitial(jsonPath));
    }, INITIAL_DELAY_MS);
    this.initialTimers.set(jsonPath, timer);
  }

  private onChange(jsonPath: string) {
    if (!jsonPath.endsWith('.json')) return;
    if (path.basename(jsonPath).startsWith('.')) return;

    // Debounce: collapse rapid writes into a single run after settle.
    const existing = this.modifyTimers.get(jsonPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.modifyTimers.delete(jsonPath);
      // If this file is still inside its initial-10-min window, the next run
      // should be treated as 'initial' (overwrites the primary file).
      const initialPending = this.initialTimers.has(jsonPath) || this.addedRecently.has(jsonPath);
      this.enqueue(() => initialPending ? this.runInitial(jsonPath) : this.runModification(jsonPath));
    }, MODIFY_SETTLE_MS);
    this.modifyTimers.set(jsonPath, timer);
  }

  // ----------- runs -----------

  private async runInitial(jsonPath: string) {
    // Cancel any pending initial timer for this path — we're running now.
    const existing = this.initialTimers.get(jsonPath);
    if (existing) {
      clearTimeout(existing);
      this.initialTimers.delete(jsonPath);
    }
    console.log(`[conv-watch] running INITIAL on ${path.basename(jsonPath)}`);
    const result = await generateProjectFromConversation({
      vaultDir: this.vaultDir,
      jsonPath,
      mode: 'initial'
    });
    this.logResult(result);
  }

  private async runModification(jsonPath: string) {
    console.log(`[conv-watch] running MODIFICATION on ${path.basename(jsonPath)}`);
    const result = await generateProjectFromConversation({
      vaultDir: this.vaultDir,
      jsonPath,
      mode: 'modification'
    });
    this.logResult(result);
  }

  private logResult(result: Awaited<ReturnType<typeof generateProjectFromConversation>>) {
    if (result.ok) {
      console.log(`[conv-watch] wrote ${result.outputPath} (turns=${result.turns}, ${result.totalDurationMs}ms)`);
    } else if (result.reason === 'no_project_ideas') {
      console.log(`[conv-watch] no project ideas in ${result.chatName ?? '<unknown>'} — skipped`);
    } else {
      console.log(`[conv-watch] skipped: ${result.reason}`);
    }
  }

  // ----------- LLM queue -----------

  private enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        try {
          await task();
        } catch (err) {
          console.error('[conv-watch] task failed', err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
