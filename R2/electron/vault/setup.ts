import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import { vaultPaths, type VaultPaths } from './paths';

export type RequiredFolder = {
  key: 'r2Vault' | 'r2Obsidian' | 'obsidianDaily' | 'obsidianProjects';
  label: string;
  path: string;
  exists: boolean;
};

export type VaultStatus = {
  folders: RequiredFolder[];
  allReady: boolean;
};

// Full directory template R2 expects. Top-level structures are surfaced to
// the user; nested folders are created silently and populate as data flows.
const VAULT_TEMPLATE = [
  // ~/R2Vault
  'sessions',
  'conversations',
  'messages',
  'media_raw',
  'notes',
  'notes/projects',
  'notes/forms',
  'notes/persona',
  'notes/persona/snapshots',
  'notes/persona/weekly',
  'notes/diary'
];

const OBSIDIAN_TEMPLATE = [
  // ~/Downloads/R2Obsidian
  'Daily',
  'Projects',
  'conversations',
  'forms',
  'persona',
  'media',
  'messages_raw'
];

function dirExists(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function getStatus(paths: VaultPaths = vaultPaths()): VaultStatus {
  const folders: RequiredFolder[] = [
    { key: 'r2Vault',          label: 'R2Vault',                            path: paths.r2Vault,          exists: dirExists(paths.r2Vault) },
    { key: 'r2Obsidian',       label: 'R2Obsidian',                         path: paths.r2Obsidian,       exists: dirExists(paths.r2Obsidian) },
    { key: 'obsidianDaily',    label: 'R2Obsidian / Daily',                 path: paths.obsidianDaily,    exists: dirExists(paths.obsidianDaily) },
    { key: 'obsidianProjects', label: 'R2Obsidian / Projects',              path: paths.obsidianProjects, exists: dirExists(paths.obsidianProjects) }
  ];
  return { folders, allReady: folders.every((f) => f.exists) };
}

/**
 * Create the full vault directory structure. Idempotent — mkdir -p semantics.
 * Returns the post-creation status so callers can confirm.
 */
export function setupAll(paths: VaultPaths = vaultPaths()): VaultStatus {
  fs.mkdirSync(paths.r2Vault, { recursive: true });
  fs.mkdirSync(paths.r2Obsidian, { recursive: true });
  for (const sub of VAULT_TEMPLATE) {
    fs.mkdirSync(path.join(paths.r2Vault, sub), { recursive: true });
  }
  for (const sub of OBSIDIAN_TEMPLATE) {
    fs.mkdirSync(path.join(paths.r2Obsidian, sub), { recursive: true });
  }
  return getStatus(paths);
}

/**
 * Watches the parent dirs for the required folders so we can detect when the
 * user creates them manually in Finder. Emits 'change' with fresh VaultStatus.
 */
export class VaultWatcher extends EventEmitter {
  private watchers: chokidar.FSWatcher[] = [];
  private paths: VaultPaths;
  private lastReady = false;

  constructor(paths: VaultPaths = vaultPaths()) {
    super();
    this.paths = paths;
  }

  start() {
    const opts: chokidar.WatchOptions = {
      ignoreInitial: true,
      depth: 2,
      persistent: true,
      ignorePermissionErrors: true
    };
    const w1 = chokidar.watch(this.paths.home, { ...opts, depth: 1 });
    const w2 = chokidar.watch(this.paths.downloads, opts);
    const onAny = () => this.emitIfChanged();
    w1.on('addDir', onAny).on('unlinkDir', onAny);
    w2.on('addDir', onAny).on('unlinkDir', onAny);
    this.watchers.push(w1, w2);
    this.lastReady = getStatus(this.paths).allReady;
  }

  stop() {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* noop */ }
    }
    this.watchers = [];
  }

  private emitIfChanged() {
    const status = getStatus(this.paths);
    this.emit('change', status);
    this.lastReady = status.allReady;
  }
}
