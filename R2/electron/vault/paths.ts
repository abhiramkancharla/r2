import * as os from 'os';
import * as path from 'path';

export type VaultPaths = {
  home: string;
  downloads: string;
  r2Vault: string;          // raw data: sessions, messages, db, etc.
  r2Obsidian: string;       // human-readable Obsidian vault
  obsidianDaily: string;    // daily notes destination
  obsidianProjects: string; // project notes (empty by default)
};

export function vaultPaths(homeOverride?: string): VaultPaths {
  const home = homeOverride ?? os.homedir();
  const downloads = path.join(home, 'Downloads');
  const r2Vault = path.join(home, 'R2Vault');
  const r2Obsidian = path.join(downloads, 'R2Obsidian');
  return {
    home,
    downloads,
    r2Vault,
    r2Obsidian,
    obsidianDaily: path.join(r2Obsidian, 'Daily'),
    obsidianProjects: path.join(r2Obsidian, 'Projects')
  };
}
