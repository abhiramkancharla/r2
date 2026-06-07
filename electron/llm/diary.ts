import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chat, chatWithFallback, prewarm } from './ollama';
import { PROMPTS } from './prompts';

export { prewarm };

export type GenerateResult = {
  ok: true;
  date: string;
  outputPath: string;
  model: string;
  totalDurationMs: number;
  inputSessions: number;
} | {
  ok: false;
  date: string;
  reason: string;
};

type Opts = {
  vaultDir: string;       // ~/R2Vault (input sessions live here)
  obsidianDir?: string;   // ~/Downloads/R2Obsidian (output target; defaults to it)
  date?: string;          // YYYY-MM-DD; defaults to today (local)
  modelOverride?: string;
};

export async function generateDiary(opts: Opts): Promise<GenerateResult> {
  const date = opts.date ?? localDate(new Date());
  const sessionFile = path.join(opts.vaultDir, 'sessions', `${date}.json`);
  if (!fs.existsSync(sessionFile)) {
    return { ok: false, date, reason: `No sessions file for ${date}: ${sessionFile}` };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, 'utf8');
  } catch (err: any) {
    return { ok: false, date, reason: `Failed to read sessions: ${err?.message ?? String(err)}` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return { ok: false, date, reason: `Sessions JSON malformed: ${err?.message ?? String(err)}` };
  }

  const sessions: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  if (sessions.length === 0) {
    return { ok: false, date, reason: 'No sessions to summarize.' };
  }

  const compact = compactSessions(sessions);
  if (compact.length === 0) {
    return { ok: false, date, reason: 'All sessions filtered as noise.' };
  }

  const prompt = PROMPTS.obsidianDiary;

  // Build evidence anchors the model is forced to obey.
  const appCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  for (const s of compact) {
    const a = s.app || 'Unknown';
    appCounts.set(a, (appCounts.get(a) ?? 0) + 1);
    if (Array.isArray(s.events) && s.events.length > 0) {
      eventCounts.set(a, (eventCounts.get(a) ?? 0) + s.events.length);
    }
  }
  const appsObserved = Array.from(appCounts.keys()).sort();
  const appsWithEvents = Array.from(eventCounts.keys()).sort();

  // Use compact JSON (no pretty-print) to save tokens.
  const userPayload =
    `Date: ${date}\n\n` +
    `APPS_OBSERVED (exhaustive — only these apps were used today; do not mention any other app name):\n` +
    appsObserved.map((a) => `  - ${a} (${appCounts.get(a)} sessions${eventCounts.get(a) ? `, ${eventCounts.get(a)} events` : ''})`).join('\n') +
    `\n\nAPPS_WITH_EVENTS (these apps had explicit user submissions — you MUST cover each one):\n` +
    (appsWithEvents.length ? appsWithEvents.map((a) => `  - ${a}`).join('\n') : '  (none)') +
    `\n\nSessions (${compact.length}):\n${JSON.stringify(compact)}`;

  // Rough token estimate: ~3 chars/token for JSON-heavy text. Used to warn
  // when input approaches num_ctx so the user knows truncation is imminent.
  const estTokens = Math.ceil(userPayload.length / 3);
  const ctx = prompt.numCtx ?? 8192;
  const headroom = ctx - estTokens - (prompt.numPredict ?? 1500) - 700; // ~700 for system prompt
  console.log(`[diary] sessions=${compact.length} payload=${userPayload.length}c ~${estTokens}tok ctx=${ctx} headroom~${headroom}tok`);
  if (headroom < 0) {
    console.warn(`[diary] WARN: input likely exceeds num_ctx — output may miss late events. Consider bumping numCtx in prompts.ts.`);
  }

  // Chunk-and-merge threshold. ~50KB single-pass; above, chunk to keep each
  // call well within ctx + RAM budget. chatWithFallback picks main → fallback
  // per the user's configured models.
  const CHUNK_TRIGGER = 40_000;

  let cleaned: string;
  let totalDurationMs = 0;
  let modelUsed = '';

  if (userPayload.length > CHUNK_TRIGGER) {
    // ----- chunk-and-merge path -----
    const TARGET_CHUNK_CHARS = 30_000;
    const chunks = chunkCompactSessions(compact, TARGET_CHUNK_CHARS);
    console.log(`[diary] chunked into ${chunks.length} slices (target ≤${TARGET_CHUNK_CHARS}c each)`);

    const chunkPrompt = PROMPTS.diaryChunk;
    const sliceOutputs: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const slicePayload =
        `Date: ${date}\n` +
        `Time range: ${c.startHHMM}–${c.endHHMM}\n\n` +
        `APPS_OBSERVED (only mention apps from this list):\n` +
        appsObserved.map((a) => `  - ${a}`).join('\n') +
        `\n\nSessions in this slice (${c.sessions.length}):\n${JSON.stringify(c.sessions)}`;
      console.log(`[diary] slice ${i + 1}/${chunks.length} (${c.startHHMM}–${c.endHHMM}) — ${c.sessions.length} sessions, ${slicePayload.length}c`);

      const sliceResp = await chatWithFallback({
        system: chunkPrompt.system,
        user: slicePayload,
        temperature: chunkPrompt.temperature,
        numCtx: chunkPrompt.numCtx,
        numPredict: chunkPrompt.numPredict,
        keepAlive: '30m',
        label: `diary:${date}:slice ${i + 1}/${chunks.length}`
      });
      sliceOutputs.push(stripFences(sliceResp.content).trim());
      totalDurationMs += sliceResp.totalDurationMs;
      modelUsed = sliceResp.model;
    }

    // ----- merge step -----
    const mergePrompt = PROMPTS.diaryMerge;
    const mergePayload =
      `Date: ${date}\n\n` +
      `APPS_OBSERVED (only mention apps from this list):\n` +
      appsObserved.map((a) => `  - ${a}`).join('\n') +
      `\n\nTime-slice notes (oldest → newest):\n\n` +
      sliceOutputs.map((s, i) => `--- SLICE ${i + 1} ---\n${s}`).join('\n\n');
    console.log(`[diary] merging ${chunks.length} slices (${mergePayload.length}c)`);

    const mergeResp = await chatWithFallback({
      system: mergePrompt.system,
      user: mergePayload,
      temperature: mergePrompt.temperature,
      numCtx: mergePrompt.numCtx,
      numPredict: mergePrompt.numPredict,
      keepAlive: '30m',
      label: `diary:${date}:merge`
    });
    cleaned = stripFences(mergeResp.content);
    totalDurationMs += mergeResp.totalDurationMs;
    modelUsed = mergeResp.model;
  } else {
    // ----- single-pass path -----
    console.log(`[diary] single-pass`);
    const resp = await chatWithFallback({
      system: prompt.system,
      user: userPayload,
      temperature: prompt.temperature,
      numCtx: prompt.numCtx,
      numPredict: prompt.numPredict,
      keepAlive: '30m',
      label: `diary:${date}`
    });
    cleaned = stripFences(resp.content);
    totalDurationMs = resp.totalDurationMs;
    modelUsed = resp.model;
  }

  const obsidianDir = opts.obsidianDir ?? path.join(os.homedir(), 'Downloads', 'R2Obsidian');
  const outDir = path.join(obsidianDir, 'Daily');
  fs.mkdirSync(outDir, { recursive: true });
  // Always overwrite <date>.md so re-runs refresh the diary.
  const outPath = path.join(outDir, `${date}.md`);
  fs.writeFileSync(outPath, cleaned, 'utf8');

  return {
    ok: true,
    date,
    outputPath: outPath,
    model: modelUsed,
    totalDurationMs,
    inputSessions: sessions.length
  };
}

// Greedy time-bucket chunker. Walks compact sessions in order, accumulating
// into the current chunk until JSON size approaches the target. Prefers to
// break at "natural" gaps (>= 30 min between consecutive sessions) when
// available, so each chunk corresponds to a meaningful slice of the day.
function chunkCompactSessions(compact: any[], targetCharsPerChunk: number): {
  startHHMM: string;
  endHHMM: string;
  sessions: any[];
}[] {
  const chunks: { startHHMM: string; endHHMM: string; sessions: any[] }[] = [];
  if (compact.length === 0) return chunks;

  let current: any[] = [];
  let currentSize = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      startHHMM: String(current[0].start ?? '??:??'),
      endHHMM: String(current[current.length - 1].end ?? current[current.length - 1].start ?? '??:??'),
      sessions: current
    });
    current = [];
    currentSize = 0;
  };

  const minutesOf = (hhmm: string): number => {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };

  for (let i = 0; i < compact.length; i++) {
    const s = compact[i];
    const sSize = JSON.stringify(s).length + 2;
    const prev = current[current.length - 1];
    const naturalBreak =
      prev &&
      prev.end && s.start &&
      minutesOf(s.start) - minutesOf(prev.end) >= 30;

    // Close chunk at natural break if it has meaningful size already, OR
    // when adding this session would push us past the cap.
    if (
      (naturalBreak && currentSize > targetCharsPerChunk * 0.4) ||
      currentSize + sSize > targetCharsPerChunk
    ) {
      flush();
    }
    current.push(s);
    currentSize += sSize;
  }
  flush();

  // Avoid a tiny tail chunk — merge into previous if it's small.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (JSON.stringify(last.sessions).length < targetCharsPerChunk * 0.15) {
      const prior = chunks[chunks.length - 2];
      prior.sessions.push(...last.sessions);
      prior.endHHMM = last.endHHMM;
      chunks.pop();
    }
  }
  return chunks;
}

// Reduce sessions to a compact, model-friendly shape. Drops noise + verbose
// fields so the whole day fits comfortably in context.
function compactSessions(sessions: any[]): any[] {
  // Filter + coalesce. Goal: keep every event-bearing session, drop the
  // hundreds of tab-flicker sessions that pad a real day, and collapse
  // adjacent same-(app,url) sessions into one.
  type Compact = ReturnType<typeof toCompact>;
  const filtered: Compact[] = [];
  for (const s of sessions) {
    const durMs = Number(s.durationMs ?? 0);
    const events = Array.isArray(s.events) ? s.events : [];
    const title = String(s.title ?? '');
    const url = s.url ?? null;
    const app = String(s.app ?? '');

    const hasEvents = events.length > 0;
    const isGenericTitle = !title || /^(new tab|untitled|home|google chrome|safari|arc|brave|firefox)$/i.test(title.trim());
    const isJunkUrl = !url || /^(chrome|edge|brave|arc|about|chrome-extension|file):/i.test(url);

    // Skip Finder / System Settings micro-flickers under 30s
    if (/^(Finder|System Settings|System Preferences)$/i.test(app) && durMs < 30_000 && !hasEvents) continue;
    // Skip ultra-short flicker w/ no signal
    if (durMs < 5_000 && !hasEvents && (isGenericTitle || isJunkUrl)) continue;
    // Skip sub-30s sessions w/ no events AND nothing meaningful in title/url
    if (durMs < 30_000 && !hasEvents && isGenericTitle && isJunkUrl) continue;

    filtered.push(toCompact(s, events));
  }

  // Coalesce adjacent same-(app,url) rows. Drops massive tab-flap noise where
  // SessionLogger created N back-to-back rows for the same page.
  const coalesced: Compact[] = [];
  for (const c of filtered) {
    const prev = coalesced[coalesced.length - 1];
    if (
      prev &&
      prev.app === c.app &&
      prev.url === c.url &&
      prev.title === c.title &&
      prev.category === c.category
    ) {
      prev.durSec = (prev.durSec ?? 0) + (c.durSec ?? 0);
      prev.end = c.end ?? prev.end;
      prev.events.push(...c.events);
      continue;
    }
    coalesced.push(c);
  }

  return coalesced;

  function toCompact(s: any, events: any[]) {
    const durMs = Number(s.durationMs ?? 0);
    return {
      start: hhmm(s.startTs),
      end: s.endTs ? hhmm(s.endTs) : null,
      durSec: Math.round(durMs / 1000),
      app: String(s.app ?? ''),
      title: trim(String(s.title ?? ''), 160),
      url: s.url ? trim(String(s.url), 160) : null,
      category: String(s.category ?? 'unknown'),
      events: events
        .map((e: any) => ({
          kind: String(e.kind ?? 'submit'),
          at: e.ts ? hhmm(e.ts) : undefined,
          text: e.text ? trim(String(e.text), 400) : undefined,
          url: e.url ? trim(String(e.url), 160) : undefined
        }))
        .filter((e: any) => e.text || e.url)
    };
  }
}

function hhmm(ts: number): string {
  const d = new Date(Number(ts));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function stripFences(text: string): string {
  let s = text.trim();
  // Remove leading fence (```md, ```markdown, ```, etc.)
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '');
  // Remove trailing fence
  s = s.replace(/\n?```\s*$/, '');
  // Also strip any free-floating triple-backtick lines that the model
  // might emit mid-output (we forbid code blocks in the prompt).
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*$/gm, '');
  return s.trim() + '\n';
}

function localDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Fail-safe: on app start, find any past-day session files that have no
// corresponding diary <date>.md and generate them. Runs sequentially to avoid
// pounding the local LLM.
export async function catchUpMissingDiaries(opts: { vaultDir: string; obsidianDir?: string }): Promise<GenerateResult[]> {
  const sessionsDir = path.join(opts.vaultDir, 'sessions');
  const obsidianDir = opts.obsidianDir ?? path.join(os.homedir(), 'Downloads', 'R2Obsidian');
  const diaryDir = path.join(obsidianDir, 'Daily');
  const results: GenerateResult[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch (err: any) {
    console.log(`[diary catchup] no sessions dir at ${sessionsDir}: ${err?.message ?? err}`);
    return results;
  }

  const today = localDate(new Date());
  const dates: string[] = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const d = m[1];
    if (d >= today) continue; // skip today and future (today handled by scheduler)
    dates.push(d);
  }
  dates.sort();

  console.log(`[diary catchup] sessions=${files.length} past-day-candidates=[${dates.join(', ')}] today=${today}`);

  // Filter to actually-pending dates so the banner count is accurate.
  const pending = dates.filter((d) => !fs.existsSync(path.join(diaryDir, `${d}.md`)));
  if (pending.length === 0) {
    if (dates.length > 0) {
      console.log(`[diary catchup] all ${dates.length} past-day diaries already present — nothing to do`);
    }
    return results;
  }

  printBanner([
    '📓  DIARY CATCHUP',
    `generating ${pending.length} missing diary${pending.length === 1 ? '' : 's'}: ${pending.join(', ')}`,
    'this may take a couple minutes per day — do not quit'
  ]);

  for (const date of dates) {
    const primary = path.join(diaryDir, `${date}.md`);
    if (fs.existsSync(primary)) {
      console.log(`[diary catchup] ${date}: already exists — skip`);
      continue;
    }
    printBanner([`✨  GENERATING DIARY — ${date}`]);
    try {
      const r = await generateDiary({ vaultDir: opts.vaultDir, obsidianDir, date });
      if (r.ok) {
        printBanner([`✅  DIARY GENERATED — ${date}`, r.outputPath]);
      } else {
        printBanner([`⚠️  DIARY SKIPPED — ${date}`, r.reason]);
      }
      results.push(r);
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      printBanner([`❌  DIARY FAILED — ${date}`, reason]);
      results.push({ ok: false, date, reason });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  printBanner([`📓  DIARY CATCHUP COMPLETE`, `${ok} written, ${fail} skipped/failed`]);

  return results;
}

// Pretty-print a multi-line banner using a box-drawing border.
function printBanner(lines: string[]) {
  const visibleLen = (s: string) => {
    // Reasonable visual length — strip ANSI/emoji width to a rough estimate.
    // We don't need pixel-perfect; just enough to make the box look ok.
    // eslint-disable-next-line no-control-regex
    const noAnsi = s.replace(/\[[0-9;]*m/g, '');
    return noAnsi.length;
  };
  const inner = Math.max(40, Math.min(80, Math.max(...lines.map(visibleLen)) + 4));
  const horiz = '═'.repeat(inner);
  console.log('');
  console.log(`╔${horiz}╗`);
  console.log(`║${' '.repeat(inner)}║`);
  for (const line of lines) {
    const len = visibleLen(line);
    const pad = Math.max(0, inner - len - 2);
    const left = Math.floor(pad / 2);
    const right = pad - left;
    console.log(`║ ${' '.repeat(left)}${line}${' '.repeat(right)} ║`);
  }
  console.log(`║${' '.repeat(inner)}║`);
  console.log(`╚${horiz}╝`);
  console.log('');
}

/**
 * Schedule a daily run at HH:MM local time.
 *
 * Implementation uses a 30s interval poll (not setTimeout) so it survives
 * laptop sleep/wake and so a startup after the target time still fires today.
 *
 * Behavior:
 *   - On startup, if local time is already ≥ HH:MM, fires immediately.
 *   - Otherwise, fires the first tick where local time ≥ HH:MM.
 *   - In-memory memo prevents double-firing within the same local day. On
 *     restart, the day's run may fire again — that's fine because the writer
 *     overwrites the diary .md.
 */
export function scheduleDaily(hour: number, minute: number, run: () => Promise<void> | void): () => void {
  let cancelled = false;
  let busy = false;
  let firedToday = ''; // YYYY-MM-DD memo

  const targetMinutes = hour * 60 + minute;
  const tick = async () => {
    if (cancelled || busy) return;
    const now = new Date();
    const today = localDate(now);
    const curMinutes = now.getHours() * 60 + now.getMinutes();
    if (curMinutes < targetMinutes) return;
    if (firedToday === today) return;
    busy = true;
    firedToday = today;
    console.log(`[diary] firing scheduled run for ${today} (current ${pad(now.getHours())}:${pad(now.getMinutes())} ≥ ${pad(hour)}:${pad(minute)})`);
    try {
      await run();
    } catch (err) {
      console.error('[diary] scheduled run failed', err);
    } finally {
      busy = false;
    }
  };

  const interval = setInterval(tick, 30_000);
  // Fire-and-forget initial tick covers the past-target-on-startup case.
  void tick();

  return () => {
    cancelled = true;
    clearInterval(interval);
  };
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
