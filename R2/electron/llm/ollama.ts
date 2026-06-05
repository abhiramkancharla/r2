// Minimal Ollama /api/chat client. Local-only; no streaming.
// All LLM calls are serialized through a single in-process queue so the
// local model never thrashes. Subscribers can observe queue depth + the
// label of the currently-processing task (used to flip the orb eye blue
// while the LLM is busy and to print queue status to the terminal).

import { EventEmitter } from 'events';
import { readLlmConfigSafe } from '../config/store';

/**
 * Loads a model into Ollama RAM/VRAM and keeps it resident.
 * Sends a 0-token generate request — Ollama treats this as "load model".
 * Returns true on success, false on any failure (does not throw).
 */
export async function prewarm(model: string, opts?: { baseUrl?: string; keepAlive?: string; timeoutMs?: number }): Promise<boolean> {
  const baseUrl = (opts?.baseUrl ?? readLlmConfigSafe().baseUrl).replace(/\/+$/, '');
  const url = `${baseUrl}/api/generate`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5 * 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: '',
        stream: false,
        keep_alive: opts?.keepAlive ?? '30m'
      }),
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export type ChatOptions = {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  numCtx?: number;
  numPredict?: number;
  keepAlive?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Optional short label used for queue status output (terminal + UI). */
  label?: string;
};

export type ChatResponse = {
  content: string;
  model: string;
  totalDurationMs: number;
};

// ---------- Queue ----------

export type LlmStatus = {
  busy: boolean;        // anything currently being processed
  current: string | null;
  pending: number;      // number of queued tasks still waiting
};

class LlmCoordinator extends EventEmitter {
  private queueDepth = 0;
  private current: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  status(): LlmStatus {
    return { busy: this.current != null, current: this.current, pending: Math.max(0, this.queueDepth - (this.current ? 1 : 0)) };
  }

  /**
   * Run `task` only after every prior LLM call has finished. Returns the
   * task's result. Emits a 'change' event on every transition so the main
   * process can broadcast to renderer + log to terminal.
   */
  async run<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.queueDepth += 1;
    this.emit('change', this.status());
    const prior = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((res) => { release = res; });
    try {
      await prior;
      this.current = label;
      this.emit('change', this.status());
      return await task();
    } finally {
      this.queueDepth -= 1;
      this.current = null;
      this.emit('change', this.status());
      release();
    }
  }
}

export const llmCoordinator = new LlmCoordinator();

// ---------- chat ----------

// Distinguishable error so callers can decide whether to fall back vs surface
// "INSTALL LLM" to the UI.
export type LlmErrorKind = 'missing_model' | 'transport' | 'http' | 'empty' | 'unknown';
export class LlmError extends Error {
  kind: LlmErrorKind;
  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

async function rawChat(opts: ChatOptions): Promise<ChatResponse> {
  const baseUrl = (opts.baseUrl ?? readLlmConfigSafe().baseUrl).replace(/\/+$/, '');
  const envTimeout = Number(process.env.R2_LLM_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 20 * 60_000);

  const options: Record<string, unknown> = {};
  if (opts.temperature != null) options.temperature = opts.temperature;
  if (opts.numCtx != null) options.num_ctx = opts.numCtx;
  if (opts.numPredict != null) options.num_predict = opts.numPredict;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user',   content: opts.user }
    ],
    stream: false,
    keep_alive: opts.keepAlive ?? '30m',
    options: Object.keys(options).length ? options : undefined
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err: any) {
      throw new LlmError('transport', `Ollama unreachable at ${baseUrl}: ${err?.message ?? err}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Ollama returns 404 with body like {"error":"model 'qwen2.5:14b' not found"}
      if (res.status === 404 && /model.*not found/i.test(text)) {
        throw new LlmError('missing_model', `Model "${opts.model}" not installed. ${text}`);
      }
      throw new LlmError('http', `Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }
    const json: any = await res.json();
    const content = String(json?.message?.content ?? '').trim();
    if (!content) throw new LlmError('empty', 'Ollama returned empty content');
    return {
      content,
      model: String(json?.model ?? opts.model),
      totalDurationMs: Date.now() - t0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serialized wrapper around the Ollama /api/chat call. ALL LLM work in this
 * app goes through here so only one prompt is in-flight at a time and the
 * UI can show a single, accurate "busy" state.
 */
export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const label = opts.label ?? opts.model;
  return llmCoordinator.run(label, () => rawChat(opts));
}

// Bus for "model missing" notifications so main.ts can flip the eye red.
class LlmHealth extends EventEmitter {
  private _missing = false;
  private _missingModels = new Set<string>();
  get isMissing() { return this._missing; }
  get missingModels() { return Array.from(this._missingModels); }
  reportMissing(model: string) {
    this._missingModels.add(model);
    if (!this._missing) {
      this._missing = true;
      this.emit('change', { missing: true, models: this.missingModels });
    } else {
      this.emit('change', { missing: true, models: this.missingModels });
    }
  }
  clear() {
    if (this._missing || this._missingModels.size) {
      this._missing = false;
      this._missingModels.clear();
      this.emit('change', { missing: false, models: [] });
    }
  }
}
export const llmHealth = new LlmHealth();

/**
 * Try `mainModel` first; on transport / missing-model error, retry with
 * `fallbackModel`. If BOTH fail with missing_model, reports to llmHealth so
 * the UI can prompt the user to install a model. Throws the last error.
 *
 * Caller passes a single `opts` minus `model` — fallback uses same prompt.
 */
export async function chatWithFallback(opts: Omit<ChatOptions, 'model'>): Promise<ChatResponse> {
  const cfg = readLlmConfigSafe();
  const main = cfg.mainModel;
  const fallback = cfg.fallbackModel;

  try {
    const r = await chat({ ...opts, model: main, baseUrl: opts.baseUrl ?? cfg.baseUrl });
    llmHealth.clear();
    return r;
  } catch (err: any) {
    const isRecoverable =
      err instanceof LlmError &&
      (err.kind === 'transport' || err.kind === 'missing_model' || err.kind === 'http');

    if (err instanceof LlmError && err.kind === 'missing_model') {
      llmHealth.reportMissing(main);
    }
    if (!isRecoverable || main === fallback) throw err;

    console.warn(`[llm] main "${main}" failed (${err?.message ?? err}). Falling back to "${fallback}".`);
    try {
      const r = await chat({ ...opts, model: fallback, baseUrl: opts.baseUrl ?? cfg.baseUrl, label: (opts.label ?? main) + ':fallback' });
      // Main missing but fallback worked: keep the "missing" flag set so UI can
      // tell the user to either install the bigger one or accept the slower path.
      return r;
    } catch (err2: any) {
      if (err2 instanceof LlmError && err2.kind === 'missing_model') {
        llmHealth.reportMissing(fallback);
      }
      throw err2;
    }
  }
}
