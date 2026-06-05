import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Eye } from '@/components/Eye';
import { ActionPanel } from '@/components/ActionPanel';
import type { R2Api } from '../../electron/preload';

declare global {
  interface Window {
    r2?: R2Api;
  }
}

type Intervention = {
  id: string;
  kind: string;
  text: string;
  confidence: number;
  createdAt: number;
};

const EYE_SIZE = 56;

export default function EyeOrb() {
  const [intervention, setIntervention] = useState<Intervention | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoverOn, setHoverOn] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [lastCapture, setLastCapture] = useState<{ app: string; text: string; kind: 'word' | 'sentence' } | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmMissing, setLlmMissing] = useState<{ missing: boolean; models: string[] }>({ missing: false, models: [] });
  const hoverCloseTimer = useRef<number | null>(null);
  const openHover = () => {
    if (hoverCloseTimer.current) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setHoverOn(true);
  };
  const closeHover = () => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => setHoverOn(false), 160);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !window.r2) return;
    const offIv = window.r2.intervention.onIncoming((i) => {
      setIntervention(i as Intervention);
      setTimeout(() => setIntervention(null), 14_000);
    });
    const offCursor = window.r2.cursor.onMove((p) => setCursor(p));
    const offFlash = window.r2.capture.onFlash((e) => {
      setCapturing(true);
      setLastCapture({ app: e.app, text: e.text, kind: e.kind });
      window.setTimeout(() => setCapturing(false), 1600);
      window.setTimeout(() => setLastCapture(null), e.kind === 'sentence' ? 6000 : 2500);
    });
    const offBusy = window.r2.llm.onBusy((s) => setLlmBusy(!!s.busy));
    const offMissing = window.r2.llm.onMissing?.((s) => setLlmMissing(s)) ?? (() => {});
    const offStatus = window.r2.capture.onStatus((s) => {
      if (s.kind === 'ax_denied') {
        setStatusMessage('Enable Accessibility for R2 in System Settings to capture messages.');
      } else if (s.kind === 'ax_ok') {
        setStatusMessage(null);
      }
    });
    return () => {
      offIv();
      offCursor();
      offFlash();
      offStatus();
      offBusy();
      offMissing();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.r2) return;
    // Hit region active whenever any interactive element is showing.
    window.r2.window.setHitRegion(hoverOn || !!intervention || !!lastCapture);
  }, [hoverOn, intervention, lastCapture]);

  const dismiss = () => {
    if (intervention && typeof window !== 'undefined' && window.r2) {
      window.r2.intervention.dismiss(intervention.id);
    }
    setIntervention(null);
  };

  const subtitle = llmMissing.missing
    ? `INSTALL LLM — ${llmMissing.models.join(', ')}`
    : statusMessage ??
      (llmBusy ? 'thinking…' : capturing ? 'capturing…' : 'R2 — watching, quietly');

  return (
    <>
      <Head>
        <title>R2</title>
      </Head>
      <main className="w-screen h-screen overflow-hidden bg-transparent flex items-end justify-end p-3 relative">
        {/* Hover-targeted only: the eye and the panel toggle hoverOn via
            their own enter/leave handlers (with a tiny grace delay so the
            cursor can travel from eye to panel without flicker). No phantom
            buffer above. */}
        <div className="relative pointer-events-auto">
          {/* Intervention bubble — still absolute above so it doesn't
              shove the eye row around. */}
          <AnimatePresence>
            {intervention && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className="absolute bottom-[110px] right-0 w-[268px] text-white text-sm p-3 border border-white/18"
                style={{ background: 'rgba(8,10,14,0.78)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }}
              >
                <p className="leading-snug">{intervention.text}</p>
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="ghost" onClick={dismiss}>
                    dismiss
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Action panel: command grid — still absolute above the eye row.
              Has its own enter/leave so cursor can travel into it. */}
          <ActionPanel
            visible={hoverOn}
            llmBusy={llmBusy}
            onMouseEnter={openHover}
            onMouseLeave={closeHover}
          />

          {/* Bottom row: left = stacked notifications (tagline + capture
              preview), right = eye. Tagline + capture sit to the LEFT of
              the eye instead of above it. */}
          <div className="flex items-end justify-end gap-2.5 pr-1">
            <div className="flex flex-col items-end gap-1.5 max-w-[240px]">
              <AnimatePresence>
                {lastCapture && (
                  <motion.div
                    key="capture-preview"
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    className="text-white text-xs px-2.5 py-1.5 border border-amber-300/40 max-w-full"
                    style={{ background: 'rgba(8,10,14,0.78)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }}
                  >
                    <div
                      className="text-[9.5px] uppercase text-amber-300/90 mb-0.5"
                      style={{ letterSpacing: '0.18em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    >
                      {lastCapture.kind} · {lastCapture.app}
                    </div>
                    <div className="leading-snug whitespace-pre-wrap break-words text-[11.5px] text-right">
                      {lastCapture.text.length > 180
                        ? lastCapture.text.slice(0, 180) + '…'
                        : lastCapture.text}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {(hoverOn || llmBusy || capturing || statusMessage || llmMissing.missing) && (
                  <motion.div
                    key="tagline"
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={{ duration: 0.18 }}
                    className="px-2.5 py-1.5 text-[9.5px] text-white/85 border border-white/15 max-w-full text-right whitespace-nowrap"
                    style={{
                      background: 'rgba(8,10,14,0.7)',
                      backdropFilter: 'blur(14px)',
                      WebkitBackdropFilter: 'blur(14px)',
                      letterSpacing: '0.18em',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
                    }}
                  >
                    {subtitle.toUpperCase()}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Eye — clean, no halo. Hover here opens the menu. */}
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              animate={
                llmBusy
                  ? { scale: [1, 1.03, 1], transition: { duration: 2.6, repeat: Infinity, ease: 'easeInOut' } }
                  : { scale: 1 }
              }
              onMouseEnter={openHover}
              onMouseLeave={closeHover}
              className="outline-none cursor-pointer bg-transparent border-0 p-0 shrink-0"
              aria-label="R2 eye"
            >
              <Eye
                cursor={cursor}
                size={EYE_SIZE}
                pupilColor={capturing ? '#f59e0b' : '#0a0a0f'}
                llmBusy={llmBusy}
                llmMissing={llmMissing.missing}
              />
            </motion.button>
          </div>
        </div>
      </main>
    </>
  );
}
