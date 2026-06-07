import { app, BrowserWindow, ipcMain, screen, Tray, nativeImage, powerMonitor, protocol, net } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ActivityTracker } from './tracker/activity';
import { MemoryStore } from './memory/store';
import { InterventionEngine } from './intervention/engine';
import { AXHelper, resolveAXBinPath } from './capture/axHelper';
import { ConversationStore, sanitizeAiTurn } from './capture/conversations';
import { SessionLogger } from './sessions/logger';
import { generateDiary, scheduleDaily, catchUpMissingDiaries } from './llm/diary';
import {
  generateWeeklySnapshot,
  mergeMonthlyProfile,
  catchUpMissingWeeklies,
  catchUpMissingMerge,
  scheduleDataDrivenPersona
} from './llm/persona';
import { prewarm as prewarmLLM, llmHealth, pingLlm } from './llm/ollama';
import { loadLlmConfig, saveLlmConfig, type LlmConfig } from './config/store';
import { PROMPTS } from './llm/prompts';
import { vaultPaths } from './vault/paths';
import { initAutoUpdater } from './updater';
import { getStatus, setupAll, VaultWatcher } from './vault/setup';
import { NotesSync } from './vault/notesSync';
import { ConversationsWatcher } from './vault/conversationsWatcher';
import { ConversationSummaryWatcher } from './vault/conversationSummaryWatcher';
import { FormsWatcher } from './vault/formsWatcher';
import { MediaLogger } from './media/logger';
import { SentencesLogger } from './capture/sentencesLogger';
import { MediaTranscribeWatcher } from './media/transcribeWatcher';
import { llmCoordinator } from './llm/ollama';

const isDev = process.env.NODE_ENV === 'development';

// Custom protocol so the static-exported Next.js bundle works under
// packaged Electron. The HTML emits root-absolute paths like
// /_next/static/chunks/foo.js — under file:// those resolve to
// file:///_next/... and 404, leaving a blank renderer. Registering
// `app://` lets every asset request resolve relative to `out/`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

function outRoot(): string {
  // dist/electron/main.js -> ../../out (sibling of dist/)
  return path.join(__dirname, '..', '..', 'out');
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname || '/');
      // Strip leading slash for path.join; collapse `..` traversal.
      const normalized = path.normalize(pathname).replace(/^([/\\])+/, '');
      let filePath = path.join(outRoot(), normalized);
      // If the URL ends with `/` (e.g. app://r2/setup/), serve its index.html.
      if (pathname.endsWith('/') || normalized === '' || normalized === '.') {
        filePath = path.join(filePath, 'index.html');
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      console.error('[app-protocol] failed', request.url, err);
      return new Response('Not Found', { status: 404 });
    }
  });
}

let notchWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let configWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let tracker: ActivityTracker | null = null;
let memory: MemoryStore | null = null;
let engine: InterventionEngine | null = null;
let ax: AXHelper | null = null;
let sessions: SessionLogger | null = null;
let conversations: ConversationStore | null = null;
let cancelDiarySchedule: (() => void) | null = null;
let cancelPersonaTrigger: (() => void) | null = null;
let vaultWatcher: VaultWatcher | null = null;
let notesSync: NotesSync | null = null;
let convWatcher: ConversationsWatcher | null = null;
let convSummaryWatcher: ConversationSummaryWatcher | null = null;
let formsWatcher: FormsWatcher | null = null;
let mediaLogger: MediaLogger | null = null;
let sentencesLogger: SentencesLogger | null = null;
let mediaTranscribeWatcher: MediaTranscribeWatcher | null = null;
const lastSiteByPid: Map<number, string> = new Map();
// Fallback URLs scraped by Swift from AXWebArea.AXURL — used when active-win
// can't read the URL (e.g. Comet, future browsers it doesn't know about).
const urlByPid: Map<number, { url: string; ts: number }> = new Map();
let lastCaptureTs = 0;

const EYE_WIN_W = 340;
const EYE_WIN_H = 440;

function createNotchWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  notchWindow = new BrowserWindow({
    width: EYE_WIN_W,
    height: EYE_WIN_H,
    x: workArea.x + workArea.width - EYE_WIN_W - 12,
    y: workArea.y + workArea.height - EYE_WIN_H - 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  notchWindow.setAlwaysOnTop(true, 'floating');
  notchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notchWindow.setIgnoreMouseEvents(true, { forward: true });

  const url = isDev
    ? 'http://localhost:3000'
    : 'app://r2/index.html';

  notchWindow.loadURL(url);

  if (isDev || process.env.R2_DEVTOOLS === '1') {
    notchWindow.webContents.openDevTools({ mode: 'detach' });
  }
  notchWindow.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.error('[notch] did-fail-load', code, desc, validatedURL);
  });
}

function createSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const W = 460;
  const H = 480;
  setupWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + Math.floor((workArea.width - W) / 2),
    y: workArea.y + 80,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  setupWindow.setAlwaysOnTop(true, 'floating');
  setupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const url = isDev
    ? 'http://localhost:3000/setup'
    : 'app://r2/setup/index.html';
  setupWindow.loadURL(url);

  if (process.env.R2_DEVTOOLS === '1') {
    setupWindow.webContents.openDevTools({ mode: 'detach' });
  }
  setupWindow.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.error('[setup] did-fail-load', code, desc, validatedURL);
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function createConfigWindow() {
  if (configWindow) {
    configWindow.focus();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const W = 460;
  const H = 480;
  configWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + Math.floor((workArea.width - W) / 2),
    y: workArea.y + 80,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  configWindow.setAlwaysOnTop(true, 'floating');
  configWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const url = isDev
    ? 'http://localhost:3000/configure'
    : 'app://r2/configure/index.html';
  configWindow.loadURL(url);

  if (process.env.R2_DEVTOOLS === '1') {
    configWindow.webContents.openDevTools({ mode: 'detach' });
  }
  configWindow.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.error('[configure] did-fail-load', code, desc, validatedURL);
  });

  configWindow.on('closed', () => {
    configWindow = null;
  });
}

function setupTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('R2 — ambient companion');
}

// Map a browser URL OR a native app bundle id to an AI site key. Returns
// '' when not an AI chat — empty hint tells the AX helper to clear any prior
// cached hint for that pid.
function detectAiSiteFromUrl(url: string | null, bundleId: string | null): string {
  const u = (url ?? '').toLowerCase();
  const b = (bundleId ?? '').toLowerCase();

  // Native macOS apps (Electron-based). Match bundle IDs first — they're
  // unambiguous regardless of window title.
  if (b === 'com.openai.chat' || b === 'com.openai.chatgpt' || b.startsWith('com.openai.')) return 'chatgpt';
  if (b === 'com.anthropic.claudefordesktop' || b.startsWith('com.anthropic.')) return 'claude';
  if (b.startsWith('com.google.gemini') || b === 'com.google.bard') return 'gemini';
  if (b === 'ai.perplexity.mac' || b.startsWith('ai.perplexity.')) return 'perplexity';

  // Browser URL match (Chrome/Safari/Arc/etc — active-win returns the URL).
  if (u.includes('chatgpt.com') || u.includes('chat.openai.com')) return 'chatgpt';
  if (u.includes('claude.ai')) return 'claude';
  if (u.includes('gemini.google.com')) return 'gemini';
  if (u.includes('perplexity.ai')) return 'perplexity';

  // Loose fallbacks (other Anthropic/OpenAI surfaces, unknown wrappers)
  if (b.includes('chatgpt') || b.includes('openai')) return 'chatgpt';
  if (b.includes('anthropic') || b.includes('claude')) return 'claude';

  return '';
}

function wireIpc() {
  ipcMain.handle('memory:recent', async (_e, limit: number) => memory?.recent(limit ?? 20));
  ipcMain.handle('memory:search', async (_e, q: string) => memory?.search(q));
  ipcMain.handle('messages:recent', async (_e, limit: number) => memory?.recentMessages(limit ?? 50));
  ipcMain.handle('messages:search', async (_e, q: string) => memory?.searchMessages(q));
  ipcMain.handle('tracker:status', async () => tracker?.lastSnapshot());
  ipcMain.handle('intervention:dismiss', async (_e, id: string) => engine?.dismiss(id));
  ipcMain.handle('capture:active', async () => Date.now() - lastCaptureTs < 4000);
  ipcMain.handle('diary:generate', async (_e, date?: string) => {
    return generateDiary({
      vaultDir: path.join(app.getPath('home'), 'R2Vault'),
      date
    });
  });
  ipcMain.handle('diary:catchup', async () => {
    return catchUpMissingDiaries({
      vaultDir: path.join(app.getPath('home'), 'R2Vault')
    });
  });
  ipcMain.handle('persona:snapshot', async () => {
    return generateWeeklySnapshot({
      vaultDir: path.join(app.getPath('home'), 'R2Vault')
    });
  });
  ipcMain.handle('persona:merge', async () => {
    return mergeMonthlyProfile({
      vaultDir: path.join(app.getPath('home'), 'R2Vault')
    });
  });
  ipcMain.handle('forms:scan', async () => {
    // Lazy import to avoid circulars at module init
    const { generateFormNotes } = await import('./llm/forms');
    return generateFormNotes({
      vaultDir: path.join(app.getPath('home'), 'R2Vault')
    });
  });

  // Vault setup IPC
  ipcMain.handle('vault:status', async () => getStatus(vaultPaths()));
  ipcMain.handle('vault:setup', async () => setupAll(vaultPaths()));
  ipcMain.handle('config:get', async () => loadLlmConfig());
  ipcMain.handle('config:save', async (_e, cfg: Partial<LlmConfig>) => {
    // First persist whatever the user typed (verified defaults to false on
    // field change — see saveLlmConfig).
    const saved = saveLlmConfig(cfg);

    // Ping the new config. If it works, mark verified + clear missing flag.
    // If it fails, keep verified=false and report missing so the eye stays
    // red and the configure dialog can show the actual error.
    const ping = await pingLlm({ baseUrl: saved.baseUrl, model: saved.mainModel });
    if (ping.ok) {
      const next = saveLlmConfig({ verified: true });
      llmHealth.clear();
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('config:changed', next);
      }
      return { ok: true, config: next };
    } else {
      llmHealth.reportMissing(saved.mainModel);
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('config:changed', saved);
      }
      return { ok: false, config: saved, error: ping.detail ?? ping.reason };
    }
  });
  ipcMain.on('window:openConfig', () => createConfigWindow());
  ipcMain.on('window:closeConfig', () => {
    configWindow?.close();
    configWindow = null;
  });
  ipcMain.on('window:closeSetup', () => {
    setupWindow?.close();
    setupWindow = null;
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();

  // Register custom protocol BEFORE any window loads its URL.
  registerAppProtocol();

  // Auto-update — packaged builds only; no-op in dev.
  initAutoUpdater();

  memory = new MemoryStore(path.join(app.getPath('userData'), 'memory.db'),
                           path.join(app.getPath('home'), 'R2Vault'));
  await memory.init();

  tracker = new ActivityTracker({ pollMs: 5000, idleMs: 60_000 });
  engine = new InterventionEngine(memory);

  tracker.on('snapshot', (snap) => {
    // Fallback URL from Swift AX scraper when active-win can't read it
    // (Comet, niche Chromium browsers). Only fills missing URLs; never
    // overrides a URL active-win successfully captured.
    if (!snap.url && snap.pid) {
      const cached = urlByPid.get(snap.pid);
      if (cached && Date.now() - cached.ts < 10_000) {
        snap.url = cached.url;
      }
    }
    memory!.recordActivity(snap);
    const candidate = engine!.evaluate(snap);
    if (candidate && notchWindow) {
      notchWindow.webContents.send('intervention', candidate);
    }
    if (notchWindow) {
      notchWindow.webContents.send('cursor', screen.getCursorScreenPoint());
    }
    // Push a site hint to the AX helper based on the active-win URL OR
    // native-app bundle id so it can detect AI chats even when the browser
    // title says nothing about the site.
    if (ax && snap.pid) {
      const site = detectAiSiteFromUrl(snap.url, snap.bundleId);
      // Throttle: only log when site changes for this pid.
      const prev = lastSiteByPid.get(snap.pid) ?? '';
      if (prev !== site) {
        if (site) {
          console.log(`[site-hint] pid=${snap.pid} app=${snap.app} bundle=${snap.bundleId} site=${site}`);
        } else if (prev) {
          console.log(`[site-hint] pid=${snap.pid} cleared (was ${prev})`);
        }
        lastSiteByPid.set(snap.pid, site);
      }
      ax.sendSiteHint(snap.pid, site);
    }
  });

  tracker.start();

  powerMonitor.on('suspend', () => tracker?.pause());
  powerMonitor.on('resume', () => tracker?.start());

  createNotchWindow();
  setupTray();
  wireIpc();

  // Vault folder watcher → broadcast to all open windows
  vaultWatcher = new VaultWatcher(vaultPaths());
  const broadcastStatus = (status: any) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('vault:changed', status);
    }
  };
  vaultWatcher.on('change', (status) => {
    broadcastStatus(status);
    if (status.allReady && setupWindow) {
      // give the renderer ~1.8s to play the confirmation, then close
      setTimeout(() => {
        if (setupWindow) {
          setupWindow.close();
          setupWindow = null;
        }
      }, 1800);
    }
  });
  vaultWatcher.start();

  // One-way mirror: ~/R2Vault/notes/** → ~/Downloads/R2Obsidian/**
  const vp = vaultPaths();
  notesSync = new NotesSync({
    source: path.join(vp.r2Vault, 'notes'),
    dest: vp.r2Obsidian
  });
  notesSync.start();

  // Project-idea extractor: watches R2Vault/conversations/**/*.json
  // and writes Obsidian project notes to R2Vault/notes/projects/.
  convWatcher = new ConversationsWatcher(vp.r2Vault);
  convWatcher.start();

  // AI summary of each conversation → R2Obsidian/conversations/<site>/<chatName>.md
  convSummaryWatcher = new ConversationSummaryWatcher(vp.r2Vault, vp.r2Obsidian);
  convSummaryWatcher.start();
  convSummaryWatcher.catchUpMissing();

  // Forms watcher — detects form/application sessions from sessions JSONs,
  // transcribes via LLM into R2Vault/notes/forms/<formName>.md.
  formsWatcher = new FormsWatcher(vp.r2Vault);
  formsWatcher.start();
  // Boot scan — fills any missing form notes from past days.
  void formsWatcher.runOnce();

  // First-run check — open dedicated setup window if any required folder missing
  const initialStatus = getStatus(vaultPaths());
  if (!initialStatus.allReady) {
    createSetupWindow();
  }
  // Push initial status once windows are ready
  setTimeout(() => broadcastStatus(getStatus(vaultPaths())), 600);

  // AI conversation store — ~/R2Vault/conversations/<site>/<date>.json
  conversations = new ConversationStore(path.join(app.getPath('home'), 'R2Vault'));

  // Start AX capture helper (Swift sidecar)
  ax = new AXHelper(resolveAXBinPath(app.getAppPath()));
  ax.on('message', (m) => {
    // Only store sentences in long-term memory; words are too noisy.
    if (m.kind === 'sentence') {
      memory!.recordMessage(m);
    }
    lastCaptureTs = Date.now();
    // Strict: print only the captured text with a tiny kind tag.
    console.log(`[${m.kind}] ${m.text}`);
    notchWindow?.webContents.send('capture:flash', {
      ts: lastCaptureTs,
      kind: m.kind,
      app: m.app,
      window: m.window,
      text: m.text
    });
  });
  ax.on('urlHint', (h) => {
    if (!h.pid) return;
    if (h.url) {
      urlByPid.set(h.pid, { url: h.url, ts: h.ts });
    } else {
      urlByPid.delete(h.pid);
    }
  });
  ax.on('aiTurn', (t) => {
    const sanitized = sanitizeAiTurn(t);
    conversations?.recordTurn(sanitized);
    sessions?.recordAssistantReply(sanitized);
    const preview = sanitized.assistantText.length > 120
      ? sanitized.assistantText.slice(0, 120) + '…'
      : sanitized.assistantText;
    console.log(`[ai_turn:${sanitized.site}] ${preview}`);
  });
  ax.on('status', (s) => {
    // Surface only actionable status (e.g. permission denied)
    if (s.kind === 'ax_denied') console.log(`[R2] ${s.message ?? 'Accessibility permission required'}`);
    notchWindow?.webContents.send('capture:status', s);
  });
  ax.start();

  // Live session timeline → ~/R2Vault/sessions/YYYY-MM-DD.json
  sessions = new SessionLogger({
    tracker: tracker!,
    ax,
    dir: path.join(app.getPath('home'), 'R2Vault', 'sessions')
  });
  sessions.start();

  // Social media activity logger: ~/R2Vault/media_raw/<site>/<date>.json
  // (Constructed AFTER tracker + ax are alive — both are required by start())
  mediaLogger = new MediaLogger({ rootDir: vp.r2Vault, tracker: tracker!, ax: ax! });
  mediaLogger.start();

  // Sentences logger: ~/Downloads/R2Obsidian/messages_raw/msg-<date>.json
  sentencesLogger = new SentencesLogger({ obsidianDir: vp.r2Obsidian, ax: ax! });
  sentencesLogger.start();

  // Media transcriber: watches media_raw, transcribes JSON → Obsidian md
  // 10 minutes after the FIRST change to each file.
  mediaTranscribeWatcher = new MediaTranscribeWatcher(vp.r2Vault);
  mediaTranscribeWatcher.start();

  // Broadcast LLM busy state to renderer (eye halo blue when busy) and
  // log queue status to terminal on every transition.
  llmCoordinator.on('change', (s: { busy: boolean; current: string | null; pending: number }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('llm:busy', s);
    }
    if (s.busy) {
      console.log(`[llm] busy: ${s.current} (pending: ${s.pending})`);
    } else if (s.pending === 0) {
      console.log(`[llm] idle`);
    }
  });

  // LLM health: missing model events flip the eye red + "INSTALL LLM" tagline.
  llmHealth.on('change', (s: { missing: boolean; models: string[] }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('llm:missing', s);
    }
    if (s.missing) console.log(`[llm] MISSING models: ${s.models.join(', ')} — user must pull or change config`);
  });

  // First-run state: if the user has never verified an LLM config, start the
  // orb red so they know to open Configure. The sentinel "not-configured" is
  // recognized by the renderer to show "CONFIGURE LLM" instead of "INSTALL
  // LLM". Cleared automatically once `config:save` succeeds its ping.
  (() => {
    const cfg = loadLlmConfig();
    if (!cfg.verified) {
      llmHealth.reportMissing('not-configured');
      // Re-emit shortly after window creation in case the renderer wasn't
      // attached when the first emit fired.
      setTimeout(() => {
        if (!cfg.verified) {
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('llm:missing', { missing: true, models: llmHealth.missingModels });
          }
        }
      }, 2000);
    }
  })();

  // Daily Obsidian diary @ 23:50 local — calls local Ollama against today's sessions
  const vaultDir = path.join(app.getPath('home'), 'R2Vault');

  // Pre-warm the diary LLM in the background so the first diary call is fast.
  (async () => {
    const model = process.env.R2_LLM_MODEL ?? PROMPTS.obsidianDiary.model ?? 'qwen2.5:7b';
    const ok = await prewarmLLM(model, { keepAlive: '1h' });
    console.log(`[llm prewarm] ${model} → ${ok ? 'loaded' : 'unavailable (ok)'}`);
  })();

  // Fail-safe: catch up any past-day sessions that lack a diary entry.
  // Runs in background so startup isn't blocked while Ollama works.
  (async () => {
    try {
      const results = await catchUpMissingDiaries({ vaultDir });
      for (const r of results) {
        if (r.ok) {
          console.log(`[diary catchup] wrote ${r.outputPath} (sessions=${r.inputSessions}, ${r.totalDurationMs}ms)`);
        } else {
          console.log(`[diary catchup] skipped ${r.date}: ${r.reason}`);
        }
      }
    } catch (err) {
      console.error('[diary catchup] failed', err);
    }
  })();

  cancelDiarySchedule = scheduleDaily(23, 50, async () => {
    try {
      const result = await generateDiary({ vaultDir });
      if (result.ok) {
        console.log(`[diary] wrote ${result.outputPath} (model=${result.model}, ${result.totalDurationMs}ms, sessions=${result.inputSessions})`);
      } else {
        console.log(`[diary] skipped ${result.date}: ${result.reason}`);
      }
    } catch (err) {
      console.error('[diary] generation failed', err);
    }
  });

  // -------------------- Persona pipeline --------------------

  // Catch-up missing weekly snapshots + monthly merge (background, sequential
  // via the llm coordinator — no need for explicit serialization here).
  (async () => {
    try {
      await catchUpMissingWeeklies({ vaultDir });
    } catch (err) {
      console.error('[persona weekly catchup] failed', err);
    }
    try {
      await catchUpMissingMerge({ vaultDir });
    } catch (err) {
      console.error('[persona merge catchup] failed', err);
    }
  })();

  // Data-driven persona refresh. Polls every 30 min; when signal score
  // (diaries / conv turns / media events / project notes added since last
  // snapshot) crosses 50 AND it's been ≥ 3h since the last snapshot, fires
  // snapshot + profile merge automatically. Replaces old Friday/monthly cron.
  cancelPersonaTrigger = scheduleDataDrivenPersona({
    vaultDir,
    checkIntervalMinutes: 30,
    minCooldownHours: 3,
    threshold: 50
  });

  // Fast cursor stream for eye tracking — independent of tracker poll
  setInterval(() => {
    if (!notchWindow) return;
    notchWindow.webContents.send('cursor', screen.getCursorScreenPoint());
  }, 50);

  // Click-through everywhere except where renderer enables hits
  ipcMain.on('hit-region', (_e, enable: boolean) => {
    notchWindow?.setIgnoreMouseEvents(!enable, { forward: true });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createNotchWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cancelDiarySchedule?.();
  cancelPersonaTrigger?.();
  vaultWatcher?.stop();
  notesSync?.stop();
  convWatcher?.stop();
  convSummaryWatcher?.stop();
  formsWatcher?.stop();
  mediaLogger?.flush();
  sentencesLogger?.stop();
  mediaTranscribeWatcher?.stop();
  sessions?.flush();
  tracker?.stop();
  ax?.stop();
  memory?.close();
});
