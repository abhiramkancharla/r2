import * as fs from 'fs';
import * as path from 'path';
import { embed, LlmError } from '../llm/ollama';
import { readLlmConfigSafe } from '../config/store';
import { EmbeddingIndex } from './embeddingIndex';

/**
 * After a new chat summary is written, find related notes in the Obsidian
 * vault and append a "## Related" wiki-link block to the chat markdown.
 *
 * Strategy:
 *   1. If an embedding model is configured AND the vault has been embedded,
 *      use cosine-similarity in the embedding index. (Mode B)
 *   2. Otherwise fall back to keyword/title overlap. (Mode A)
 *
 * The block is idempotent: re-running on the same file replaces the existing
 * block in place. User edits below/above it are preserved.
 */

const RELATED_TAG_OPEN = '<!-- r2:related -->';
const RELATED_TAG_CLOSE = '<!-- /r2:related -->';
const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_TOP_K = 5;

export type LinkResult =
  | { ok: true; mode: 'embedding' | 'keyword'; links: Array<{ title: string; score: number }> }
  | { ok: false; reason: string };

export async function linkChatToVault(opts: {
  chatMdPath: string;
  obsidianDir: string;
  index: EmbeddingIndex | null;
}): Promise<LinkResult> {
  const cfg = readLlmConfigSafe();
  if (!cfg.autoLinkVault) return { ok: false, reason: 'auto-link disabled in config' };

  if (!fs.existsSync(opts.chatMdPath)) {
    return { ok: false, reason: 'chat markdown does not exist' };
  }

  const chatText = fs.readFileSync(opts.chatMdPath, 'utf8');
  const chatBody = stripRelatedBlock(chatText);
  const chatTitle = path.basename(opts.chatMdPath, '.md');

  let links: Array<{ title: string; path: string; score: number }> = [];
  let mode: 'embedding' | 'keyword' = 'keyword';

  if (opts.index && cfg.embedModel) {
    try {
      const queryVec = await embed({
        model: cfg.embedModel,
        input: `${chatTitle}\n\n${headForEmbedding(chatBody)}`,
        baseUrl: cfg.baseUrl
      });
      const hits = opts.index.topK(queryVec, {
        k: DEFAULT_TOP_K,
        threshold: DEFAULT_THRESHOLD,
        excludePaths: new Set([opts.chatMdPath]),
        model: cfg.embedModel
      });
      links = hits;
      mode = 'embedding';
    } catch (err: any) {
      if (err instanceof LlmError && err.kind === 'missing_model') {
        // Fall through to keyword mode.
      } else {
        console.warn('[graph-link] embed failed, using keyword fallback:', err?.message ?? err);
      }
    }
  }

  if (mode === 'keyword') {
    links = keywordFallback({
      chatTitle,
      chatBody,
      obsidianDir: opts.obsidianDir,
      excludePath: opts.chatMdPath
    });
  }

  // No useful results — leave the file alone, don't write an empty block.
  if (links.length === 0) {
    if (chatText !== chatBody) {
      // We had a stale block from a previous run with hits; remove it now.
      writeAtomic(opts.chatMdPath, chatBody);
    }
    return { ok: true, mode, links: [] };
  }

  const block = formatRelatedBlock(links);
  const next = chatBody.trimEnd() + '\n\n' + block + '\n';
  writeAtomic(opts.chatMdPath, next);
  return {
    ok: true,
    mode,
    links: links.map((l) => ({ title: l.title, score: l.score }))
  };
}

// ---------- formatting ----------

function formatRelatedBlock(
  links: Array<{ title: string; path: string; score: number }>
): string {
  const lines = links.map((l) => `- [[${l.title}]]`);
  return `${RELATED_TAG_OPEN}\n## Related\n${lines.join('\n')}\n${RELATED_TAG_CLOSE}`;
}

function stripRelatedBlock(md: string): string {
  const open = md.indexOf(RELATED_TAG_OPEN);
  if (open === -1) return md;
  const close = md.indexOf(RELATED_TAG_CLOSE, open);
  if (close === -1) return md;
  return (
    md.slice(0, open).trimEnd() +
    md.slice(close + RELATED_TAG_CLOSE.length).replace(/^\s*\n/, '\n')
  ).replace(/\n{3,}/g, '\n\n');
}

function headForEmbedding(s: string): string {
  return s.length > 1500 ? s.slice(0, 1500) : s;
}

function writeAtomic(file: string, contents: string) {
  const tmp = `${file}.r2tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- keyword fallback ----------

// Tiny English stopword set — keep it small; we only need to filter the
// obvious useless ones. Vault content is often technical, so we don't want
// to over-prune.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','so','of','to','in','on','for',
  'with','at','by','from','about','as','is','are','was','were','be','been',
  'being','this','that','these','those','it','its','they','them','their',
  'we','our','you','your','i','me','my','he','she','his','her','do','does',
  'did','can','could','should','would','will','just','like','than','also',
  'one','two','some','any','all','no','not','what','which','who','how','why',
  'when','where','here','there','more','less','very','really','very','okay','ok'
]);

function keywordFallback(args: {
  chatTitle: string;
  chatBody: string;
  obsidianDir: string;
  excludePath: string;
}): Array<{ title: string; path: string; score: number }> {
  const queryTokens = topTokens(`${args.chatTitle} ${args.chatBody}`, 15);
  if (queryTokens.length < 3) return [];
  const candidates = listMarkdown(args.obsidianDir).filter((p) => p !== args.excludePath);
  const scored: Array<{ title: string; path: string; score: number }> = [];
  for (const filePath of candidates) {
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const head = text.slice(0, 2000).toLowerCase();
    const titleLower = path.basename(filePath, '.md').toLowerCase();
    let hits = 0;
    for (const tok of queryTokens) {
      if (titleLower.includes(tok)) hits += 2;
      else if (head.includes(tok)) hits += 1;
    }
    if (hits >= 3) {
      scored.push({
        path: filePath,
        title: path.basename(filePath, '.md'),
        score: hits / (queryTokens.length * 2)
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, DEFAULT_TOP_K);
}

function topTokens(s: string, max: number): string[] {
  const counts = new Map<string, number>();
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function listMarkdown(rootDir: string): string[] {
  // Walk the vault; exclude the same private subdirs as the embedding index.
  const excluded = new Set(['forms', 'persona', 'media']);
  const out: string[] = [];
  const stack: string[] = [];
  try { stack.push(rootDir); } catch { return []; }
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        const top = rel.split('/')[0];
        if (excluded.has(top)) continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}
