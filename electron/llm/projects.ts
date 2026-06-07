import * as fs from 'fs';
import * as path from 'path';
import { chatWithFallback } from './ollama';
import { PROMPTS } from './prompts';

export type ProjectGenResult =
  | { ok: true; outputPath: string; chatName: string; turns: number; totalDurationMs: number }
  | { ok: false; reason: string; chatName?: string };

type Opts = {
  vaultDir: string;       // ~/R2Vault
  jsonPath: string;       // absolute path to conversation JSON
  /**
   * 'initial' = first analysis (file just created). Writes <chatName>.md.
   * 'modification' = analysis after a change. Writes <chatName>-N.md when
   * <chatName>.md already exists.
   */
  mode: 'initial' | 'modification';
};

const NO_IDEAS_TOKEN = 'NO_PROJECT_IDEAS';

export async function generateProjectFromConversation(opts: Opts): Promise<ProjectGenResult> {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.jsonPath, 'utf8');
  } catch (err: any) {
    return { ok: false, reason: `read failed: ${err?.message ?? err}` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return { ok: false, reason: `invalid JSON: ${err?.message ?? err}` };
  }

  const turns: any[] = Array.isArray(parsed?.turns) ? parsed.turns : [];
  if (turns.length === 0) {
    return { ok: false, reason: 'no turns' };
  }

  const chatNameRaw: string = String(parsed?.chatName ?? '');
  const fallback = path.basename(opts.jsonPath, '.json');
  const chatName = (chatNameRaw && chatNameRaw.trim()) || fallback;
  const site = String(parsed?.site ?? 'unknown');
  const date = isoDate(parsed?.startedAt ?? Date.now());

  // Compact pairs for the LLM. Truncate very long messages — tail likely
  // contains the freshest direction.
  const pairs = turns.map((t) => ({
    user: truncate(String(t?.userText ?? ''), 1200),
    assistant: truncate(String(t?.assistantText ?? ''), 1800)
  }));

  const prompt = PROMPTS.projectIdea;
  const userPayload =
    `Chat: ${chatName}\n` +
    `Site: ${site}\n` +
    `Date: ${date}\n` +
    `Turn count: ${pairs.length}\n\n` +
    `Conversation (oldest → newest):\n` +
    JSON.stringify(pairs);

  // Log context budget for visibility
  const estTokens = Math.ceil(userPayload.length / 3);
  console.log(`[project] chatName="${chatName}" turns=${pairs.length} ~${estTokens}tok ctx=${prompt.numCtx}`);

  const resp = await chatWithFallback({
    system: prompt.system,
    user: userPayload,
    temperature: prompt.temperature,
    numCtx: prompt.numCtx,
    numPredict: prompt.numPredict,
    keepAlive: '30m',
    label: `project:${chatName}`
  });

  const text = stripFences(resp.content).trim();

  // No-ideas guard. Be lenient — model may add whitespace.
  if (text === NO_IDEAS_TOKEN ||
      text.toUpperCase().startsWith(NO_IDEAS_TOKEN)) {
    console.log(`PROJECT NOT WORTHY - ${chatName}`);
    return { ok: false, reason: 'no_project_ideas', chatName };
  }
  // Defensive: if output is empty or absurdly short, treat as no ideas
  if (text.length < 40) {
    console.log(`PROJECT NOT WORTHY - ${chatName}`);
    return { ok: false, reason: 'output_too_short', chatName };
  }

  console.log(`PROJECT WORTHY - ${chatName}`);

  const outDir = path.join(opts.vaultDir, 'notes', 'projects');
  fs.mkdirSync(outDir, { recursive: true });

  const safeName = sanitizeFilename(chatName);
  const outPath = path.join(outDir, `${safeName}.md`);

  // Single file per chat. Modifications append as dated revision sections so
  // history is preserved inline (no <chatName>-N.md spam).
  if (opts.mode === 'modification' && fs.existsSync(outPath)) {
    let existing = '';
    try { existing = fs.readFileSync(outPath, 'utf8'); } catch { /* race ok */ }
    const stamp = revisionStamp(new Date());
    const trimmed = existing.replace(/\s+$/, '');
    const appended = `${trimmed}\n\n---\n\n## Revision — ${stamp}\n\n${text}\n`;
    fs.writeFileSync(outPath, appended, 'utf8');
  } else {
    fs.writeFileSync(outPath, text + '\n', 'utf8');
  }

  return {
    ok: true,
    outputPath: outPath,
    chatName,
    turns: pairs.length,
    totalDurationMs: resp.totalDurationMs
  };
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

function isoDate(ts: number): string {
  const d = new Date(Number(ts));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function revisionStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${dd} ${hh}:${mi}`;
}

function sanitizeFilename(s: string): string {
  let out = s
    .replace(/[\/\\:\*\?"<>\|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 80) out = out.slice(0, 80).trim();
  if (!out) out = 'untitled';
  return out;
}
