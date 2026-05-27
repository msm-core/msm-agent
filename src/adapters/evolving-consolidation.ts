/**
 * Evolving Layer Consolidation — Phase 17
 *
 * Upgrades the flat memory injection pattern to a weighted signal graph
 * with decay and contradiction detection.
 *
 * Three mechanisms:
 *
 * 1. DECAY
 *    Strategy notes gain a decayScore based on age and recency of
 *    supporting evidence. Notes with decayScore < DECAY_PRUNE_THRESHOLD
 *    are deleted from memory.
 *
 *    decayScore = supportingEventCount / (daysSinceLastEvidence + 1)
 *                 × recencyWeight (1.0 if < 7 days, 0.5 if < 30, 0.1 otherwise)
 *
 * 2. CONTRADICTION DETECTION
 *    When two strategy notes contain opposing keywords (defined in
 *    CONTRADICTION_PAIRS), keep the one with the higher decayScore and
 *    mark the other for deletion.
 *
 * 3. WEIGHTED OUTCOMES
 *    The weight of a quality signal scales with task complexity:
 *    more tools used and more iterations → signal counted more heavily
 *    when refreshStrategies() computes flag frequency thresholds.
 *
 *    weight = 1 + log(toolCount + 1) + (maxIterations / actualIterations)
 *
 * Usage (cli.ts — assist mode):
 *
 *   // On startup, refresh strategies first, then consolidate stale signals
 *   await evolvingAdapter.refreshStrategies(memory);
 *   await evolvingAdapter.consolidate?.(memory);
 */

import type { MemoryAdapter } from "./memory.js";

// ─── Types ────────────────────────────────────────────────────

export interface ConsolidationReport {
  /** Number of strategy notes that were too stale and removed */
  pruned: number;
  /** Number of contradiction pairs resolved (lower-scored note removed) */
  contradictionsResolved: number;
  /** Timestamp when consolidate() ran */
  consolidatedAt: string;
}

export interface SignalEdge {
  /** Summarised situation label from EvolvingContext.situation */
  situation: string;
  /** outcomeType from the LoopOutcome */
  outcomeType: string;
  /** Task complexity weight applied at record time */
  weight: number;
  /** ISO timestamp when this event was recorded */
  recordedAt: string;
}

export interface SignalGraph {
  edges: SignalEdge[];
  consolidatedAt: string;
}

// ─── Constants ────────────────────────────────────────────────

/** Decay score below which a strategy note is pruned */
export const DECAY_PRUNE_THRESHOLD = 0.1;

/** Keyword pairs that indicate contradictory strategies */
export const CONTRADICTION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ask clarifying questions", "respond directly"],
  ["multi-step planning", "direct tool calls"],
  ["detailed explanation", "concise response"],
] as const;

// ─── Decay scoring ────────────────────────────────────────────

/**
 * Compute a decay score for a strategy note.
 *
 * @param supportingEventCount - number of quality events backing this strategy
 * @param daysSinceLastEvidence - how many days since the most recent supporting event
 * @returns decay score in [0, ∞) — higher = stronger / more relevant
 */
export function computeDecayScore(
  supportingEventCount: number,
  daysSinceLastEvidence: number,
): number {
  const recencyWeight =
    daysSinceLastEvidence < 7 ? 1.0 : daysSinceLastEvidence < 30 ? 0.5 : 0.1;
  return (supportingEventCount / (daysSinceLastEvidence + 1)) * recencyWeight;
}

// ─── Task complexity weight ───────────────────────────────────

/**
 * Compute the signal weight for a task based on its complexity.
 * More complex tasks produce higher-weighted quality signals.
 *
 * @param toolCount - number of tool calls made during the task
 * @param maxIterations - the agent's configured iteration limit
 * @param actualIterations - how many iterations the task actually ran
 * @returns weight ≥ 1
 */
export function computeTaskWeight(
  toolCount: number,
  maxIterations: number,
  actualIterations: number,
): number {
  const iterationFactor =
    actualIterations > 0 ? maxIterations / actualIterations : 1;
  return 1 + Math.log(toolCount + 1) + iterationFactor;
}

// ─── Contradiction detection ──────────────────────────────────

/**
 * Check if two strategy note contents are contradictory.
 * Uses substring matching against CONTRADICTION_PAIRS.
 */
export function areContradictory(contentA: string, contentB: string): boolean {
  const a = contentA.toLowerCase();
  const b = contentB.toLowerCase();
  for (const [keyword1, keyword2] of CONTRADICTION_PAIRS) {
    if (
      (a.includes(keyword1) && b.includes(keyword2)) ||
      (a.includes(keyword2) && b.includes(keyword1))
    ) {
      return true;
    }
  }
  return false;
}

// ─── Consolidation ────────────────────────────────────────────

/**
 * Parsed representation of a strategy note stored in memory.
 * Strategy notes are written by MemoryEvolvingAdapter.refreshStrategies()
 * with source = "evolution.strategy".
 */
interface StrategyNote {
  id: string;
  content: string;
  /** Decay score computed from supporting event count and age */
  decayScore: number;
}

/**
 * Run decay + contradiction resolution over all strategy notes in memory.
 *
 * 1. Fetch all evolution.strategy entries
 * 2. Compute decay score for each (approximated from creation date)
 * 3. Remove notes below DECAY_PRUNE_THRESHOLD
 * 4. Among remaining notes, detect and resolve contradictions
 *
 * @returns a ConsolidationReport summarising what was removed
 */
export async function consolidateStrategies(
  memory: MemoryAdapter,
): Promise<ConsolidationReport> {
  if (!memory.search)
    return {
      pruned: 0,
      contradictionsResolved: 0,
      consolidatedAt: new Date().toISOString(),
    };
  // Fetch all strategy entries
  const entries = await memory.search("evolution strategy", 200);
  const strategyEntries = entries.filter((e) =>
    e.source?.startsWith("evolution.strategy"),
  );

  if (strategyEntries.length === 0) {
    return {
      pruned: 0,
      contradictionsResolved: 0,
      consolidatedAt: new Date().toISOString(),
    };
  }

  let pruned = 0;
  let contradictionsResolved = 0;

  // ── Step 1: decay scoring ──────────────────────────────────
  const now = Date.now();
  const notes: StrategyNote[] = strategyEntries.map((entry) => {
    // Parse creation timestamp from entry.createdAt or use a default age
    const createdAt = (entry as { createdAt?: string }).createdAt;
    const recordedMs = createdAt
      ? new Date(createdAt).getTime()
      : now - 30 * 24 * 3600 * 1000;
    const daysSince = Math.max(0, (now - recordedMs) / (24 * 3600 * 1000));

    // Approximate supporting event count from the source tag
    // "evolution.strategy" → 1 assumed; richer tagging can improve this
    const supportCount = 1;
    const decayScore = computeDecayScore(supportCount, daysSince);

    return {
      id: entry.id,
      content: entry.content,
      decayScore,
    };
  });

  // ── Step 2: prune stale notes ──────────────────────────────
  const surviving: StrategyNote[] = [];
  for (const note of notes) {
    if (note.decayScore < DECAY_PRUNE_THRESHOLD) {
      // Remove stale note
      await memory.delete?.(note.id).catch(() => {});
      pruned++;
    } else {
      surviving.push(note);
    }
  }

  // ── Step 3: contradiction resolution ──────────────────────
  const removed = new Set<string>();
  for (let i = 0; i < surviving.length; i++) {
    for (let j = i + 1; j < surviving.length; j++) {
      const a = surviving[i]!;
      const b = surviving[j]!;
      if (removed.has(a.id) || removed.has(b.id)) continue;

      if (areContradictory(a.content, b.content)) {
        // Keep the higher-scored note; remove the lower-scored one
        const loser = a.decayScore >= b.decayScore ? b : a;
        await memory.delete?.(loser.id).catch(() => {});
        removed.add(loser.id);
        contradictionsResolved++;
      }
    }
  }

  return {
    pruned,
    contradictionsResolved,
    consolidatedAt: new Date().toISOString(),
  };
}
