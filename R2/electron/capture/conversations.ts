import * as fs from 'fs';
import * as path from 'path';
import { redact } from './redaction';

export type AiTurn = {
  ts: number;
  app: string;
  bundleId: string;
  window: string;
  site: string;
  chatName: string;
  url: string;
  userText: string;
  assistantText: string;
  userRedacted: string[];
  assistantRedacted: string[];
};

type ConversationFile = {
  site: string;
  chatName: string;            // empty while still unnamed
  chatId: string;              // URL-derived stable id; survives chat rename + cross-surface (browser vs app)
  startedAt: number;           // first turn ts
  updatedAt: number;
  turns: AiTurn[];
};

const UNNAMED_TTL_MS = 30 * 60_000; // window to retroactively rename

/**
 * Append-only store of AI turns, grouped by chat (not by date).
 *
 * File layout:
 *   ~/R2Vault/conversations/<site>/<chatName>.json   ← once chatName known
 *   ~/R2Vault/conversations/<site>/_unnamed-<YYYY-MM-DD>-<HHMM>-<seq>.json
 *
 * When a turn arrives WITH a real chatName, we try to attach it to the most
 * recently-active unnamed file in the same site (within UNNAMED_TTL_MS) by
 * renaming + updating header. Subsequent turns just append.
 */
export class ConversationStore {
  private dir: string;
  // (site) → most recent unnamed file path + last-used ts.
  private recentUnnamed: Map<string, { file: string; lastTs: number }> = new Map();
  // (site|chatName) → cached path so repeat lookups are O(1).
  private nameToFile: Map<string, string> = new Map();
  private unnamedSeq = 0;

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, 'conversations');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  recordTurn(t: AiTurn) {
    const site = t.site || 'unknown';
    const siteDir = path.join(this.dir, site);
    fs.mkdirSync(siteDir, { recursive: true });

    const chatName = sanitizeFilename(t.chatName ?? '');
    const chatId = extractChatId(t.url ?? '');  // claude.ai/chat/<id>, chatgpt.com/c/<id>, etc.

    // -------- Identity rules (in priority order) --------
    // 1) If we know chatId, that's the stable identity across browser + app.
    //    File preferred name: <chatName>.json if known, else _id-<chatId>.json.
    //    If both exist (file by id from earlier turn, file by name from another),
    //    we'll merge id-file into the named file.
    // 2) If only chatName known, use <chatName>.json (existing behavior).
    // 3) If neither: fall back to _unnamed-<stamp>-<seq>.json.

    let file: string;

    if (chatId) {
      const idPath = path.join(siteDir, `_id-${chatId}.json`);
      const namedPath = chatName ? path.join(siteDir, `${chatName}.json`) : '';

      if (namedPath && fs.existsSync(namedPath)) {
        // Named file already exists. If an id-file also exists for this chat,
        // merge it in and delete it. Future turns just append to named.
        if (fs.existsSync(idPath)) {
          const target = this.readSafe(namedPath) ?? this.makeShell(site, chatName, chatId, t.ts);
          const orphan = this.readSafe(idPath);
          if (orphan?.turns) target.turns.push(...orphan.turns);
          target.turns.sort((a, b) => a.ts - b.ts);
          if (!target.chatId) target.chatId = chatId;
          this.writeAtomic(namedPath, this.refresh(target, t.ts, chatName));
          fs.rmSync(idPath, { force: true });
        }
        file = namedPath;
      } else if (namedPath && fs.existsSync(idPath)) {
        // We know a name now and an id-file exists — rename to named.
        fs.renameSync(idPath, namedPath);
        file = namedPath;
      } else if (namedPath) {
        // Fresh named file.
        file = namedPath;
      } else {
        // Only id known.
        file = idPath;
      }

      // Also fold in any recent unnamed file (legacy placeholder fallback).
      const recent = this.recentUnnamed.get(site);
      if (recent && Date.now() - recent.lastTs <= UNNAMED_TTL_MS && fs.existsSync(recent.file)) {
        if (recent.file !== file) {
          const target = this.readSafe(file) ?? this.makeShell(site, chatName, chatId, t.ts);
          const orphan = this.readSafe(recent.file);
          if (orphan?.turns) target.turns.push(...orphan.turns);
          target.turns.sort((a, b) => a.ts - b.ts);
          this.writeAtomic(file, this.refresh(target, t.ts, target.chatName));
          fs.rmSync(recent.file, { force: true });
          this.recentUnnamed.delete(site);
        }
      }
    } else if (chatName) {
      // Legacy path: chatName known, no chatId. Same as before.
      const namedPath = path.join(siteDir, `${chatName}.json`);
      const recent = this.recentUnnamed.get(site);
      if (recent && Date.now() - recent.lastTs <= UNNAMED_TTL_MS && fs.existsSync(recent.file)) {
        if (!fs.existsSync(namedPath)) {
          fs.renameSync(recent.file, namedPath);
        } else {
          const target = this.readSafe(namedPath) ?? this.makeShell(site, chatName, '', t.ts);
          const orphan = this.readSafe(recent.file);
          if (orphan?.turns) target.turns.push(...orphan.turns);
          target.turns.sort((a, b) => a.ts - b.ts);
          this.writeAtomic(namedPath, this.refresh(target, t.ts, chatName));
          fs.rmSync(recent.file, { force: true });
        }
        this.recentUnnamed.delete(site);
      }
      file = namedPath;
      this.nameToFile.set(`${site}|${chatName}`, file);
    } else {
      // No name, no id. Use legacy _unnamed-* placeholder.
      const recent = this.recentUnnamed.get(site);
      if (recent && Date.now() - recent.lastTs <= UNNAMED_TTL_MS && fs.existsSync(recent.file)) {
        file = recent.file;
      } else {
        const stamp = stampNow();
        this.unnamedSeq += 1;
        file = path.join(siteDir, `_unnamed-${stamp}-${this.unnamedSeq}.json`);
      }
      this.recentUnnamed.set(site, { file, lastTs: t.ts });
    }

    const log = this.readSafe(file) ?? this.makeShell(site, chatName, chatId, t.ts);
    if (!log.chatName && chatName) log.chatName = chatName;
    if (!log.chatId && chatId) log.chatId = chatId;
    log.turns.push(t);
    log.turns.sort((a, b) => a.ts - b.ts);
    this.writeAtomic(file, this.refresh(log, t.ts, log.chatName));
  }

  // -------- internals --------

  private makeShell(site: string, chatName: string, chatId: string, ts: number): ConversationFile {
    return { site, chatName, chatId, startedAt: ts, updatedAt: ts, turns: [] };
  }

  private refresh(log: ConversationFile, ts: number, chatName: string): ConversationFile {
    log.updatedAt = ts;
    if (chatName && !log.chatName) log.chatName = chatName;
    return log;
  }

  private readSafe(file: string): ConversationFile | null {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      if (!Array.isArray(obj.turns)) obj.turns = [];
      return obj as ConversationFile;
    } catch {
      return null;
    }
  }

  private writeAtomic(file: string, log: ConversationFile) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
}

/** Apply redaction to both sides of an AI turn before persisting. */
export function sanitizeAiTurn(raw: {
  ts: number;
  app: string;
  bundleId: string;
  window: string;
  site: string;
  chatName?: string;
  url?: string;
  userText: string;
  assistantText: string;
}): AiTurn {
  const u = redact(raw.userText ?? '');
  const a = redact(raw.assistantText ?? '');
  return {
    ts: Number(raw.ts) || Date.now(),
    app: String(raw.app ?? ''),
    bundleId: String(raw.bundleId ?? ''),
    window: String(raw.window ?? ''),
    site: String(raw.site ?? 'unknown'),
    chatName: String(raw.chatName ?? ''),
    url: String(raw.url ?? ''),
    userText: u.text,
    assistantText: a.text,
    userRedacted: u.redacted,
    assistantRedacted: a.redacted
  };
}

/**
 * Extract the canonical chat id from a known AI chat URL. Same id across
 * the web app and the desktop app, so this is what we use as identity.
 *
 *   claude.ai/chat/<uuid>
 *   chatgpt.com/c/<id>           (also chat.openai.com)
 *   gemini.google.com/app/<id>
 *   perplexity.ai/search/<slug>
 */
function extractChatId(url: string): string {
  if (!url) return '';
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (host.endsWith('claude.ai')) {
    const m = path.match(/^\/chat\/([^/]+)/);
    if (m) return m[1];
  }
  if (host.endsWith('chatgpt.com') || host.endsWith('chat.openai.com')) {
    const m = path.match(/^\/c\/([^/]+)/);
    if (m) return m[1];
  }
  if (host.endsWith('gemini.google.com')) {
    const m = path.match(/^\/app\/([^/]+)/);
    if (m) return m[1];
  }
  if (host.endsWith('perplexity.ai')) {
    const m = path.match(/^\/search\/([^/]+)/);
    if (m) return m[1];
  }
  return '';
}

function stampNow(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${dd}-${hh}${mi}`;
}

// Strip filesystem-hostile chars, cap length. Empty result allowed.
function sanitizeFilename(s: string): string {
  if (!s) return '';
  let out = s
    .replace(/[\/\\\:\*\?"<>\|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 80) out = out.slice(0, 80).trim();
  return out;
}
