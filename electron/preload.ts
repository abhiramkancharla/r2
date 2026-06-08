import { contextBridge, ipcRenderer } from 'electron';

type Point = { x: number; y: number };

export type ActivitySnapshot = {
  ts: number;
  app: string | null;
  title: string | null;
  url: string | null;
  idleSeconds: number;
};

export type Intervention = {
  id: string;
  kind: 'observation' | 'suggestion' | 'recall';
  text: string;
  confidence: number;
  createdAt: number;
};

const api = {
  memory: {
    recent: (limit?: number) => ipcRenderer.invoke('memory:recent', limit),
    search: (q: string) => ipcRenderer.invoke('memory:search', q)
  },
  tracker: {
    status: () => ipcRenderer.invoke('tracker:status')
  },
  intervention: {
    dismiss: (id: string) => ipcRenderer.invoke('intervention:dismiss', id),
    onIncoming: (cb: (i: Intervention) => void): (() => void) => {
      const handler = (_: unknown, payload: Intervention) => cb(payload);
      ipcRenderer.on('intervention', handler);
      return () => {
        ipcRenderer.off('intervention', handler);
      };
    }
  },
  cursor: {
    onMove: (cb: (p: Point) => void): (() => void) => {
      const handler = (_: unknown, p: Point) => cb(p);
      ipcRenderer.on('cursor', handler);
      return () => {
        ipcRenderer.off('cursor', handler);
      };
    }
  },
  window: {
    setHitRegion: (enable: boolean) => ipcRenderer.send('hit-region', enable),
    closeSetup: () => ipcRenderer.send('window:closeSetup')
  },
  capture: {
    isActive: () => ipcRenderer.invoke('capture:active'),
    onFlash: (cb: (e: { ts: number; kind: 'word' | 'sentence'; app: string; window: string; text: string }) => void): (() => void) => {
      const handler = (_: unknown, payload: { ts: number; kind: 'word' | 'sentence'; app: string; window: string; text: string }) => cb(payload);
      ipcRenderer.on('capture:flash', handler);
      return () => {
        ipcRenderer.off('capture:flash', handler);
      };
    },
    onStatus: (cb: (s: { kind: string; [k: string]: unknown }) => void): (() => void) => {
      const handler = (_: unknown, payload: any) => cb(payload);
      ipcRenderer.on('capture:status', handler);
      return () => {
        ipcRenderer.off('capture:status', handler);
      };
    },
    recent: (limit?: number) => ipcRenderer.invoke('messages:recent', limit),
    search: (q: string) => ipcRenderer.invoke('messages:search', q)
  },
  diary: {
    generate: (date?: string) => ipcRenderer.invoke('diary:generate', date),
    catchup: () => ipcRenderer.invoke('diary:catchup')
  },
  persona: {
    snapshot: () => ipcRenderer.invoke('persona:snapshot'),
    merge: () => ipcRenderer.invoke('persona:merge')
  },
  forms: {
    scan: () => ipcRenderer.invoke('forms:scan')
  },
  llm: {
    onBusy: (cb: (s: { busy: boolean; current: string | null; pending: number }) => void): (() => void) => {
      const handler = (_: unknown, payload: { busy: boolean; current: string | null; pending: number }) => cb(payload);
      ipcRenderer.on('llm:busy', handler);
      return () => {
        ipcRenderer.off('llm:busy', handler);
      };
    },
    onMissing: (cb: (s: { missing: boolean; models: string[] }) => void): (() => void) => {
      const handler = (_: unknown, payload: { missing: boolean; models: string[] }) => cb(payload);
      ipcRenderer.on('llm:missing', handler);
      return () => {
        ipcRenderer.off('llm:missing', handler);
      };
    }
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    // Returns `{ ok: true, config }` on a successful save+ping, or
    // `{ ok: false, config, error }` if the test call to the LLM failed.
    // The renderer should use the `ok` flag to decide whether to show a
    // success state and close the window, or display the error inline.
    save: (cfg: {
      mainModel?: string;
      fallbackModel?: string;
      baseUrl?: string;
      embedModel?: string;
      autoLinkVault?: boolean;
    }) =>
      ipcRenderer.invoke('config:save', cfg) as Promise<
        | {
            ok: true;
            config: {
              mainModel: string;
              fallbackModel: string;
              baseUrl: string;
              verified: boolean;
              embedModel: string;
              autoLinkVault: boolean;
            };
            embedOk?: boolean;
            embedDetail?: string;
          }
        | {
            ok: false;
            config: {
              mainModel: string;
              fallbackModel: string;
              baseUrl: string;
              verified: boolean;
              embedModel: string;
              autoLinkVault: boolean;
            };
            error: string;
          }
      >,
    open: () => ipcRenderer.send('window:openConfig'),
    close: () => ipcRenderer.send('window:closeConfig'),
    onChange: (cb: (cfg: { mainModel: string; fallbackModel: string; baseUrl: string }) => void): (() => void) => {
      const handler = (_: unknown, payload: any) => cb(payload);
      ipcRenderer.on('config:changed', handler);
      return () => {
        ipcRenderer.off('config:changed', handler);
      };
    }
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    setup: () => ipcRenderer.invoke('vault:setup'),
    onChange: (cb: (s: { folders: Array<{ key: string; label: string; path: string; exists: boolean }>; allReady: boolean }) => void): (() => void) => {
      const handler = (_: unknown, payload: any) => cb(payload);
      ipcRenderer.on('vault:changed', handler);
      return () => {
        ipcRenderer.off('vault:changed', handler);
      };
    }
  }
};

contextBridge.exposeInMainWorld('r2', api);

export type R2Api = typeof api;
