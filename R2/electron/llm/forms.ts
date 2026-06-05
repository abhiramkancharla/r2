import * as fs from 'fs';
import * as path from 'path';
import { chatWithFallback } from './ollama';
import { PROMPTS } from './prompts';

// =============================================================================
// Form detection from existing session JSONs.
//
// Source: ~/R2Vault/sessions/<date>.json (already captured).
// Output: ~/R2Vault/notes/forms/<formName>.md
//
// One md per distinct form. Subsequent sessions on the same form append a
// new dated "### YYYY-MM-DD" section to the existing file (via overwrite of
// the whole consolidated md after re-running the LLM on all known sessions
// for that form).
// =============================================================================

const FORM_HOSTS = [
  // ATS / job application
  'greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com', 'icims.com',
  'taleo.net', 'successfactors.com', 'ashbyhq.com', 'breezy.hr', 'jobvite.com',
  'bamboohr.com', 'smartrecruiters.com', 'recruitee.com', 'workable.com',
  // Form builders
  'forms.google.com', 'typeform.com', 'surveymonkey.com', 'jotform.com',
  'formstack.com', 'wufoo.com', 'airtable.com', 'tally.so', 'getform.io',
  // Education
  'commonapp.org', 'coalitionapp.org', 'applytexas.org', 'apply.collegeboard.org',
  // Government / grants
  'usajobs.gov', 'grants.gov',
  // Misc
  'docusign.net', 'hellosign.com', 'dropboxsign.com'
];

const FORM_URL_PATH = /\/(apply|application|applications|applicants?|form|forms|jobs?\/\d+\/?(apply|application)?|hiring)/i;
const FORM_TITLE = /(apply|application|form|submit your|job at\b)/i;
const FORM_KEYWORDS = [
  /why do you want/i,
  /tell us about yourself/i,
  /tell me about you/i,
  /describe your experience/i,
  /personal statement/i,
  /cover letter/i,
  /\bresume\b/i,
  /salary expectat/i,
  /willing to relocate/i,
  /available start date/i,
  /previous experience/i,
  /qualifications?/i,
  /why are you a good fit/i,
  /biggest (weakness|strength)/i,
  /authorized to work/i,
  /sponsorship/i
];

type SessionEvent = { ts: number; kind?: string; text?: string };
type Session = {
  startTs: number;
  endTs?: number | null;
  app?: string;
  title?: string;
  url?: string | null;
  category?: string;
  events?: SessionEvent[];
};

export type FormSession = {
  formId: string;
  formName: string;
  host: string;
  url: string;
  date: string;             // YYYY-MM-DD
  startTs: number;
  responses: string[];      // verbatim user text submissions in time order
};

export type FormGenResult =
  | { ok: true; outputPath: string; formName: string; sessionCount: number; totalDurationMs: number }
  | { ok: false; reason: string; formName?: string };

export function detectFormSessions(vaultDir: string): FormSession[] {
  const sessionsDir = path.join(vaultDir, 'sessions');
  const dayFiles: string[] = (() => {
    try { return fs.readdirSync(sessionsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); }
    catch { return []; }
  })();
  const out: FormSession[] = [];

  for (const file of dayFiles) {
    const date = file.replace(/\.json$/, '');
    let day: any;
    try { day = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8')); } catch { continue; }
    const sessions: Session[] = Array.isArray(day?.sessions) ? day.sessions : [];

    for (const s of sessions) {
      const score = scoreFormSession(s);
      if (score < 3) continue;
      const responses = (s.events ?? [])
        .filter((e) => typeof e.text === 'string' && e.text.trim().length > 0)
        .map((e) => String(e.text));
      if (responses.length === 0) continue;

      const url = String(s.url ?? '');
      const title = String(s.title ?? '');
      const host = hostOf(url);
      const formId = stableFormId(url, title);
      const formName = formNameFrom(title, host, url);

      out.push({
        formId,
        formName,
        host,
        url,
        date,
        startTs: Number(s.startTs ?? 0),
        responses
      });
    }
  }
  return out;
}

export function groupByForm(formSessions: FormSession[]): Map<string, FormSession[]> {
  const m = new Map<string, FormSession[]>();
  for (const fs of formSessions) {
    const arr = m.get(fs.formId) ?? [];
    arr.push(fs);
    m.set(fs.formId, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.startTs - b.startTs);
  return m;
}

// Run LLM on every detected form. Returns one result per form.
export async function generateFormNotes(opts: { vaultDir: string }): Promise<FormGenResult[]> {
  const detected = detectFormSessions(opts.vaultDir);
  const grouped = groupByForm(detected);
  const outDir = path.join(opts.vaultDir, 'notes', 'forms');
  fs.mkdirSync(outDir, { recursive: true });

  const results: FormGenResult[] = [];
  for (const [, sessions] of grouped) {
    try {
      const r = await generateOneFormNote(sessions, outDir);
      results.push(r);
    } catch (err: any) {
      results.push({ ok: false, reason: err?.message ?? String(err), formName: sessions[0]?.formName });
    }
  }
  return results;
}

async function generateOneFormNote(sessions: FormSession[], outDir: string): Promise<FormGenResult> {
  const first = sessions[0];
  const prompt = PROMPTS.formTranscribe;

  // Compact payload — collapse per-date responses.
  const byDate: Record<string, string[]> = {};
  for (const s of sessions) {
    if (!byDate[s.date]) byDate[s.date] = [];
    for (const r of s.responses) byDate[s.date].push(truncate(r, 1500));
  }
  const payload =
    `formName: ${first.formName}\n` +
    `host: ${first.host}\n` +
    `url: ${first.url}\n\n` +
    `Sessions (oldest → newest):\n` +
    JSON.stringify(byDate);

  const resp = await chatWithFallback({
    system: prompt.system,
    user: payload,
    temperature: prompt.temperature,
    numCtx: prompt.numCtx,
    numPredict: prompt.numPredict,
    keepAlive: '30m',
    label: `form:${first.formName}`
  });

  const text = stripFences(resp.content).trim();
  if (!text || text.length < 60) {
    return { ok: false, reason: 'output_too_short', formName: first.formName };
  }

  const safe = sanitizeFilename(first.formName);
  const outPath = path.join(outDir, `${safe}.md`);
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, text + '\n', 'utf8');
  fs.renameSync(tmp, outPath);

  return {
    ok: true,
    outputPath: outPath,
    formName: first.formName,
    sessionCount: sessions.length,
    totalDurationMs: resp.totalDurationMs
  };
}

// =============================================================================
// Heuristics
// =============================================================================

function scoreFormSession(s: Session): number {
  let score = 0;
  const url = String(s.url ?? '');
  const title = String(s.title ?? '');
  const host = hostOf(url);
  const events = s.events ?? [];

  if (host && FORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.endsWith(h))) score += 3;
  if (url && FORM_URL_PATH.test(url)) score += 2;
  if (title && FORM_TITLE.test(title)) score += 1;

  let kwHits = 0;
  for (const e of events) {
    const t = String(e.text ?? '');
    if (!t) continue;
    for (const kw of FORM_KEYWORDS) {
      if (kw.test(t)) { kwHits += 1; break; }
    }
  }
  score += Math.min(kwHits * 2, 6);

  const submits = events.filter((e) => /submit|text_submit|message_sent/.test(String(e.kind ?? ''))).length;
  if (submits >= 3 && score >= 1) score += 1;

  return score;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// Build a stable identity for a form across sessions. Prefer URL path (host+
// first 4 path segments) so the same job posting visited multiple times maps
// to the same file. Fall back to title hash.
function stableFormId(url: string, title: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 4).join('/');
    return `${u.hostname}/${segs}`.toLowerCase();
  } catch { /* no URL */ }
  return `title:${title.trim().toLowerCase()}`;
}

function formNameFrom(title: string, host: string, url: string): string {
  // Strip browser suffixes (" - Google Chrome", " - Safari", etc.) — already
  // a known idiom from chat names. Reuse simple substring trim.
  let t = title.trim();
  const cuts = [' - Google Chrome', ' — Google Chrome', ' - Safari', ' - Arc', ' - Firefox', ' - Microsoft Edge', ' - Brave Browser'];
  for (const c of cuts) {
    const i = t.indexOf(c);
    if (i >= 0) { t = t.slice(0, i).trim(); break; }
  }
  if (t.length === 0) {
    // fallback: derive from URL
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).slice(-2).join(' / ');
      return seg ? `${host} · ${seg}` : host;
    } catch { return host || 'Untitled Form'; }
  }
  return t;
}

function sanitizeFilename(s: string): string {
  let out = s
    .replace(/[\/\\:\*\?"<>\|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 80) out = out.slice(0, 80).trim();
  if (!out) out = 'untitled-form';
  return out;
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
