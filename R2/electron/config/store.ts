import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export type LlmConfig = {
  mainModel: string;       // bigger model, tried first
  fallbackModel: string;   // smaller fallback, used on transport failure
  baseUrl: string;         // e.g. http://127.0.0.1:11434
  /**
   * True once the user has successfully saved a working configuration at least
   * once (test ping returned a non-empty response). On a fresh install this is
   * false so the orb starts red, prompting the user to open Configure.
   */
  verified: boolean;
};

export const DEFAULT_CONFIG: LlmConfig = {
  mainModel: 'qwen2.5:14b',
  fallbackModel: 'qwen2.5:7b',
  baseUrl: 'http://127.0.0.1:11434',
  verified: false
};

let cache: LlmConfig | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadLlmConfig(): LlmConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      mainModel: typeof parsed.mainModel === 'string' && parsed.mainModel ? parsed.mainModel : DEFAULT_CONFIG.mainModel,
      fallbackModel: typeof parsed.fallbackModel === 'string' && parsed.fallbackModel ? parsed.fallbackModel : DEFAULT_CONFIG.fallbackModel,
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_CONFIG.baseUrl,
      verified: parsed.verified === true
    };
  } catch {
    cache = { ...DEFAULT_CONFIG };
  }
  return cache;
}

export function saveLlmConfig(cfg: Partial<LlmConfig>): LlmConfig {
  const current = loadLlmConfig();
  // When any of the model/url fields change, drop the verified flag — the new
  // combination has to pass its own test ping before we trust it.
  const mainModel = cfg.mainModel?.trim() || current.mainModel;
  const fallbackModel = cfg.fallbackModel?.trim() || current.fallbackModel;
  const baseUrl = normalizeBaseUrl(cfg.baseUrl?.trim() || current.baseUrl);
  const fieldsChanged =
    mainModel !== current.mainModel ||
    fallbackModel !== current.fallbackModel ||
    baseUrl !== current.baseUrl;
  const next: LlmConfig = {
    mainModel,
    fallbackModel,
    baseUrl,
    verified:
      typeof cfg.verified === 'boolean'
        ? cfg.verified
        : fieldsChanged
          ? false
          : current.verified
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}

function normalizeBaseUrl(s: string): string {
  let url = s.trim().replace(/\/+$/, '');
  // Allow "11434" or "127.0.0.1:11434" → assume http
  if (/^\d+$/.test(url)) url = `http://127.0.0.1:${url}`;
  else if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  return url;
}

/** Synchronous getter for ollama.ts which can't see Electron's `app` from a
 *  Node-only worker. Falls back to env vars + defaults. */
export function readLlmConfigSafe(): LlmConfig {
  // app may not be initialized in some test/CLI contexts → swallow.
  try { return loadLlmConfig(); } catch { /* */ }
  return {
    mainModel: process.env.R2_LLM_MODEL || DEFAULT_CONFIG.mainModel,
    fallbackModel: process.env.R2_LLM_FALLBACK_MODEL || DEFAULT_CONFIG.fallbackModel,
    baseUrl: process.env.R2_LLM_URL || DEFAULT_CONFIG.baseUrl,
    verified: false
  };
}
