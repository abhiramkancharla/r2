import * as path from 'path';
import chokidar from 'chokidar';
import { transcribeMediaJson } from '../llm/mediaTranscribe';

const DEBOUNCE_MS = 10 * 60_000; // 10 minutes after the FIRST change for a file

/**
 * Watches ~/R2Vault/media_raw/<site>/<date>.json and transcribes each into
 * an Obsidian markdown at ~/R2Vault/notes/media/<site>/<date>.md.
 *
 * Debouncing model (per user spec):
 *   - On the FIRST change to a file, start a 10-minute timer.
 *   - Subsequent changes during that 10-minute window do NOT extend the
 *     timer. The transcription fires exactly 10 minutes after the FIRST
 *     change, using the file's CURRENT contents.
 *   - After the timer fires, the file is unlocked. The next change starts
 *     a new 10-minute timer.
 *
 * Concurrency:
 *   - Transcriptions are queued; one at a time. The actual serialization
 *     happens inside ollama.ts (single mutex), but we keep a local FIFO so
 *     the terminal status (queue depth, current file) stays accurate.
 */
export class MediaTranscribeWatcher {
  private vaultDir: string;
  private mediaRawDir: string;
  private watcher: chokidar.FSWatcher | null = null;

  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private queue: string[] = [];
  private processing: string | null = null;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
    this.mediaRawDir = path.join(vaultDir, 'media_raw');
  }

  start() {
    this.watcher = chokidar.watch(`${this.mediaRawDir}/**/*.json`, {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    });
    this.watcher
      .on('add',    (p) => this.onChange(p))
      .on('change', (p) => this.onChange(p))
      .on('error',  (err) => console.error('[media-md] watch error', err));
  }

  stop() {
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    this.queue = [];
    this.processing = null;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = null;
    }
  }

  private onChange(jsonPath: string) {
    if (!jsonPath.endsWith('.json')) return;
    if (path.basename(jsonPath).startsWith('.')) return;
    // If a timer is already pending for this file, ignore — first change wins.
    if (this.pendingTimers.has(jsonPath)) return;
    if (this.processing === jsonPath) return;
    if (this.queue.includes(jsonPath)) return;

    const rel = path.relative(this.vaultDir, jsonPath);
    console.log(`[media-md] queued in ${Math.round(DEBOUNCE_MS / 60000)}m: ${rel}`);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(jsonPath);
      this.enqueue(jsonPath);
    }, DEBOUNCE_MS);
    this.pendingTimers.set(jsonPath, timer);
  }

  private enqueue(jsonPath: string) {
    if (this.queue.includes(jsonPath) || this.processing === jsonPath) return;
    this.queue.push(jsonPath);
    this.logQueue('enqueued', jsonPath);
    void this.drain();
  }

  private async drain() {
    if (this.processing) return;
    while (this.queue.length) {
      const jsonPath = this.queue.shift()!;
      this.processing = jsonPath;
      this.logQueue('processing', jsonPath);
      try {
        const result = await transcribeMediaJson({ vaultDir: this.vaultDir, jsonPath });
        if (result.ok) {
          console.log(`[media-md] ✓ ${result.site}/${result.date} → ${result.outputPath} (${result.events} events, ${result.totalDurationMs}ms)`);
        } else {
          console.log(`[media-md] skip ${result.site}/${result.date}: ${result.reason}`);
        }
      } catch (err: any) {
        console.error(`[media-md] failed: ${err?.message ?? err}`);
      } finally {
        this.processing = null;
      }
    }
    this.logQueue('idle', null);
  }

  private logQueue(stage: string, jsonPath: string | null) {
    const rel = jsonPath ? path.relative(this.vaultDir, jsonPath) : '-';
    console.log(`[media-md] queue: stage=${stage} current=${rel} pending=${this.queue.length}`);
  }
}
