import * as fs from 'fs';
import * as path from 'path';
import { chatWithFallback } from './ollama';
import { PROMPTS } from './prompts';

export type MediaTranscribeResult =
  | { ok: true; outputPath: string; site: string; date: string; events: number; totalDurationMs: number }
  | { ok: false; site: string; date: string; reason: string };

const SITE_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  tiktok: 'TikTok'
};

/**
 * Transcribe a single media_raw/<site>/<date>.json into a markdown note at
 * ~/R2Vault/notes/media/<site>/<date>.md. Atomic write. Always overwrites
 * the .md so re-runs after later activity refresh the day's note.
 */
export async function transcribeMediaJson(opts: {
  vaultDir: string;
  jsonPath: string;
}): Promise<MediaTranscribeResult> {
  const { vaultDir, jsonPath } = opts;
  const rel = path.relative(path.join(vaultDir, 'media_raw'), jsonPath);
  const parts = rel.split(path.sep);
  if (parts.length < 2) {
    return { ok: false, site: '?', date: '?', reason: `unexpected path ${jsonPath}` };
  }
  const site = parts[parts.length - 2];
  const date = path.basename(parts[parts.length - 1], '.json');

  let raw: string;
  try { raw = fs.readFileSync(jsonPath, 'utf8'); }
  catch (err: any) { return { ok: false, site, date, reason: `read failed: ${err?.message ?? err}` }; }

  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch (err: any) { return { ok: false, site, date, reason: `invalid JSON: ${err?.message ?? err}` }; }

  const events: any[] = Array.isArray(parsed?.events) ? parsed.events : [];
  if (events.length === 0) {
    return { ok: false, site, date, reason: 'no events' };
  }

  const compact = events.map((e) => ({
    at: hhmm(e.ts),
    kind: e.kind,
    dwell: e.dwellMs ? humanDwell(e.dwellMs) : undefined,
    url: trim(e.url, 200),
    title: trim(e.title, 200),
    handle: e.handle,
    channelHandle: e.channelHandle,
    channelName: e.channelName,
    displayName: e.displayName,
    videoId: e.videoId,
    reelId: e.reelId,
    postId: e.postId,
    subreddit: e.subreddit,
    username: e.username,
    threadId: e.threadId,
    otherHandle: e.otherHandle,
    jobTitle: e.jobTitle,
    company: e.company,
    slug: e.slug,
    hashtag: e.hashtag,
    topic: e.topic,
    author: e.author,
    tweetId: e.tweetId,
    query: e.query,
    text: trim(e.text, 400),
    feed: e.feed
  }));

  const prompt = PROMPTS.mediaTranscribe;
  const siteLabel = SITE_LABEL[site] ?? site;
  const userPayload =
    `Site: ${siteLabel}\n` +
    `Date: ${date}\n` +
    `Events (${compact.length}, oldest → newest):\n` +
    JSON.stringify(compact);

  const estTokens = Math.ceil(userPayload.length / 3);
  console.log(`[media-md] ${site}/${date} events=${compact.length} ~${estTokens}tok`);

  const resp = await chatWithFallback({
    system: prompt.system,
    user: userPayload,
    temperature: prompt.temperature,
    numCtx: prompt.numCtx,
    numPredict: prompt.numPredict,
    keepAlive: '30m',
    label: `media:${site}/${date}`
  });

  let text = stripFences(resp.content).trim();
  if (!text || text.length < 30) {
    return { ok: false, site, date, reason: 'output_too_short' };
  }

  const outDir = path.join(vaultDir, 'notes', 'media', site);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.md`);
  // Atomic write
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, text + '\n', 'utf8');
  fs.renameSync(tmp, outPath);

  return {
    ok: true,
    outputPath: outPath,
    site,
    date,
    events: compact.length,
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

function trim(s: any, max: number): string | undefined {
  if (s == null) return undefined;
  const str = String(s);
  if (!str) return undefined;
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function hhmm(ts: any): string | undefined {
  const n = Number(ts);
  if (!Number.isFinite(n)) return undefined;
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function humanDwell(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}
