import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Check, Folder, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Folder = { key: string; label: string; path: string; exists: boolean };
type Status = { folders: Folder[]; allReady: boolean };

type Props = {
  fullWindow?: boolean;
};

export function SetupCard({ fullWindow = false }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [visible, setVisible] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.r2?.vault) return;
    let mounted = true;
    window.r2.vault.status().then((s: Status) => {
      if (!mounted) return;
      setStatus(s);
      setVisible(!s.allReady);
    });
    const off = window.r2.vault.onChange((s: Status) => {
      setStatus(s);
      if (s.allReady) {
        setDone(true);
        window.setTimeout(() => {
          setVisible(false);
          if (fullWindow) window.r2?.window?.closeSetup?.();
        }, 1400);
      }
    });
    return () => {
      mounted = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grant = async () => {
    if (!window.r2?.vault || running) return;
    setError(null);
    setRunning(true);
    try {
      const s: Status = await window.r2.vault.setup();
      setStatus(s);
      if (s.allReady) {
        setDone(true);
        window.setTimeout(() => {
          setVisible(false);
          if (fullWindow) window.r2?.window?.closeSetup?.();
        }, 1400);
      } else {
        setError('R2 could not create one or more folders. Check disk permissions.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Setup failed. Check disk permissions.');
    } finally {
      setRunning(false);
    }
  };

  const totalReady = status?.folders.filter((f) => f.exists).length ?? 0;
  const total = status?.folders.length ?? 0;

  return (
    <AnimatePresence>
      {visible && status && (
        <motion.div
          key="setup"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'pointer-events-auto w-[420px] relative',
            fullWindow ? 'mt-2' : 'absolute top-3 right-3'
          )}
          style={{
            background: 'rgba(8,10,14,0.78)',
            backdropFilter: 'blur(20px) saturate(140%)',
            WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            border: '1px solid rgba(255,255,255,0.18)'
          }}
        >
          {/* Corner ticks — HUD frame */}
          <CornerTicks />

          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-white/10">
            <div className="flex items-center justify-between">
              <span
                className="text-[10px] text-white/85"
                style={{ letterSpacing: '0.24em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              >
                R2 / SYSTEM SETUP
              </span>
              <span
                className="text-[10px] tabular-nums text-white/40"
                style={{ letterSpacing: '0.18em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              >
                {totalReady}/{total}
              </span>
            </div>
            <h2
              className="mt-2 text-[14px] text-white"
              style={{ letterSpacing: '0.06em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            >
              {done ? 'PERMISSIONS GRANTED. INITIALIZED.' : 'PERMISSIONS REQUIRED'}
            </h2>
            <p className="mt-1.5 text-[11px] leading-relaxed text-white/55">
              {done
                ? 'Vault structures present. R2 is online.'
                : 'R2 cannot run without filesystem access to your home directory and Downloads. Grant access to provision the vault structures.'}
            </p>
          </div>

          {/* Folder list */}
          <ul className="px-4 py-3 space-y-2 border-b border-white/10">
            {status.folders.map((f) => (
              <FolderRow key={f.key} folder={f} />
            ))}
          </ul>

          {/* Error strip */}
          {error && (
            <div className="px-4 py-2 border-b border-rose-300/30 bg-rose-500/10 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-300 mt-px shrink-0" strokeWidth={1.6} />
              <span
                className="text-[10.5px] text-rose-200/90"
                style={{ letterSpacing: '0.06em' }}
              >
                {error}
              </span>
            </div>
          )}

          {/* CTA */}
          <div className="p-3">
            {done ? (
              <div className="flex items-center justify-center gap-2 py-2">
                <Check className="w-3.5 h-3.5 text-emerald-300" strokeWidth={1.8} />
                <span
                  className="text-[10.5px] text-emerald-300/90"
                  style={{ letterSpacing: '0.2em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                >
                  ALL FOLDERS DETECTED
                </span>
              </div>
            ) : (
              <motion.button
                onClick={grant}
                disabled={running}
                whileTap={{ scale: 0.98 }}
                className={cn(
                  'group relative w-full h-10 flex items-center justify-center gap-2',
                  'border border-white/30 hover:border-white/55',
                  'bg-white/[0.05] hover:bg-white/[0.10]',
                  'transition-colors text-white',
                  'disabled:opacity-50 disabled:cursor-not-allowed outline-none'
                )}
                style={{ letterSpacing: '0.24em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              >
                {running ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.6} />
                    <span className="text-[11px]">CREATING…</span>
                  </>
                ) : (
                  <span className="text-[11px]">GRANT &amp; INITIALIZE</span>
                )}
                {/* edge hairline on hover */}
                <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/30 opacity-0 group-hover:opacity-100 transition-opacity" />
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-white/30 opacity-0 group-hover:opacity-100 transition-opacity" />
              </motion.button>
            )}
            <p className="mt-2 text-[9px] text-white/35 text-center" style={{ letterSpacing: '0.14em' }}>
              ~/R2Vault &nbsp;·&nbsp; ~/Downloads/R2Obsidian
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
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

function FolderRow({ folder }: { folder: Folder }) {
  return (
    <li className="flex items-center gap-2.5">
      <StatusDot exists={folder.exists} />
      <Folder className="w-3 h-3 text-white/35" strokeWidth={1.6} />
      <div className="flex-1 min-w-0">
        <div
          className="text-[10.5px] text-white/90 leading-tight truncate"
          style={{ letterSpacing: '0.12em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
        >
          {folder.label.toUpperCase()}
        </div>
        <div className="text-[9.5px] text-white/35 font-mono truncate mt-px">{folder.path}</div>
      </div>
      <span
        className="text-[9px] text-white/40 ml-2"
        style={{ letterSpacing: '0.18em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        {folder.exists ? 'OK' : '—'}
      </span>
    </li>
  );
}

function StatusDot({ exists }: { exists: boolean }) {
  return (
    <span className="relative flex items-center justify-center w-3 h-3 shrink-0">
      <motion.span
        animate={{
          backgroundColor: exists ? '#34d399' : 'rgba(255,255,255,0.25)'
        }}
        transition={{ duration: 0.3 }}
        className="w-1.5 h-1.5"
        style={{ boxShadow: exists ? '0 0 6px rgba(52,211,153,0.55)' : 'none' }}
      />
      {!exists && (
        <motion.span
          className="absolute w-3 h-3 border border-amber-300/50"
          animate={{ opacity: [0.4, 0, 0.4] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </span>
  );
}
