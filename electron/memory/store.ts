import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { ActivitySnapshot } from '../tracker/activity';

export type MemoryRow = {
  id: number;
  ts: number;
  app: string | null;
  title: string | null;
  url: string | null;
  idle_seconds: number;
};

export class MemoryStore {
  private db!: Database.Database;
  private vaultDir: string;
  private dbPath: string;

  constructor(dbPath: string, vaultDir: string) {
    this.dbPath = dbPath;
    this.vaultDir = vaultDir;
  }

  /** Escape hatch for modules that need to declare/access additional tables
   *  on the same SQLite handle (e.g. the embedding index). Returns the
   *  initialized better-sqlite3 instance. Throws if `init()` hasn't run. */
  rawDb(): Database.Database {
    if (!this.db) throw new Error('MemoryStore.rawDb called before init()');
    return this.db;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(this.vaultDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT,
        title TEXT,
        url TEXT,
        idle_seconds INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
      CREATE INDEX IF NOT EXISTS idx_activity_app ON activity(app);

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        app TEXT NOT NULL,
        bundle_id TEXT,
        window TEXT,
        text TEXT NOT NULL,
        redacted_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_messages_app ON messages(app);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content='messages',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;
    `);
  }

  recordMessage(m: { ts: number; app: string; bundleId: string; window: string; text: string; redacted: string[] }) {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO messages (ts, app, bundle_id, window, text, redacted_json) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(m.ts, m.app, m.bundleId, m.window, m.text, JSON.stringify(m.redacted ?? []));
    this.appendVaultDaily(m);
  }

  searchMessages(q: string, limit = 50) {
    return this.db.prepare(
      `SELECT m.* FROM messages m
       JOIN messages_fts f ON f.rowid = m.id
       WHERE messages_fts MATCH ?
       ORDER BY m.ts DESC LIMIT ?`
    ).all(q, limit);
  }

  recentMessages(limit = 50) {
    return this.db.prepare(
      `SELECT * FROM messages ORDER BY ts DESC LIMIT ?`
    ).all(limit);
  }

  private appendVaultDaily(m: { ts: number; app: string; window: string; text: string }) {
    const date = new Date(m.ts);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dir = path.join(this.vaultDir, 'messages');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${yyyy}-${mm}-${dd}.md`);
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const line = `\n### ${hh}:${mi} — ${m.app}${m.window ? ` — ${m.window}` : ''}\n${m.text}\n`;
    fs.appendFileSync(file, line, 'utf8');
  }

  recordActivity(snap: ActivitySnapshot) {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO activity (ts, app, title, url, idle_seconds) VALUES (?, ?, ?, ?, ?)`
    ).run(snap.ts, snap.app, snap.title, snap.url, snap.idleSeconds);
  }

  recent(limit = 20): MemoryRow[] {
    return this.db.prepare(
      `SELECT * FROM activity ORDER BY ts DESC LIMIT ?`
    ).all(limit) as MemoryRow[];
  }

  search(q: string): MemoryRow[] {
    const like = `%${q}%`;
    return this.db.prepare(
      `SELECT * FROM activity WHERE app LIKE ? OR title LIKE ? OR url LIKE ? ORDER BY ts DESC LIMIT 50`
    ).all(like, like, like) as MemoryRow[];
  }

  appUsageSince(sinceMs: number): { app: string; samples: number }[] {
    return this.db.prepare(
      `SELECT app, COUNT(*) as samples FROM activity
       WHERE ts >= ? AND app IS NOT NULL
       GROUP BY app ORDER BY samples DESC`
    ).all(sinceMs) as { app: string; samples: number }[];
  }

  close() {
    this.db?.close();
  }
}
