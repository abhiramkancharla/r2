import { randomUUID } from 'crypto';
import type { ActivitySnapshot } from '../tracker/activity';
import type { MemoryStore } from '../memory/store';

export type Intervention = {
  id: string;
  kind: 'observation' | 'suggestion' | 'recall';
  text: string;
  confidence: number;
  createdAt: number;
};

// 95% silent target. Heuristics only — no LLM.
export class InterventionEngine {
  private memory: MemoryStore;
  private lastFiredAt = 0;
  private dismissed = new Set<string>();
  private cooldownMs = 5 * 60_000;
  private sameAppStreak = { app: '', count: 0 };

  constructor(memory: MemoryStore) {
    this.memory = memory;
  }

  evaluate(snap: ActivitySnapshot): Intervention | null {
    const now = snap.ts;
    if (now - this.lastFiredAt < this.cooldownMs) return null;

    // Track same-app streak
    if (snap.app && snap.app === this.sameAppStreak.app) {
      this.sameAppStreak.count += 1;
    } else {
      this.sameAppStreak = { app: snap.app ?? '', count: 1 };
    }

    // Heuristic 1: long YouTube/Netflix scroll → likely bored
    const title = (snap.title ?? '').toLowerCase();
    const url = (snap.url ?? '').toLowerCase();
    const isDistraction = /youtube|netflix|reddit|tiktok|instagram/.test(title + url);
    if (isDistraction && this.sameAppStreak.count >= 15) {
      return this.fire({
        kind: 'observation',
        text: 'You\'ve been here a while. Want a nudge back to what you were doing earlier?',
        confidence: 0.6
      });
    }

    // Heuristic 2: long idle (>10 min) after activity → quiet welcome back not fired here
    // (handled on resume separately)

    // Heuristic 3: same focused app >45 min straight → deep work observation
    if (snap.app && !isDistraction && this.sameAppStreak.count >= 540 /* 540 * 5s = 45 min */) {
      return this.fire({
        kind: 'observation',
        text: `Deep work in ${snap.app} for a while. Looking good.`,
        confidence: 0.5
      });
    }

    return null;
  }

  private fire(partial: Omit<Intervention, 'id' | 'createdAt'>): Intervention {
    const iv: Intervention = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...partial
    };
    this.lastFiredAt = iv.createdAt;
    return iv;
  }

  dismiss(id: string) {
    this.dismissed.add(id);
  }
}
