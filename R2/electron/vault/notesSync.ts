import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';

type Opts = {
  source: string;      // ~/R2Vault/notes
  dest: string;        // ~/Downloads/R2Obsidian
};

/**
 * One-way mirror from R2Vault/notes → R2Obsidian. Preserves directory layout
 * (same relative paths). Triggers on add/change/delete via chokidar.
 */
export class NotesSync {
  private opts: Opts;
  private watcher: chokidar.FSWatcher | null = null;

  constructor(opts: Opts) {
    this.opts = opts;
  }

  start() {
    fs.mkdirSync(this.opts.source, { recursive: true });
    fs.mkdirSync(this.opts.dest, { recursive: true });

    // 1. Initial sync — walk source, mirror anything missing/stale.
    this.initialSync(this.opts.source);

    // 2. Live watch
    this.watcher = chokidar.watch(this.opts.source, {
      ignored: (p) => {
        const base = path.basename(p);
        return base === '.DS_Store' || base.startsWith('._');
      },
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });

    this.watcher
      .on('add',       (p) => this.copyFile(p))
      .on('change',    (p) => this.copyFile(p))
      .on('unlink',    (p) => this.deleteFile(p))
      .on('addDir',    (p) => this.makeDir(p))
      .on('unlinkDir', (p) => this.removeDir(p))
      .on('error',     (err) => console.error('[notes-sync] watcher error', err));
  }

  stop() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = null;
    }
  }

  // ---------- internals ----------

  private destOf(srcPath: string): string {
    const rel = path.relative(this.opts.source, srcPath);
    return path.join(this.opts.dest, rel);
  }

  private isSkippable(p: string): boolean {
    const base = path.basename(p);
    return base === '.DS_Store' || base.startsWith('._');
  }

  private initialSync(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const src = path.join(dir, entry.name);
      if (this.isSkippable(src)) continue;
      if (entry.isDirectory()) {
        this.makeDir(src);
        this.initialSync(src);
      } else if (entry.isFile()) {
        this.copyFileIfNewer(src);
      }
    }
  }

  private makeDir(srcPath: string) {
    if (this.isSkippable(srcPath)) return;
    const dest = this.destOf(srcPath);
    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch (err) {
      console.error('[notes-sync] mkdir failed', dest, err);
    }
  }

  private copyFile(srcPath: string) {
    if (this.isSkippable(srcPath)) return;
    const dest = this.destOf(srcPath);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      fs.copyFileSync(srcPath, tmp);
      fs.renameSync(tmp, dest);
    } catch (err) {
      console.error('[notes-sync] copy failed', srcPath, '→', dest, err);
    }
  }

  private copyFileIfNewer(srcPath: string) {
    if (this.isSkippable(srcPath)) return;
    const dest = this.destOf(srcPath);
    try {
      const srcStat = fs.statSync(srcPath);
      let copy = true;
      try {
        const destStat = fs.statSync(dest);
        // Same size + dest mtime >= src mtime → skip
        if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
          copy = false;
        }
      } catch { /* dest missing → copy */ }
      if (copy) this.copyFile(srcPath);
    } catch (err) {
      console.error('[notes-sync] stat failed', srcPath, err);
    }
  }

  private deleteFile(srcPath: string) {
    const dest = this.destOf(srcPath);
    try {
      fs.rmSync(dest, { force: true });
    } catch (err) {
      console.error('[notes-sync] delete failed', dest, err);
    }
  }

  private removeDir(srcPath: string) {
    const dest = this.destOf(srcPath);
    try {
      // Only remove if empty — avoid clobbering user-added files in mirror.
      const entries = fs.readdirSync(dest);
      if (entries.length === 0) {
        fs.rmdirSync(dest);
      }
    } catch { /* dest missing or not empty */ }
  }
}
