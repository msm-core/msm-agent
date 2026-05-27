/**
 * Evolving Adapter — Structured outcome learning from agent task history
 *
 * The evolving layer lets agents improve over time without retraining.
 * After each task the agent records what situation it faced and what worked.
 * Before each task it retrieves similar past situations and injects relevant
 * hints into the system prompt.
 *
 * Ported from Kader's pluggable-evolving-layer-plan.md, simplified for
 * portable use: no MongoDB, no ML service — only the existing MemoryAdapter.
 *
 * Three modes:
 *   off     — total silence. preReason returns [], postOutcome no-ops. (default)
 *   shadow  — writes data after each outcome, never injects. Safe observation.
 *   assist  — writes data AND injects retrieved hints into the prompt.
 *
 * Enable via EVOLVING_MODE env var in the CLI.
 *
 * Providers:
 *   NoneEvolvingAdapter   — off mode. Zero cost, zero side effects.
 *   MemoryEvolvingAdapter — shadow/assist using existing MemoryAdapter.
 */

import type { LoopOutcome } from "../core/types.js";
import type { MemoryAdapter } from "./memory.js";
import type { QualityScore, QualityFlag } from "../core/quality.js";
import { FLAG_STRATEGIES } from "../core/quality.js";

// ─── Contract ─────────────────────────────────────────────────

export type EvolvingMode = "off" | "shadow" | "assist";

export interface EvolvingContext {
  sessionId: string;
  taskId: string;
  /** User message or distilled intent summary used as the situation label */
  situation: string;
  /** Optional workflow type for more granular signal grouping */
  workflowType?: string;
  /** Quality score for this outcome (Phase 13) — passed by agent.ts after scoreOutcome() */
  quality?: QualityScore;
}

export interface EvolvingAdapter {
  readonly mode: EvolvingMode;

  /**
   * Called once per event, BEFORE entering the brain loop.
   *
   * Returns an array of hint strings to inject into the prompt as
   * "past approach" context. Empty array in off/shadow modes.
   *
   * Implementations must never throw — fail open.
   */
  preReason(ctx: EvolvingContext): Promise<string[]>;

  /**
   * Called once per event, AFTER the terminal outcome is produced.
   *
   * Stores a structured evolution event in the backing store.
   * No-op in off mode.
   *
   * Implementations must never throw — fail open.
   */
  postOutcome(ctx: EvolvingContext, outcome: LoopOutcome): Promise<void>;

  /**
   * Optional: analyse accumulated quality signals and write strategy notes to memory.
   * Called on startup (assist mode) to prime the agent with learned advice.
   * Phase 14 — Self-Improving Loop.
   */
  refreshStrategies?(memory: MemoryAdapter): Promise<void>;

  /**
   * Optional: run decay scoring + contradiction resolution over stored strategy notes.
   * Phase 17 — Deeper Evolving Layer.
   * Old/stale strategy notes are pruned; contradictory pairs are resolved by score.
   */
  consolidate?(
    memory: MemoryAdapter,
  ): Promise<import("./evolving-consolidation.js").ConsolidationReport>;

  /** Release any held resources */
  close(): Promise<void>;
}

// ─── NoneEvolvingAdapter (default) ───────────────────────────

/**
 * No-op evolving adapter.
 * Use as the default — zero cost, zero side effects.
 */
export class NoneEvolvingAdapter implements EvolvingAdapter {
  readonly mode: EvolvingMode = "off";

  async preReason(_ctx: EvolvingContext): Promise<string[]> {
    return [];
  }

  async postOutcome(
    _ctx: EvolvingContext,
    _outcome: LoopOutcome,
  ): Promise<void> {}

  async close(): Promise<void> {}
}

// ─── MemoryEvolvingAdapter ────────────────────────────────────

/**
 * Evolving adapter backed by the existing MemoryAdapter.
 *
 * shadow mode — writes evolution events after each outcome; never injects
 * assist mode — writes AND retrieves hints via memory.search()
 *
 * Evolution events are stored as MemoryEntry with source="system" and a
 * JSON-encoded content string that includes situation, outcome, and approach.
 */
export class MemoryEvolvingAdapter implements EvolvingAdapter {
  readonly mode: EvolvingMode;

  constructor(
    private readonly memory: MemoryAdapter,
    mode: EvolvingMode = "shadow",
  ) {
    if (mode === "off") {
      throw new Error(
        "MemoryEvolvingAdapter cannot be used in off mode — use NoneEvolvingAdapter",
      );
    }
    this.mode = mode;
  }

  async preReason(ctx: EvolvingContext): Promise<string[]> {
    if (this.mode !== "assist") return [];
    if (!this.memory.search) return [];

    try {
      const entries = await this.memory.search(ctx.situation, 5);
      const hints: string[] = [];

      // Strategy notes (Phase 14) — retrieved first so they appear at top
      const strategyEntries = entries.filter(
        (e) => e.source === "evolution.strategy",
      );
      for (const e of strategyEntries) {
        hints.push(`[strategy] ${e.content}`);
      }

      // Past evolution events (Phase 10 original behaviour)
      const evolutionEntries = entries.filter((e) => {
        if (e.source === "evolution.strategy") return false;
        try {
          const parsed = JSON.parse(e.content) as Record<string, unknown>;
          return typeof parsed["situation"] === "string";
        } catch {
          return false;
        }
      });

      for (const e of evolutionEntries) {
        try {
          const ev = JSON.parse(e.content) as EvolutionEvent;
          hints.push(formatHint(ev));
        } catch {
          // skip malformed entries
        }
      }

      return hints;
    } catch {
      return [];
    }
  }

  async postOutcome(ctx: EvolvingContext, outcome: LoopOutcome): Promise<void> {
    if (!this.memory.store) return;

    const event: EvolutionEvent = {
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      situation: ctx.situation,
      workflowType: ctx.workflowType,
      outcomeType: outcome.type,
      outcomeText:
        outcome.type === "response"
          ? (outcome as { text?: string }).text?.slice(0, 200)
          : undefined,
      qualityFlags: ctx.quality?.flags,
      recordedAt: new Date().toISOString(),
    };

    try {
      await this.memory.store({
        id: `evo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        content: JSON.stringify(event),
        source: "system",
        confidence: 0.8,
        createdAt: event.recordedAt,
      });
    } catch {
      // fail open — never block the agent
    }
  }

  /**
   * Phase 14 — Self-Improving Loop.
   *
   * Analyses accumulated quality flags from evolution events stored in memory.
   * For each flag that appears in >20% of recent events (min 5 events seen),
   * writes a strategy note that preReason() injects on the next startup.
   *
   * Call on startup (assist mode) in cli.ts.
   */
  async refreshStrategies(memory: MemoryAdapter): Promise<void> {
    if (this.mode !== "assist") return;
    if (!memory.search || !memory.store) return;

    try {
      // Fetch recent evolution entries (broad search term returns recent items)
      const entries = await memory.search("situation outcome", 50);
      const evEntries = entries
        .filter((e) => e.source === "system")
        .map((e) => {
          try {
            return JSON.parse(e.content) as EvolutionEvent;
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is EvolutionEvent =>
            e !== null && Array.isArray(e.qualityFlags),
        );

      if (evEntries.length < 3) return; // not enough data to draw conclusions

      // Count flag frequencies
      const flagCounts: Partial<Record<QualityFlag, number>> = {};
      for (const ev of evEntries) {
        for (const flag of ev.qualityFlags ?? []) {
          flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
        }
      }

      const threshold = Math.max(1, Math.floor(evEntries.length * 0.2));
      const activeFlags = (
        Object.entries(flagCounts) as [QualityFlag, number][]
      )
        .filter(([, count]) => count >= threshold)
        .map(([flag]) => flag);

      if (activeFlags.length === 0) return;

      // Write each active flag's strategy note to memory
      const now = new Date().toISOString();
      for (const flag of activeFlags) {
        const note = FLAG_STRATEGIES[flag];
        await memory
          .store({
            id: `strategy-${flag}-${Date.now()}`,
            content: note,
            source: "evolution.strategy",
            confidence: 0.9,
            createdAt: now,
          })
          .catch(() => {});
      }
    } catch {
      // fail open — strategy refresh is best-effort
    }
  }

  /**
   * Phase 17 — Deeper Evolving Layer: decay + contradiction resolution.
   * Delegates to consolidateStrategies() from evolving-consolidation.ts.
   */
  async consolidate(
    memory: MemoryAdapter,
  ): Promise<import("./evolving-consolidation.js").ConsolidationReport> {
    const { consolidateStrategies } =
      await import("./evolving-consolidation.js");
    return consolidateStrategies(memory);
  }

  async close(): Promise<void> {}
}

// ─── Internal types ───────────────────────────────────────────

interface EvolutionEvent {
  sessionId: string;
  taskId: string;
  situation: string;
  workflowType?: string;
  outcomeType: LoopOutcome["type"];
  outcomeText?: string;
  /** Quality flags from scoreOutcome() — undefined for pre-Phase-13 entries */
  qualityFlags?: QualityFlag[];
  recordedAt: string;
}

function formatHint(ev: EvolutionEvent): string {
  const outcome = ev.outcomeText
    ? `${ev.outcomeType}: "${ev.outcomeText}"`
    : ev.outcomeType;
  return `[past approach] Situation: "${ev.situation.slice(0, 120)}" → ${outcome}`;
}
