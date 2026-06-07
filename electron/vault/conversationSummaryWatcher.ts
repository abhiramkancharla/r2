import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar from 'chokidar';
import { summarizeConversation } from '../llm/conversationSummary';

const DEBOUNCE_MS = 30_000; // 30s settle after last write

/**
 * Watches ~/R2Vault/conversations/**\/*.json and, after a 30-second settle,
 * generates an Obsidian summary at
 *   ~/Downloads/R2Obsidian/conversations/<site>/<chatName>.md
 *
 * Concurrency: tasks go through llmCoordinator (single LLM call in flight).
 * Local FIFO so terminal status (pending count) stays accurate.
 */
export class ConversationSummaryWatcher {
  private vaultDir: string;
  private obsidianDir: string;
  private convDir: string;
  private watcher: chokidar.FSWatcher | null = null;

  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private queue: string[] = [];
  private processing: string | null = null;

  constructor(vaultDir: string, obsidianDir?: string) {
    this.vaultDir = vaultDir;
    this.obsidianDir = obsidianDir ?? path.join(os.homedir(), 'Downloads', 'R2Obsidian');
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
      .on('add',    (p) => this.onChange(p))
      .on('change', (p) => this.onChange(p))
      .on('error',  (err) => console.error('[conv-md] watch error', err));
  }

  stop() {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.queue = [];
    this.processing = null;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* */ }
      this.watcher = null;
    }
  }

  /**
   * Boot-time catch-up: enqueue any conversation JSON that lacks a
   * corresponding Obsidian summary md.
   */
  catchUpMissing() {
    let sites: string[] = [];
    try { sites = fs.readdirSync(this.convDir); } catch { return; }
    let added = 0;
    for (const site of sites) {
      const siteDir = path.join(this.convDir, site);
      let files: string[] = [];
      try { files = fs.readdirSync(siteDir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        const jsonPath = path.join(siteDir, f);
        const chatName = path.basename(f, '.json');
        const mdPath = path.join(this.obsidianDir, 'conversations', site, `${sanitizeForFs(chatName)}.md`);
        if (fs.existsSync(mdPath)) continue;
        this.enqueue(jsonPath, /*silent=*/ true);
        added += 1;
      }
    }
    if (added > 0) console.log(`[conv-md] catchup queued ${added} missing summaries`);
  }

  private onChange(jsonPath: string) {
    if (!jsonPath.endsWith('.json')) return;
    if (path.basename(jsonPath).startsWith('.')) return;
    const existing = this.debounceTimers.get(jsonPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.debounceTimers.delete(jsonPath);
      this.enqueue(jsonPath);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(jsonPath, t);
  }

  private enqueue(jsonPath: string, silent = false) {
    if (this.queue.includes(jsonPath) || this.processing === jsonPath) return;
    this.queue.push(jsonPath);
    if (!silent) {
      const rel = path.relative(this.vaultDir, jsonPath);
      console.log(`[conv-md] queued ${rel} (pending=${this.queue.length})`);
    }
    void this.drain();
  }

  private async drain() {
    if (this.processing) return;
    while (this.queue.length) {
      const jsonPath = this.queue.shift()!;
      this.processing = jsonPath;
      console.log(`[conv-md] processing ${path.relative(this.vaultDir, jsonPath)} (remaining=${this.queue.length})`);
      try {
        const r = await summarizeConversation({ jsonPath, obsidianDir: this.obsidianDir });
        if (r.ok) console.log(`[conv-md] ✓ ${r.site}/${r.chatName} → ${r.outputPath} (${r.totalDurationMs}ms)`);
        else      console.log(`[conv-md] skipped ${r.site}/${r.chatName}: ${r.reason}`);
      } catch (err: any) {
        console.error('[conv-md] task failed', err?.message ?? err);
      } finally {
        this.processing = null;
      }
    }
  }
}

function sanitizeForFs(s: string): string {
  let out = s
    .replace(/[\/\\:\*\?"<>\|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 80) out = out.slice(0, 80).trim();
  if (!out) out = 'untitled';
  return out;
}
