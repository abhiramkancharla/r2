import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useEffect, useRef } from "react";

type Props = {
  cursor: { x: number; y: number } | null;
  size?: number;
  pupilColor?: string;
  llmBusy?: boolean;
  llmMissing?: boolean;
};

// R2-D2-style photoreceptor lens. Dark gunmetal housing with a recessed
// convex glass lens. Specular highlight rides the lens. Tracking "iris dot"
// shifts with the cursor inside the lens. Lens core color flips with state:
// black idle, amber capturing, rotating sky→deep-blue while LLM busy, deep
// red when configured model is missing.
export function Eye({ cursor, size = 28, pupilColor = '#0a0a0f', llmBusy = false, llmMissing = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const offsetX = useMotionValue(0);
  const offsetY = useMotionValue(0);

  const springX = useSpring(offsetX, { stiffness: 140, damping: 18, mass: 0.6 });
  const springY = useSpring(offsetY, { stiffness: 140, damping: 18, mass: 0.6 });

  const irisX = useTransform(springX, (v) => v);
  const irisY = useTransform(springY, (v) => v);

  useEffect(() => {
    if (!cursor || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const cx = window.screenX + rect.left + rect.width / 2;
    const cy = window.screenY + rect.top + rect.height / 2;
    const dx = cursor.x - cx;
    const dy = cursor.y - cy;
    const dist = Math.hypot(dx, dy);
    const maxOffset = size * 0.18;
    const scale = dist === 0 ? 0 : Math.min(1, dist / 360);
    offsetX.set((dx / (dist || 1)) * maxOffset * scale);
    offsetY.set((dy / (dist || 1)) * maxOffset * scale);
  }, [cursor, size, offsetX, offsetY]);

  // Housing footprint slightly bigger than the lens itself.
  const housingSize = size;
  const lensSize = Math.round(size * 0.82);
  const irisSize = Math.round(lensSize * 0.18);

  const busyGradient =
    'conic-gradient(from 0deg, #7dd3fc, #38bdf8, #0ea5e9, #1d4ed8, #1e1b4b, #1d4ed8, #0ea5e9, #38bdf8, #7dd3fc)';

  // Lens core background based on state. The radial highlight at 30%/25%
  // gives the convex "glass" feel from the R2-D2 reference.
  let lensBg: string;
  if (llmMissing) {
    lensBg = 'radial-gradient(120% 120% at 30% 25%, #fecaca 0%, #ef4444 40%, #7f1d1d 100%)';
  } else if (llmBusy) {
    lensBg = busyGradient;
  } else if (pupilColor === '#f59e0b') {
    // Capturing — warm amber lens.
    lensBg = 'radial-gradient(120% 120% at 30% 25%, #fde68a 0%, #f59e0b 45%, #78350f 100%)';
  } else {
    // Idle — deep black convex glass.
    lensBg = 'radial-gradient(120% 120% at 30% 25%, #3a3d44 0%, #0a0a0f 55%, #000 100%)';
  }

  return (
    <div
      ref={ref}
      className="relative animate-blink origin-center"
      style={{ width: housingSize, height: housingSize }}
    >
      {/* Housing — rounded square gunmetal plate the lens is recessed into. */}
      <div
        className="absolute inset-0"
        style={{
          borderRadius: Math.round(housingSize * 0.18),
          background:
            'linear-gradient(160deg, #3a3d44 0%, #1e2026 45%, #0e1014 100%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 1px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.5)'
        }}
      >
        {/* faint top rim highlight, like brushed metal catching light */}
        <span
          aria-hidden
          className="absolute inset-x-2 top-px h-px bg-white/15"
          style={{ borderRadius: 1 }}
        />
      </div>

      {/* Lens — circular convex glass set into the housing. */}
      <div
        className="absolute rounded-full overflow-hidden"
        style={{
          width: lensSize,
          height: lensSize,
          left: `calc(50% - ${lensSize / 2}px)`,
          top: `calc(50% - ${lensSize / 2}px)`,
          background: lensBg,
          transition: 'background 320ms ease',
          // Recessed ring + outer rim
          boxShadow:
            'inset 0 0 0 1px rgba(0,0,0,0.85), inset 0 2px 4px rgba(0,0,0,0.55), 0 0 0 1.5px #0a0a0f, 0 1px 0 rgba(255,255,255,0.05)'
        }}
      >
        {/* Rotating conic gradient while busy */}
        {llmBusy && !llmMissing && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{ background: busyGradient }}
            animate={{ rotate: 360 }}
            transition={{ duration: 2.4, ease: 'linear', repeat: Infinity }}
          />
        )}

        {/* Iris dot — small bright tracking point that drifts with cursor.
            Sits on top of the rotating gradient via z-index. */}
        <motion.span
          aria-hidden
          className="absolute rounded-full"
          style={{
            width: irisSize,
            height: irisSize,
            left: `calc(50% - ${irisSize / 2}px)`,
            top: `calc(50% - ${irisSize / 2}px)`,
            x: irisX,
            y: irisY,
            background: 'radial-gradient(circle at 30% 30%, #ffffff 0%, #cbd5e1 55%, #475569 100%)',
            boxShadow: '0 0 4px rgba(255,255,255,0.65)',
            zIndex: 2
          }}
        />

        {/* Specular highlight — curved white crescent on top-left edge.
            Built as a tilted ellipse with a soft blur. */}
        <span
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            top: `${Math.round(lensSize * 0.06)}px`,
            left: `${Math.round(lensSize * 0.18)}px`,
            width: `${Math.round(lensSize * 0.55)}px`,
            height: `${Math.round(lensSize * 0.18)}px`,
            background:
              'radial-gradient(50% 100% at 50% 50%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 70%)',
            transform: 'rotate(-22deg)',
            filter: 'blur(0.4px)',
            zIndex: 3
          }}
        />

        {/* Secondary smaller highlight, bottom-right glassy reflection */}
        <span
          aria-hidden
          className="absolute pointer-events-none rounded-full"
          style={{
            bottom: `${Math.round(lensSize * 0.16)}px`,
            right: `${Math.round(lensSize * 0.18)}px`,
            width: `${Math.round(lensSize * 0.12)}px`,
            height: `${Math.round(lensSize * 0.12)}px`,
            background:
              'radial-gradient(circle, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 70%)',
            zIndex: 3
          }}
        />

        {/* Outer red/blue glow when in special states — soft halo INSIDE the
            lens so it doesn't ruin the silhouette. */}
        {(llmMissing || llmBusy) && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              boxShadow: llmMissing
                ? 'inset 0 0 14px rgba(239,68,68,0.55)'
                : 'inset 0 0 14px rgba(56,189,248,0.45)'
            }}
          />
        )}
      </div>
    </div>
  );
}
