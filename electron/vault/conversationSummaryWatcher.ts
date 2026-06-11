import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar from 'chokidar';
import { summarizeConversation } from '../llm/conversationSummary';
import type { EmbeddingIndex } from './embeddingIndex';
import { linkChatToVault } from './graphLinker';

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
  // jsonPath → mdPath last written from it. Lets us delete the orphan
  // markdown when ConversationStore renames `_unnamed-*.json` to
  // `<chatName>.json` (the chokidar `unlink` event reports the old
  // path, which we look up here).
  private jsonToMd = new Map<string, string>();

  private embedIndex: EmbeddingIndex | null = null;

  constructor(vaultDir: string, obsidianDir?: string) {
    this.vaultDir = vaultDir;
    this.obsidianDir = obsidianDir ?? path.join(os.homedir(), 'Downloads', 'R2Obsidian');
    this.convDir = path.join(vaultDir, 'conversations');
  }

  /** Optionally attach an embedding index so new summaries auto-link to
   *  related notes via cosine similarity. If null, the linker falls back to
   *  keyword overlap. */
  setEmbeddingIndex(idx: EmbeddingIndex | null) {
    this.embedIndex = idx;
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
      .on('unlink', (p) => this.onUnlink(p))
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
   * Boot-time orphan sweep. Deletes any `_unnamed-*.md` files in the
   * Obsidian conversations tree that don't have a matching
   * `_unnamed-*.json` source. These accumulated under the old behaviour
   * where summarizeConversation would write a markdown even when the
   * chat name hadn't resolved yet. With Phase 1 in place no new ones
   * are created — this clears the historical mess.
   */
  sweepOrphanUnnamedMd() {
    const root = path.join(this.obsidianDir, 'conversations');
    let removed = 0;
    let sites: string[] = [];
    try { sites = fs.readdirSync(root); } catch { return; }
    for (const site of sites) {
      const siteDir = path.join(root, site);
      let entries: string[] = [];
      try { entries = fs.readdirSync(siteDir); } catch { continue; }
      for (const f of entries) {
        if (!f.startsWith('_unnamed-') || !f.endsWith('.md')) continue;
        const mdPath = path.join(siteDir, f);
        const jsonName = f.slice(0, -3) + '.json';
        const jsonPath = path.join(this.convDir, site, jsonName);
        // Only delete the markdown if the JSON it came from is gone.
        // Keeps in-progress unnamed JSONs (rare with Phase 1) covered.
        if (!fs.existsSync(jsonPath)) {
          try { fs.rmSync(mdPath, { force: true }); removed += 1; }
          catch { /* */ }
        }
      }
    }
    if (removed > 0) console.log(`[conv-md] swept ${removed} orphan _unnamed-*.md`);
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

  /**
   * Conversation JSON was deleted (typical case: ConversationStore renamed
   * `_unnamed-*.json` to `<chatName>.json` once the chat name finally
   * resolved). The markdown summary we wrote from the old path is now an
   * orphan — delete it so the user only sees the correctly-named file.
   * The new path will fire `add` separately and a fresh summary lands.
   */
  private onUnlink(jsonPath: string) {
    const md = this.jsonToMd.get(jsonPath);
    if (!md) return;
    this.jsonToMd.delete(jsonPath);
    try {
      if (fs.existsSync(md)) {
        fs.rmSync(md, { force: true });
        console.log(`[conv-md] cleaned orphan ${path.relative(this.obsidianDir, md)}`);
      }
    } catch (err: any) {
      console.warn(`[conv-md] orphan cleanup failed for ${md}: ${err?.message ?? err}`);
    }
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
        if (r.ok) {
          console.log(`[conv-md] ✓ ${r.site}/${r.chatName} → ${r.outputPath} (${r.totalDurationMs}ms)`);
          // Remember the json → md mapping so onUnlink can clean it up
          // if/when ConversationStore renames the JSON.
          this.jsonToMd.set(jsonPath, r.outputPath);
          // Fire-and-forget: append "## Related" wiki-links to the new summary.
          // Failures here MUST NOT block summary generation.
          linkChatToVault({
            chatMdPath: r.outputPath,
            obsidianDir: this.obsidianDir,
            index: this.embedIndex
          })
            .then((lr) => {
              if (lr.ok && lr.links.length > 0) {
                console.log(
                  `[graph-link] ${r.site}/${r.chatName} ← ${lr.links.length} links (${lr.mode})`
                );
              }
            })
            .catch((err) => console.warn('[graph-link] failed', err?.message ?? err));
        } else {
          console.log(`[conv-md] skipped ${r.site}/${r.chatName}: ${r.reason}`);
        }
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
