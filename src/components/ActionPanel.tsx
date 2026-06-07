import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpenText,
  Sparkles,
  UserRoundCog,
  ClipboardList,
  RefreshCcw,
  Settings2,
  Loader2,
  Check,
  X as XIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ActionKey = 'diary' | 'diaryCatchup' | 'personaSnapshot' | 'personaMerge' | 'formsScan' | 'configure';

type Status = 'idle' | 'running' | 'ok' | 'err';

type ActionDef = {
  key: ActionKey;
  label: string;
  hint: string;
  Icon: typeof BookOpenText;
  run: () => Promise<any>;
};

type Props = {
  visible: boolean;
  llmBusy: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

export function ActionPanel({ visible, llmBusy, onMouseEnter, onMouseLeave }: Props) {
  const [statuses, setStatuses] = useState<Partial<Record<ActionKey, Status>>>({});

  const set = (k: ActionKey, s: Status) =>
    setStatuses((prev) => ({ ...prev, [k]: s }));

  const actions: ActionDef[] = [
    {
      key: 'diary',
      label: 'DIARY',
      hint: 'today',
      Icon: BookOpenText,
      run: () => window.r2!.diary.generate()
    },
    {
      key: 'diaryCatchup',
      label: 'BACKFILL',
      hint: 'past days',
      Icon: RefreshCcw,
      run: () => window.r2!.diary.catchup()
    },
    {
      key: 'personaSnapshot',
      label: 'SNAPSHOT',
      hint: 'persona',
      Icon: Sparkles,
      run: () => window.r2!.persona.snapshot()
    },
    {
      key: 'personaMerge',
      label: 'PROFILE',
      hint: 'merge',
      Icon: UserRoundCog,
      run: () => window.r2!.persona.merge()
    },
    {
      key: 'formsScan',
      label: 'FORMS',
      hint: 'scan',
      Icon: ClipboardList,
      run: () => window.r2!.forms.scan()
    },
    {
      key: 'configure',
      label: 'CONFIGURE',
      hint: 'models / port',
      Icon: Settings2,
      run: async () => {
        // Window-opening action — no LLM call, no status tracking needed.
        window.r2!.config.open();
        return { ok: true };
      }
    }
  ];

  const handleClick = async (a: ActionDef) => {
    if (!window.r2) return;
    if (statuses[a.key] === 'running') return;
    set(a.key, 'running');
    try {
      const r = await a.run();
      const ok = Array.isArray(r) ? r.some((x: any) => x?.ok) || r.length === 0 : r?.ok !== false;
      set(a.key, ok ? 'ok' : 'err');
    } catch {
      set(a.key, 'err');
    }
    window.setTimeout(() => set(a.key, 'idle'), 2400);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="action-panel"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          className="pointer-events-auto absolute bottom-[92px] right-2 w-[268px]"
        >
          {/* Outer frame — sharp, thin, HUD-style */}
          <div
            className="relative"
            style={{
              background: 'rgba(8,10,14,0.72)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              border: '1px solid rgba(255,255,255,0.18)'
            }}
          >
            {/* Corner ticks */}
            <CornerTicks />

            {/* Header row */}
            <div className="flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-white/8">
              <span
                className="text-[9.5px] text-white/85"
                style={{ letterSpacing: '0.22em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              >
                R2 / ACTIONS
              </span>
              <span className="flex items-center gap-1 text-[9px] text-white/40" style={{ letterSpacing: '0.16em' }}>
                {llmBusy ? (
                  <>
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    <span>LLM</span>
                  </>
                ) : (
                  <span>IDLE</span>
                )}
              </span>
            </div>

            {/* Tile grid */}
            <div className="grid grid-cols-2 gap-px bg-white/5">
              {actions.map((a) => (
                <ActionTile
                  key={a.key}
                  action={a}
                  status={statuses[a.key] ?? 'idle'}
                  onClick={() => handleClick(a)}
                />
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CornerTicks() {
  // Four small "L" tick marks at each corner. Subtle, HUD feel.
  const tickClasses = 'absolute w-2.5 h-2.5 border-white/55';
  return (
    <>
      <span className={cn(tickClasses, 'top-0 left-0 border-t border-l')} />
      <span className={cn(tickClasses, 'top-0 right-0 border-t border-r')} />
      <span className={cn(tickClasses, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(tickClasses, 'bottom-0 right-0 border-b border-r')} />
    </>
  );
}

function ActionTile({
  action,
  status,
  onClick
}: {
  action: ActionDef;
  status: Status;
  onClick: () => void;
}) {
  const { label, hint, Icon } = action;
  const isRunning = status === 'running';
  const isOk = status === 'ok';
  const isErr = status === 'err';

  return (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.98 }}
      className={cn(
        'group relative h-[58px] px-2.5 py-2 text-left transition-colors',
        'bg-black/50 hover:bg-white/[0.05] focus:bg-white/[0.06]',
        'outline-none'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center justify-center w-5 h-5 border',
            isOk ? 'border-emerald-300/40 text-emerald-300' :
            isErr ? 'border-rose-300/40 text-rose-300' :
            isRunning ? 'border-white/40 text-white/85' :
            'border-white/25 text-white/85'
          )}
          style={{ borderRadius: 0 }}
        >
          {isRunning ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
          ) : isOk ? (
            <Check className="w-3 h-3" strokeWidth={1.75} />
          ) : isErr ? (
            <XIcon className="w-3 h-3" strokeWidth={1.75} />
          ) : (
            <Icon className="w-3 h-3" strokeWidth={1.5} />
          )}
        </span>
        <div className="min-w-0 leading-tight">
          <div
            className="text-[10px] text-white/90"
            style={{ letterSpacing: '0.18em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          >
            {label}
          </div>
          <div className="text-[9px] text-white/35 mt-0.5" style={{ letterSpacing: '0.1em' }}>
            {hint.toUpperCase()}
          </div>
        </div>
      </div>
      {/* hover hairline at top edge */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/15 opacity-0 group-hover:opacity-100 transition-opacity" />
    </motion.button>
  );
}
