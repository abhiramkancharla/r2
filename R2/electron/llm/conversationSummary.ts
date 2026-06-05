import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chatWithFallback } from './ollama';
import { PROMPTS } from './prompts';

export type SummaryResult =
  | { ok: true; outputPath: string; site: string; chatName: string; turns: number; totalDurationMs: number }
  | { ok: false; site: string; chatName: string; reason: string };

/**
 * Read a conversation JSON, call the local LLM with the conversationSummary
 * prompt, write a concise markdown summary to:
 *   ~/Downloads/R2Obsidian/conversations/<site>/<chatName>.md
 *
 * Atomic write. Always overwrites — subsequent runs refresh the summary as
 * the conversation grows.
 */
export async function summarizeConversation(opts: {
  jsonPath: string;
  obsidianDir?: string;
}): Promise<SummaryResult> {
  const obsidianDir = opts.obsidianDir ?? path.join(os.homedir(), 'Downloads', 'R2Obsidian');

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(opts.jsonPath, 'utf8'));
  } catch (err: any) {
    return { ok: false, site: '?', chatName: '?', reason: `read failed: ${err?.message ?? err}` };
  }

  const turns: any[] = Array.isArray(parsed?.turns) ? parsed.turns : [];
  if (turns.length === 0) {
    return { ok: false, site: String(parsed?.site ?? '?'), chatName: String(parsed?.chatName ?? '?'), reason: 'no turns' };
  }
  const site = String(parsed?.site ?? path.basename(path.dirname(opts.jsonPath)));
  // chatName is what we display + use in the LLM payload. fileBase is the
  // OUTPUT FILENAME — falls back to the JSON basename when chatName is
  // missing so different unnamed chats don't all clobber `untitled.md`.
  const rawChatName = String(parsed?.chatName ?? '').trim();
  const chatName = rawChatName || 'untitled';
  const fileBase = rawChatName || path.basename(opts.jsonPath, '.json');
  const startedAt = Number(parsed?.startedAt ?? turns[0]?.ts ?? Date.now());
  const date = isoDate(startedAt);

  const compact = turns.map((t) => ({
    user: truncate(String(t.userText ?? ''), 1200),
    assistant: truncate(String(t.assistantText ?? ''), 1500)
  }));

  const prompt = PROMPTS.conversationSummary;
  const userPayload =
    `chatName: ${chatName}\n` +
    `site: ${site}\n` +
    `date: ${date}\n` +
    `turns: ${compact.length}\n\n` +
    `Conversation (oldest → newest):\n` +
    JSON.stringify(compact);

  console.log(`[conv-md] ${site}/${chatName} turns=${compact.length} payload=${userPayload.length}c`);

  const resp = await chatWithFallback({
    system: prompt.system,
    user: userPayload,
    temperature: prompt.temperature,
    numCtx: prompt.numCtx,
    numPredict: prompt.numPredict,
    keepAlive: '30m',
    label: `conv:${site}/${chatName}`
  });

  const text = stripFences(resp.content).trim();
  if (!text || text.length < 40) {
    return { ok: false, site, chatName, reason: 'output_too_short' };
  }

  const outDir = path.join(obsidianDir, 'conversations', site);
  fs.mkdirSync(outDir, { recursive: true });
  const safe = sanitizeFilename(fileBase);
  const outPath = path.join(outDir, `${safe}.md`);
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, text + '\n', 'utf8');
  fs.renameSync(tmp, outPath);

  return {
    ok: true,
    outputPath: outPath,
    site,
    chatName,
    turns: compact.length,
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

function sanitizeFilename(s: string): string {
  let out = s
    .replace(/[\/\\:\*\?"<>\|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 80) out = out.slice(0, 80).trim();
  if (!out) out = 'untitled';
  return out;
}
