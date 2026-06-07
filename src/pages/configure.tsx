import Head from 'next/head';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Check, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type LlmConfig = { mainModel: string; fallbackModel: string; baseUrl: string; verified?: boolean };

export default function ConfigurePage() {
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).r2?.config) return;
    (window as any).r2.config.get().then((c: LlmConfig) => setCfg(c));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfg) return;
    setErr(null);
    setSaved(false);
    setSaving(true);
    try {
      // Save now pings the LLM; result indicates whether it worked.
      const result = await (window as any).r2.config.save(cfg);
      if (result && result.ok) {
        setCfg(result.config);
        setSaved(true);
        window.setTimeout(() => {
          (window as any).r2.config.close();
        }, 900);
      } else {
        if (result?.config) setCfg(result.config);
        setErr(result?.error ?? 'Could not reach the LLM with that configuration.');
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const close = () => (window as any).r2?.config?.close();

  return (
    <>
      <Head><title>R2 — Configure</title></Head>
      <main className="w-screen h-screen overflow-hidden bg-transparent flex items-start justify-center p-2">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="relative w-[420px] mt-2"
          style={{
            background: 'rgba(8,10,14,0.82)',
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            border: '1px solid rgba(255,255,255,0.18)'
          }}
        >
          <CornerTicks />
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-white/10 flex items-center justify-between">
            <span
              className="text-[10px] text-white/85"
              style={{ letterSpacing: '0.24em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            >
              R2 / CONFIGURE
            </span>
            <button
              onClick={close}
              className="text-white/40 hover:text-white/80 transition"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.6} />
            </button>
          </div>

          {!cfg ? (
            <div className="p-6 flex justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-white/50" />
            </div>
          ) : (
            <form onSubmit={submit} className="p-4 space-y-4">
              <Field
                label="MAIN MODEL"
                hint="Bigger / preferred. Tried first. e.g. qwen2.5:14b"
                value={cfg.mainModel}
                onChange={(v) => setCfg({ ...cfg, mainModel: v })}
              />
              <Field
                label="FALLBACK MODEL"
                hint="Smaller. Used if main fails. e.g. qwen2.5:7b"
                value={cfg.fallbackModel}
                onChange={(v) => setCfg({ ...cfg, fallbackModel: v })}
              />
              <Field
                label="OLLAMA URL"
                hint="Port-only OK (11434). Full URL also accepted."
                value={cfg.baseUrl}
                onChange={(v) => setCfg({ ...cfg, baseUrl: v })}
              />

              {err && (
                <div className="border border-rose-300/40 bg-rose-500/10 px-3 py-2 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-300 mt-px shrink-0" strokeWidth={1.6} />
                  <span className="text-[10.5px] text-rose-200/90" style={{ letterSpacing: '0.06em' }}>{err}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <motion.button
                  type="submit"
                  disabled={saving || !cfg.mainModel || !cfg.fallbackModel}
                  whileTap={{ scale: 0.98 }}
                  className={cn(
                    'flex-1 h-10 flex items-center justify-center gap-2',
                    'border border-white/30 hover:border-white/55',
                    'bg-white/[0.05] hover:bg-white/[0.10] text-white',
                    'transition-colors outline-none',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                  style={{ letterSpacing: '0.22em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                >
                  {saved ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-300" strokeWidth={1.8} />
                      <span className="text-[10.5px]">SAVED</span>
                    </>
                  ) : saving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.6} />
                      <span className="text-[10.5px]">SAVING…</span>
                    </>
                  ) : (
                    <span className="text-[10.5px]">SAVE</span>
                  )}
                </motion.button>
                <button
                  type="button"
                  onClick={close}
                  className="h-10 px-3 text-[10.5px] text-white/60 hover:text-white/90 border border-white/15 hover:border-white/30 transition"
                  style={{ letterSpacing: '0.22em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                >
                  CANCEL
                </button>
              </div>

              <p className="text-[9.5px] text-white/35" style={{ letterSpacing: '0.12em' }}>
                Models must be pulled in Ollama beforehand (e.g. <code>ollama pull qwen2.5:14b</code>). On main-model failure (RAM/missing/transport), R2 retries with fallback.
              </p>
            </form>
          )}
        </motion.div>
      </main>
    </>
  );
}

function Field({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <div
        className="text-[10px] text-white/75 mb-1.5"
        style={{ letterSpacing: '0.2em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        {label}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="w-full px-3 py-2 text-[12px] text-white bg-black/40 border border-white/15 focus:border-white/45 outline-none font-mono"
      />
      <div className="text-[9.5px] text-white/35 mt-1" style={{ letterSpacing: '0.06em' }}>{hint}</div>
    </label>
  );
}

function CornerTicks() {
  const t = 'absolute w-3 h-3 border-white/55';
  return (
    <>
      <span className={cn(t, 'top-0 left-0 border-t border-l')} />
      <span className={cn(t, 'top-0 right-0 border-t border-r')} />
      <span className={cn(t, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(t, 'bottom-0 right-0 border-b border-r')} />
    </>
  );
}
