import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chatWithFallback } from './ollama';
import { PROMPTS } from './prompts';

// =============================================================================
// Weekly snapshot
// =============================================================================

export type WeeklyResult =
  | { ok: true; outputPath: string; weekLabel: string; rangeStart: string; rangeEnd: string; totalDurationMs: number; payloadChars: number }
  | { ok: false; reason: string; weekLabel?: string };

type WeeklyOpts = {
  vaultDir: string;            // ~/R2Vault
  obsidianDir?: string;        // defaults to ~/Downloads/R2Obsidian
  rangeEnd?: Date;             // defaults to now; used for retro-generation
  rangeStart?: Date;           // defaults to rangeEnd - 7d; data-driven runs pass this
  outputLabel?: string;        // optional override (e.g. "2026-05-28-1432") for snapshot filename
};

const MS_PER_DAY = 86_400_000;

export async function generateWeeklySnapshot(opts: WeeklyOpts): Promise<WeeklyResult> {
  const vaultDir = opts.vaultDir;
  const obsidianDir = opts.obsidianDir ?? path.join(os.homedir(), 'Downloads', 'R2Obsidian');
  const end = opts.rangeEnd ?? new Date();
  const start = opts.rangeStart ?? new Date(end.getTime() - 7 * MS_PER_DAY);
  const startStr = ymd(start);
  const endStr = ymd(end);
  const weekLabel = opts.outputLabel ?? isoWeekLabel(end); // YYYY-Www OR snapshot stamp

  // 1) Diaries
  const diaries = readDiaries(obsidianDir, start, end);

  // 2) Conversations — every file modified in window
  const conversations = readRecentConversations(vaultDir, start, end);

  // 3) Messages — daily markdowns
  const messages = readMessages(vaultDir, start, end);

  // 4) Media — pre-aggregated
  const mediaThemes = readMediaThemes(vaultDir, start, end);

  // 5) Projects — list with first line
  const projects = listProjects(vaultDir);

  const payload = buildWeeklyPayload({ weekLabel, startStr, endStr, diaries, conversations, messages, mediaThemes, projects });
  const payloadChars = payload.length;

  // Honest skip when there's basically nothing to look at
  const totalSignal =
    diaries.length + conversations.length + messages.length + Object.keys(mediaThemes).length;
  if (totalSignal === 0) {
    return { ok: false, weekLabel, reason: 'no_signal' };
  }

  const prompt = PROMPTS.personaWeekly;
  const resp = await chatWithFallback({
    system: prompt.system,
    user: payload,
    temperature: prompt.temperature,
    numCtx: prompt.numCtx,
    numPredict: prompt.numPredict,
    keepAlive: '30m',
    label: `persona:weekly:${weekLabel}`
  });

  let text = stripFences(resp.content).trim();
  if (!text || text.length < 80) {
    return { ok: false, weekLabel, reason: 'output_too_short' };
  }

  // Data-driven runs write to /snapshots; legacy weekly runs still write to /weekly.
  const subDir = opts.outputLabel ? 'snapshots' : 'weekly';
  const outDir = path.join(vaultDir, 'notes', 'persona', subDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${weekLabel}.md`);
  atomicWrite(outPath, text + '\n');

  return {
    ok: true,
    outputPath: outPath,
    weekLabel,
    rangeStart: startStr,
    rangeEnd: endStr,
    totalDurationMs: resp.totalDurationMs,
    payloadChars
  };
}

// Run weekly catch-up: for every Friday at-or-before today that doesn't have
// a snapshot file, generate it. Limited to past 12 weeks to bound work.
export async function catchUpMissingWeeklies(opts: { vaultDir: string; obsidianDir?: string }): Promise<WeeklyResult[]> {
  const vaultDir = opts.vaultDir;
  const obsidianDir = opts.obsidianDir;
  const results: WeeklyResult[] = [];

  const outDir = path.join(vaultDir, 'notes', 'persona', 'weekly');
  fs.mkdirSync(outDir, { recursive: true });

  const fridays = lastNFridays(12); // past 12 weekly slots (oldest first)
  const pending: { date: Date; label: string }[] = [];
  for (const fri of fridays) {
    const label = isoWeekLabel(fri);
    const file = path.join(outDir, `${label}.md`);
    if (!fs.existsSync(file)) pending.push({ date: fri, label });
  }
  if (pending.length === 0) return results;

  banner([
    '🪞  PERSONA WEEKLY CATCHUP',
    `generating ${pending.length} missing weekly snapshot${pending.length === 1 ? '' : 's'}: ${pending.map(p => p.label).join(', ')}`,
    'this may take a couple minutes each — do not quit'
  ]);

  for (const { date, label } of pending) {
    banner([`✨  GENERATING WEEKLY — ${label}`]);
    try {
      const r = await generateWeeklySnapshot({ vaultDir, obsidianDir, rangeEnd: date });
      if (r.ok) banner([`✅  WEEKLY GENERATED — ${label}`, r.outputPath]);
      else banner([`⚠️  WEEKLY SKIPPED — ${label}`, r.reason]);
      results.push(r);
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      banner([`❌  WEEKLY FAILED — ${label}`, reason]);
      results.push({ ok: false, reason, weekLabel: label });
    }
  }
  return results;
}

// =============================================================================
// Monthly profile merge
// =============================================================================

export type MergeResult =
  | { ok: true; outputPath: string; weekliesUsed: number; totalDurationMs: number }
  | { ok: false; reason: string };

type MergeOpts = {
  vaultDir: string;
  weeksWindow?: number;   // how many recent weeklies to feed; default 4
};

export async function mergeMonthlyProfile(opts: MergeOpts): Promise<MergeResult> {
  const vaultDir = opts.vaultDir;
  const window = opts.weeksWindow ?? 4;

  const personaDir = path.join(vaultDir, 'notes', 'persona');
  const weeklyDir = path.join(personaDir, 'weekly');
  const snapshotDir = path.join(personaDir, 'snapshots');
  fs.mkdirSync(personaDir, { recursive: true });

  // Pull from both /snapshots (data-driven, dated) and /weekly (legacy ISO-week).
  // Snapshots are dated YYYY-MM-DD-HHMM; weekly are YYYY-Www.
  const all: { label: string; mtime: number; dir: string }[] = [];
  for (const dir of [snapshotDir, weeklyDir]) {
    try {
      const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const name of names) {
        try {
          const stat = fs.statSync(path.join(dir, name));
          all.push({ label: name.replace(/\.md$/, ''), mtime: stat.mtimeMs, dir });
        } catch { /* skip */ }
      }
    } catch { /* dir missing */ }
  }
  if (all.length === 0) {
    return { ok: false, reason: 'no_snapshots' };
  }
  all.sort((a, b) => a.mtime - b.mtime);
  const recent = all.slice(-window);

  const profilePath = path.join(personaDir, 'profile.md');
  let priorProfile = '';
  try { priorProfile = fs.readFileSync(profilePath, 'utf8'); } catch { /* first run */ }

  const weeklies = recent.map((entry) => {
    const body = fs.readFileSync(path.join(entry.dir, `${entry.label}.md`), 'utf8');
    return { label: entry.label, body };
  });

  const today = ymd(new Date());
  const earliest = weeklies[0].label;
  const latest = weeklies[weeklies.length - 1].label;

  const sections: string[] = [];
  sections.push(`Today: ${today}`);
  sections.push(`Evidence span: ${earliest} → ${latest}`);
  sections.push('');
  sections.push('## CURRENT PROFILE');
  sections.push(priorProfile.trim() || '(no prior profile; this is the first merge)');
  sections.push('');
  sections.push('## NEW WEEKLY SNAPSHOTS');
  for (const w of weeklies) {
    sections.push(`### Weekly ${w.label}`);
    sections.push(w.body.trim());
    sections.push('');
  }
  const payload = sections.join('\n');

  const prompt = PROMPTS.personaMerge;
  const resp = await chatWithFallback({
    system: prompt.system,
    user: payload,
    temperature: prompt.temperature,
    numCtx: prompt.numCtx,
    numPredict: prompt.numPredict,
    keepAlive: '30m',
    label: 'persona:merge'
  });

  let text = stripFences(resp.content).trim();
  if (!text || text.length < 120) {
    return { ok: false, reason: 'output_too_short' };
  }
  atomicWrite(profilePath, text + '\n');

  return { ok: true, outputPath: profilePath, weekliesUsed: weeklies.length, totalDurationMs: resp.totalDurationMs };
}

// Run merge if profile is missing or older than 30 days.
export async function catchUpMissingMerge(opts: { vaultDir: string }): Promise<MergeResult | null> {
  const profilePath = path.join(opts.vaultDir, 'notes', 'persona', 'profile.md');
  let stale = true;
  try {
    const stat = fs.statSync(profilePath);
    const ageMs = Date.now() - stat.mtimeMs;
    stale = ageMs > 30 * MS_PER_DAY;
  } catch { /* missing → stale */ }
  if (!stale) return null;

  banner([`🪞  PERSONA PROFILE MERGE`, 'profile is missing or > 30 days old — rebuilding']);
  const r = await mergeMonthlyProfile({ vaultDir: opts.vaultDir });
  if (r.ok) banner([`✅  PROFILE MERGED`, r.outputPath, `weeklies used: ${r.weekliesUsed}`]);
  else banner([`⚠️  PROFILE MERGE SKIPPED`, r.reason]);
  return r;
}

// =============================================================================
// Payload builders
// =============================================================================

function buildWeeklyPayload(args: {
  weekLabel: string;
  startStr: string;
  endStr: string;
  diaries: { date: string; body: string }[];
  conversations: { site: string; chatName: string; turns: { user: string; assistant: string }[] }[];
  messages: { date: string; body: string }[];
  mediaThemes: Record<string, MediaTheme>;
  projects: { name: string; firstLine: string }[];
}): string {
  const parts: string[] = [];
  parts.push(`ISO_WEEK_LABEL: ${args.weekLabel}`);
  parts.push(`DATE_RANGE_LABEL: ${args.startStr} → ${args.endStr}`);
  parts.push('');

  parts.push('## Daily diaries (last 7 days)');
  if (args.diaries.length === 0) parts.push('(none)');
  for (const d of args.diaries) {
    parts.push(`### Diary ${d.date}`);
    parts.push(truncate(d.body.trim(), 4000));
    parts.push('');
  }

  parts.push('## Conversations (modified in window)');
  if (args.conversations.length === 0) parts.push('(none)');
  for (const c of args.conversations) {
    parts.push(`### ${c.site} — ${c.chatName}`);
    const pairs = c.turns.map((t) => `U: ${truncate(t.user, 600)}\nA: ${truncate(t.assistant, 800)}`).join('\n---\n');
    parts.push(pairs);
    parts.push('');
  }

  parts.push('## Messages (daily markdown)');
  if (args.messages.length === 0) parts.push('(none)');
  for (const m of args.messages) {
    parts.push(`### Messages ${m.date}`);
    parts.push(truncate(m.body.trim(), 2500));
    parts.push('');
  }

  parts.push('## Media themes (pre-aggregated)');
  const siteKeys = Object.keys(args.mediaThemes);
  if (siteKeys.length === 0) parts.push('(none)');
  for (const site of siteKeys) {
    const t = args.mediaThemes[site];
    parts.push(`### ${site}`);
    parts.push(`top channels/handles: ${t.topActors.slice(0, 10).join(', ') || '(none)'}`);
    parts.push(`top searches: ${t.topSearches.slice(0, 10).join(' | ') || '(none)'}`);
    parts.push(`top topics: ${t.topTopics.slice(0, 10).join(', ') || '(none)'}`);
    parts.push('');
  }

  parts.push('## Project notes (existing)');
  if (args.projects.length === 0) parts.push('(none)');
  for (const p of args.projects) {
    parts.push(`- **${p.name}** — ${truncate(p.firstLine, 200)}`);
  }
  return parts.join('\n');
}

// =============================================================================
// Source readers
// =============================================================================

function readDiaries(obsidianDir: string, start: Date, end: Date): { date: string; body: string }[] {
  const dailyDir = path.join(obsidianDir, 'Daily');
  const out: { date: string; body: string }[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
    const d = ymd(new Date(t));
    const p = path.join(dailyDir, `${d}.md`);
    try {
      const body = fs.readFileSync(p, 'utf8');
      out.push({ date: d, body });
    } catch { /* missing */ }
  }
  return out;
}

function readRecentConversations(vaultDir: string, start: Date, end: Date): { site: string; chatName: string; turns: { user: string; assistant: string }[] }[] {
  const convRoot = path.join(vaultDir, 'conversations');
  const out: { site: string; chatName: string; turns: { user: string; assistant: string }[] }[] = [];
  let siteDirs: string[] = [];
  try { siteDirs = fs.readdirSync(convRoot); } catch { return out; }
  for (const site of siteDirs) {
    const siteDir = path.join(convRoot, site);
    let files: string[] = [];
    try { files = fs.readdirSync(siteDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const p = path.join(siteDir, f);
      let stat: fs.Stats;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.mtime < start || stat.mtime > end) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const turns = Array.isArray(raw?.turns) ? raw.turns : [];
        if (turns.length === 0) continue;
        out.push({
          site,
          chatName: String(raw?.chatName || path.basename(f, '.json')),
          turns: turns.map((t: any) => ({
            user: String(t.userText ?? ''),
            assistant: String(t.assistantText ?? '')
          }))
        });
      } catch { /* skip bad json */ }
    }
  }
  return out;
}

function readMessages(vaultDir: string, start: Date, end: Date): { date: string; body: string }[] {
  const dir = path.join(vaultDir, 'messages');
  const out: { date: string; body: string }[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
    const d = ymd(new Date(t));
    const p = path.join(dir, `${d}.md`);
    try {
      const body = fs.readFileSync(p, 'utf8');
      out.push({ date: d, body });
    } catch { /* missing */ }
  }
  return out;
}

type MediaTheme = {
  topActors: string[];
  topSearches: string[];
  topTopics: string[];
};

function readMediaThemes(vaultDir: string, start: Date, end: Date): Record<string, MediaTheme> {
  const root = path.join(vaultDir, 'media_raw');
  const result: Record<string, MediaTheme> = {};
  let sites: string[] = [];
  try { sites = fs.readdirSync(root); } catch { return result; }
  for (const site of sites) {
    const actors = new Map<string, number>();
    const searches = new Map<string, number>();
    const topics = new Map<string, number>();
    const siteDir = path.join(root, site);
    for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
      const d = ymd(new Date(t));
      const p = path.join(siteDir, `${d}.json`);
      let log: any;
      try { log = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      const events: any[] = Array.isArray(log?.events) ? log.events : [];
      for (const e of events) {
        const actor = e.channelHandle || e.channelName || e.handle || e.subreddit || e.author || e.username;
        if (actor) actors.set(String(actor), (actors.get(String(actor)) ?? 0) + 1);
        if (e.query) searches.set(String(e.query), (searches.get(String(e.query)) ?? 0) + 1);
        const topic = e.hashtag || e.topic || e.slug || e.category;
        if (topic) topics.set(String(topic), (topics.get(String(topic)) ?? 0) + 1);
      }
    }
    if (actors.size === 0 && searches.size === 0 && topics.size === 0) continue;
    result[site] = {
      topActors: rankByCount(actors),
      topSearches: rankByCount(searches),
      topTopics: rankByCount(topics)
    };
  }
  return result;
}

function rankByCount(m: Map<string, number>): string[] {
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => c > 1 ? `${k} (${c})` : k);
}

function listProjects(vaultDir: string): { name: string; firstLine: string }[] {
  const dir = path.join(vaultDir, 'notes', 'projects');
  const out: { name: string; firstLine: string }[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    try {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
      out.push({ name: f.replace(/\.md$/, ''), firstLine });
    } catch { /* skip */ }
  }
  return out;
}

// =============================================================================
// Helpers
// =============================================================================

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n: number): string { return String(n).padStart(2, '0'); }

// ISO 8601 week label like "2026-W21".
export function isoWeekLabel(d: Date): string {
  // Algorithm: shift to Thursday of the same week, then compute week-of-year.
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThuDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThuDay + 3);
  const weekNum = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${target.getUTCFullYear()}-W${pad(weekNum)}`;
}

// Return the past N Fridays (oldest first), including today if today is a
// Friday at or past the target hour. Uses LOCAL time.
function lastNFridays(n: number, now: Date = new Date()): Date[] {
  const out: Date[] = [];
  const cursor = new Date(now);
  // Walk back at most 7+n*7 days to find Fridays
  for (let i = 0; i < n * 7 + 7 && out.length < n; i++) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - i, 22, 0, 0, 0);
    // 5 = Friday
    if (d.getDay() === 5 && d.getTime() <= now.getTime()) {
      out.unshift(d);
    }
  }
  return out;
}

function atomicWrite(file: string, content: string) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function stripFences(text: string): string {
  let s = text.trim();
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '');
  s = s.replace(/\n?```\s*$/, '');
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*$/gm, '');
  return s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function banner(lines: string[]) {
  const visibleLen = (s: string) => s.length;
  const inner = Math.max(40, Math.min(80, Math.max(...lines.map(visibleLen)) + 4));
  const horiz = '═'.repeat(inner);
  console.log('');
  console.log(`╔${horiz}╗`);
  console.log(`║${' '.repeat(inner)}║`);
  for (const line of lines) {
    const pad = Math.max(0, inner - line.length - 2);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    console.log(`║ ${' '.repeat(left)}${line}${' '.repeat(right)} ║`);
  }
  console.log(`║${' '.repeat(inner)}║`);
  console.log(`╚${horiz}╝`);
  console.log('');
}

// =============================================================================
// Scheduling helpers
// =============================================================================

/**
 * Fire `run` every week on a given day-of-week at HH:MM local time.
 * Interval-based (30s tick) so it survives sleep/wake.
 * In-memory memo by ISO week label prevents double-firing.
 */
export function scheduleWeekly(dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6, hour: number, minute: number, run: () => Promise<void> | void): () => void {
  let cancelled = false;
  let busy = false;
  let firedWeek = '';
  const targetMins = hour * 60 + minute;
  const tick = async () => {
    if (cancelled || busy) return;
    const now = new Date();
    if (now.getDay() !== dayOfWeek) return;
    const curMins = now.getHours() * 60 + now.getMinutes();
    if (curMins < targetMins) return;
    const wk = isoWeekLabel(now);
    if (firedWeek === wk) return;
    busy = true;
    firedWeek = wk;
    console.log(`[persona] firing weekly schedule for ${wk}`);
    try { await run(); } catch (err) { console.error('[persona] weekly run failed', err); }
    finally { busy = false; }
  };
  const interval = setInterval(tick, 30_000);
  void tick();
  return () => { cancelled = true; clearInterval(interval); };
}

// =============================================================================
// Data-driven trigger: check accumulated signal score every CHECK_INTERVAL,
// fire snapshot+merge when score >= threshold AND >= MIN_COOLDOWN since last.
// =============================================================================

const MS_PER_HOUR = 60 * 60_000;

export type TriggerOpts = {
  vaultDir: string;
  obsidianDir?: string;
  checkIntervalMinutes?: number;   // default 30
  minCooldownHours?: number;       // default 3
  threshold?: number;              // default 50
};

/**
 * Polls every CHECK_INTERVAL. When signal score since last snapshot crosses
 * the threshold (and cooldown elapsed), runs snapshot + merge through the
 * shared LLM coordinator. Replaces the old Friday weekly + 1st-monthly cron.
 */
export function scheduleDataDrivenPersona(opts: TriggerOpts): () => void {
  const vaultDir = opts.vaultDir;
  const obsidianDir = opts.obsidianDir;
  const checkMs = (opts.checkIntervalMinutes ?? 30) * 60_000;
  const cooldownMs = (opts.minCooldownHours ?? 3) * MS_PER_HOUR;
  const threshold = opts.threshold ?? 50;
  let cancelled = false;
  let busy = false;

  const tick = async () => {
    if (cancelled || busy) return;
    busy = true;
    try {
      const last = lastSnapshotMtime(vaultDir);
      const sinceMs = last ?? Date.now() - 24 * MS_PER_HOUR; // first run window = 24h
      const now = Date.now();
      if (last && now - last < cooldownMs) {
        // still inside cooldown
        return;
      }
      const score = signalScoreSince(vaultDir, sinceMs);
      if (score < threshold) {
        return;
      }
      console.log(`[persona trigger] score=${score} ≥ ${threshold} — generating snapshot`);
      const stamp = snapshotLabel(new Date());
      const r = await generateWeeklySnapshot({
        vaultDir,
        obsidianDir,
        rangeEnd: new Date(now),
        rangeStart: new Date(sinceMs),
        outputLabel: stamp
      });
      if (r.ok) {
        console.log(`[persona trigger] wrote ${r.outputPath}`);
        const m = await mergeMonthlyProfile({ vaultDir, weeksWindow: 8 });
        if (m.ok) console.log(`[persona trigger] merged profile → ${m.outputPath}`);
        else console.log(`[persona trigger] merge skipped: ${m.reason}`);
      } else {
        console.log(`[persona trigger] snapshot skipped: ${r.reason}`);
      }
    } catch (err) {
      console.error('[persona trigger] failed', err);
    } finally {
      busy = false;
    }
  };

  const interval = setInterval(tick, checkMs);
  // Run once on boot (will respect cooldown via lastSnapshotMtime).
  void tick();
  return () => { cancelled = true; clearInterval(interval); };
}

// Most recent snapshot mtime across both /snapshots and /weekly. Returns null
// when no snapshots exist (first-ever run).
function lastSnapshotMtime(vaultDir: string): number | null {
  const dirs = [
    path.join(vaultDir, 'notes', 'persona', 'snapshots'),
    path.join(vaultDir, 'notes', 'persona', 'weekly')
  ];
  let max = 0;
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        try {
          const stat = fs.statSync(path.join(dir, name));
          if (stat.mtimeMs > max) max = stat.mtimeMs;
        } catch { /* skip */ }
      }
    } catch { /* dir missing */ }
  }
  return max > 0 ? max : null;
}

// Compute a weighted signal score from data added since `sinceMs`.
//  - Diary day file modified         → +5
//  - Each conversation turn          → +3
//  - Daily messages md file modified → +1 (proxy for many DMs)
//  - Each media event                → +0.3
//  - Each project file modified      → +1.5
export function signalScoreSince(vaultDir: string, sinceMs: number): number {
  let score = 0;

  // 1) Diaries (R2Obsidian/Daily) — count files modified since
  try {
    const daily = path.join(os.homedir(), 'Downloads', 'R2Obsidian', 'Daily');
    for (const name of fs.readdirSync(daily)) {
      if (!name.endsWith('.md')) continue;
      const stat = fs.statSync(path.join(daily, name));
      if (stat.mtimeMs >= sinceMs) score += 5;
    }
  } catch { /* */ }

  // 2) Conversation turns since
  try {
    const convRoot = path.join(vaultDir, 'conversations');
    for (const site of fs.readdirSync(convRoot)) {
      const siteDir = path.join(convRoot, site);
      let files: string[];
      try { files = fs.readdirSync(siteDir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(siteDir, f));
          if (stat.mtimeMs < sinceMs) continue; // file untouched since
          const log = JSON.parse(fs.readFileSync(path.join(siteDir, f), 'utf8'));
          const turns: any[] = Array.isArray(log?.turns) ? log.turns : [];
          for (const t of turns) {
            if (Number(t.ts) >= sinceMs) score += 3;
          }
        } catch { /* skip bad json */ }
      }
    }
  } catch { /* no conversations dir */ }

  // 3) Messages day files
  try {
    const msgDir = path.join(vaultDir, 'messages');
    for (const name of fs.readdirSync(msgDir)) {
      if (!name.endsWith('.md')) continue;
      const stat = fs.statSync(path.join(msgDir, name));
      if (stat.mtimeMs >= sinceMs) score += 1;
    }
  } catch { /* */ }

  // 4) Media events since
  try {
    const mediaRoot = path.join(vaultDir, 'media_raw');
    for (const site of fs.readdirSync(mediaRoot)) {
      const siteDir = path.join(mediaRoot, site);
      let files: string[];
      try { files = fs.readdirSync(siteDir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(siteDir, f));
          if (stat.mtimeMs < sinceMs) continue;
          const log = JSON.parse(fs.readFileSync(path.join(siteDir, f), 'utf8'));
          const events: any[] = Array.isArray(log?.events) ? log.events : [];
          for (const e of events) {
            if (Number(e.ts) >= sinceMs) score += 0.3;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* */ }

  // 5) Project notes
  try {
    const projDir = path.join(vaultDir, 'notes', 'projects');
    for (const name of fs.readdirSync(projDir)) {
      if (!name.endsWith('.md')) continue;
      const stat = fs.statSync(path.join(projDir, name));
      if (stat.mtimeMs >= sinceMs) score += 1.5;
    }
  } catch { /* */ }

  return Math.round(score * 10) / 10;
}

function snapshotLabel(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Fire `run` monthly on a given day-of-month at HH:MM local time.
 */
export function scheduleMonthly(dayOfMonth: number, hour: number, minute: number, run: () => Promise<void> | void): () => void {
  let cancelled = false;
  let busy = false;
  let firedMonth = '';
  const targetMins = hour * 60 + minute;
  const tick = async () => {
    if (cancelled || busy) return;
    const now = new Date();
    if (now.getDate() !== dayOfMonth) return;
    const curMins = now.getHours() * 60 + now.getMinutes();
    if (curMins < targetMins) return;
    const m = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    if (firedMonth === m) return;
    busy = true;
    firedMonth = m;
    console.log(`[persona] firing monthly merge for ${m}`);
    try { await run(); } catch (err) { console.error('[persona] monthly run failed', err); }
    finally { busy = false; }
  };
  const interval = setInterval(tick, 30_000);
  void tick();
  return () => { cancelled = true; clearInterval(interval); };
}
