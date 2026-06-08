import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import type Database from 'better-sqlite3';
import { embed, LlmError } from '../llm/ollama';
import { readLlmConfigSafe } from '../config/store';

/**
 * Embedding index for the user's Obsidian vault.
 *
 * Watches every .md under R2Obsidian/ (minus excluded private subfolders),
 * embeds the title + the first ~500 tokens of body via Ollama, and stores the
 * resulting float32 vector in SQLite. The graph linker queries this table to
 * find related notes when a new chat summary lands.
 *
 * Storage:
 *   note_embeddings(
 *     path TEXT PRIMARY KEY,   -- absolute path on disk
 *     mtime INTEGER NOT NULL,  -- file mtime in ms; re-embed only on change
 *     title TEXT NOT NULL,     -- display title (filename without .md)
 *     embedding BLOB NOT NULL, -- Float32Array buffer
 *     dim INTEGER NOT NULL,    -- vector dimensionality
 *     model TEXT NOT NULL,     -- embedding model used (for re-index on swap)
 *     updated_at INTEGER NOT NULL
 *   )
 */

export type IndexedNote = {
  path: string;
  title: string;
  embedding: Float32Array;
};

// Folders that are part of the user's vault but should NEVER show up as
// "related" suggestions — they're either private or noisy.
const EXCLUDED_SUBDIRS = ['forms', 'persona/snapshots', 'media'];

// Max characters of body text we embed. nomic-embed-text accepts ~8k tokens;
// 1500 chars covers the head of most notes without burning latency.
const EMBED_CHAR_BUDGET = 1500;

export class EmbeddingIndex {
  private db: Database.Database;
  private obsidianDir: string;
  private watcher: chokidar.FSWatcher | null = null;
  private pending = new Set<string>();
  private draining = false;

  constructor(db: Database.Database, obsidianDir: string) {
    this.db = db;
    this.obsidianDir = obsidianDir;
    this.ensureSchema();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_embeddings (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        title TEXT NOT NULL,
        embedding BLOB NOT NULL,
        dim INTEGER NOT NULL,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_note_embeddings_model
        ON note_embeddings(model);
    `);
  }

  /** Start watching the vault for adds/changes/deletes. */
  start() {
    if (this.watcher) return;
    if (!fs.existsSync(this.obsidianDir)) {
      // Vault folder may not exist yet on a fresh install. Skip — the regular
      // vault setup will create it; we re-call start() once it does.
      return;
    }
    this.watcher = chokidar.watch(`${this.obsidianDir}/**/*.md`, {
      ignoreInitial: false,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    this.watcher
      .on('add',    (p) => this.enqueue(p))
      .on('change', (p) => this.enqueue(p))
      .on('unlink', (p) => this.removeFromIndex(p))
      .on('error',  (err) => console.error('[embed-index] watch error', err));
  }

  stop() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* */ }
      this.watcher = null;
    }
  }

  private enqueue(absPath: string) {
    if (this.isExcluded(absPath)) return;
    this.pending.add(absPath);
    void this.drain();
  }

  private isExcluded(absPath: string): boolean {
    const rel = path.relative(this.obsidianDir, absPath).replace(/\\/g, '/');
    return EXCLUDED_SUBDIRS.some(
      (sub) => rel === sub || rel.startsWith(sub + '/')
    );
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.size > 0) {
        const next = this.pending.values().next().value as string;
        this.pending.delete(next);
        await this.indexOne(next).catch((err) => {
          // Non-fatal — log and move on. Common case: embed model not pulled.
          if (err instanceof LlmError && err.kind === 'missing_model') {
            // Suppress noise: this fires once per file until user pulls model.
            // Stop draining; the linker will fall back to keyword mode anyway.
            this.pending.clear();
          } else {
            console.warn(`[embed-index] index failed for ${path.basename(next)}: ${err?.message ?? err}`);
          }
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async indexOne(absPath: string) {
    const cfg = readLlmConfigSafe();
    const model = cfg.embedModel;
    if (!model) return; // embedding disabled by user

    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); }
    catch { return; }

    const mtime = Math.floor(stat.mtimeMs);
    const existing = this.db
      .prepare(`SELECT mtime, model FROM note_embeddings WHERE path = ?`)
      .get(absPath) as { mtime: number; model: string } | undefined;
    if (existing && existing.mtime === mtime && existing.model === model) {
      return; // already indexed at this version, with this model
    }

    const text = readNoteForEmbedding(absPath);
    if (!text) return;
    const title = path.basename(absPath, '.md');

    const vec = await embed({ model, input: `${title}\n\n${text}`, baseUrl: cfg.baseUrl });
    this.db
      .prepare(
        `INSERT INTO note_embeddings (path, mtime, title, embedding, dim, model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           mtime = excluded.mtime,
           title = excluded.title,
           embedding = excluded.embedding,
           dim = excluded.dim,
           model = excluded.model,
           updated_at = excluded.updated_at`
      )
      .run(absPath, mtime, title, Buffer.from(vec.buffer), vec.length, model, Date.now());
  }

  private removeFromIndex(absPath: string) {
    try { this.db.prepare(`DELETE FROM note_embeddings WHERE path = ?`).run(absPath); }
    catch { /* */ }
  }

  /**
   * Return the top-K notes most similar to `queryVec`, excluding any paths in
   * `excludePaths`. Uses linear cosine — fine up to ~5k notes.
   */
  topK(queryVec: Float32Array, opts: {
    k: number;
    threshold: number;
    excludePaths?: Set<string>;
    model: string;
  }): Array<{ path: string; title: string; score: number }> {
    const rows = this.db
      .prepare(
        `SELECT path, title, embedding, dim FROM note_embeddings WHERE model = ? AND dim = ?`
      )
      .all(opts.model, queryVec.length) as Array<{
        path: string;
        title: string;
        embedding: Buffer;
        dim: number;
      }>;
    const out: Array<{ path: string; title: string; score: number }> = [];
    const qNorm = norm(queryVec);
    if (qNorm === 0) return [];
    for (const row of rows) {
      if (opts.excludePaths?.has(row.path)) continue;
      const v = bufferToFloat32(row.embedding, row.dim);
      const score = cosine(queryVec, v, qNorm);
      if (score >= opts.threshold) {
        out.push({ path: row.path, title: row.title, score });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.k);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM note_embeddings`).get() as { n: number }).n;
  }
}

// ---------- helpers ----------

function readNoteForEmbedding(absPath: string): string {
  let raw: string;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch { return ''; }
  // Strip YAML frontmatter
  let body = raw;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end > 0) body = body.slice(end + 4);
  }
  // Strip wiki/markdown link syntax — keep visible text
  body = body
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => (b || a))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (body.length > EMBED_CHAR_BUDGET) body = body.slice(0, EMBED_CHAR_BUDGET);
  return body;
}

function bufferToFloat32(buf: Buffer, dim: number): Float32Array {
  // SQLite stores Buffer; need a tight Float32Array view at the right offset.
  return new Float32Array(buf.buffer, buf.byteOffset, dim);
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}

function cosine(a: Float32Array, b: Float32Array, aNorm: number): number {
  let dot = 0;
  let bMag = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    bMag += b[i] * b[i];
  }
  const denom = aNorm * Math.sqrt(bMag);
  return denom === 0 ? 0 : dot / denom;
}
