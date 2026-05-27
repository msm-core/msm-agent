/**
 * Prompt Section Registry
 *
 * Tracks prompt sections with token estimates and cacheability annotations.
 * Compacts the prompt when it exceeds the token budget by removing or
 * truncating volatile sections (lowest priority first).
 *
 * Ported from Kader/packages/ai-engine and stripped of all tenant-specific deps.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionKind = "static" | "volatile";

export interface PromptSection {
  id: string;
  label: string;
  /** static = cache-friendly, changes only when definition changes.
   *  volatile = changes every turn (memory, history, state). */
  kind: SectionKind;
  content: string;
  estimatedTokens: number;
  /** Compaction order — lower = removed/truncated first. */
  compactionPriority: number;
}

export interface SectionRegistryStats {
  totalTokens: number;
  staticTokens: number;
  volatileTokens: number;
  sectionCount: number;
  sections: Array<{
    id: string;
    label: string;
    kind: SectionKind;
    estimatedTokens: number;
  }>;
}

export interface CompactionPolicy {
  maxTokenBudget: number;
  targetTokens: number;
  /** Section ids that must never be removed. */
  protectedSections: ReadonlySet<string>;
}

export interface CompactionResult {
  compacted: boolean;
  originalTokens: number;
  finalTokens: number;
  removedSections: string[];
  truncatedSections: string[];
}

// ─── Token estimation ─────────────────────────────────────────────────────────

const CHARS_PER_TOKEN_LATIN = 3.5;
const CHARS_PER_TOKEN_ARABIC = 2.5;

const ARABIC_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

export function estimateTokens(text: string): number {
  const arabicChars = (text.match(ARABIC_RE) || []).length;
  const latinChars = text.length - arabicChars;
  return Math.ceil(
    arabicChars / CHARS_PER_TOKEN_ARABIC + latinChars / CHARS_PER_TOKEN_LATIN,
  );
}

// ─── Default compaction policies ─────────────────────────────────────────────

const PREMIUM_POLICY: CompactionPolicy = {
  maxTokenBudget: 180_000,
  targetTokens: 160_000,
  protectedSections: new Set([
    "layer1_rules",
    "layer2_identity",
    "layer5_user",
  ]),
};

const STANDARD_POLICY: CompactionPolicy = {
  maxTokenBudget: 120_000,
  targetTokens: 100_000,
  protectedSections: new Set([
    "layer1_rules",
    "layer2_identity",
    "layer5_user",
  ]),
};

export function getCompactionPolicy(
  qualityTier?: "standard" | "premium" | null,
): CompactionPolicy {
  return qualityTier === "premium" ? PREMIUM_POLICY : STANDARD_POLICY;
}

// ─── Section Registry ─────────────────────────────────────────────────────────

export class SectionRegistry {
  private sections: PromptSection[] = [];

  add(
    id: string,
    label: string,
    kind: SectionKind,
    content: string,
    compactionPriority: number = 50,
  ): void {
    if (!content || content.trim().length === 0) return;
    this.sections.push({
      id,
      label,
      kind,
      content,
      estimatedTokens: estimateTokens(content),
      compactionPriority,
    });
  }

  getStats(): SectionRegistryStats {
    const staticTokens = this.sections
      .filter((s) => s.kind === "static")
      .reduce((sum, s) => sum + s.estimatedTokens, 0);
    const volatileTokens = this.sections
      .filter((s) => s.kind === "volatile")
      .reduce((sum, s) => sum + s.estimatedTokens, 0);
    return {
      totalTokens: staticTokens + volatileTokens,
      staticTokens,
      volatileTokens,
      sectionCount: this.sections.length,
      sections: this.sections.map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        estimatedTokens: s.estimatedTokens,
      })),
    };
  }

  assemble(): string {
    return this.sections.map((s) => s.content).join("\n\n---\n\n");
  }

  /**
   * Compact the prompt to fit within the budget.
   * Phase 1: remove lowest-priority volatile sections.
   * Phase 2: truncate remaining volatile sections to 40%.
   * Protected sections are never touched.
   */
  compact(policy: CompactionPolicy): CompactionResult {
    const originalTokens = this.sections.reduce(
      (sum, s) => sum + s.estimatedTokens,
      0,
    );

    if (originalTokens <= policy.maxTokenBudget) {
      return {
        compacted: false,
        originalTokens,
        finalTokens: originalTokens,
        removedSections: [],
        truncatedSections: [],
      };
    }

    const removedSections: string[] = [];
    const truncatedSections: string[] = [];

    const candidates = this.sections
      .filter(
        (s) => s.kind === "volatile" && !policy.protectedSections.has(s.id),
      )
      .sort((a, b) => a.compactionPriority - b.compactionPriority);

    let currentTokens = originalTokens;

    // Phase 1: remove entire sections
    for (const candidate of candidates) {
      if (currentTokens <= policy.targetTokens) break;
      const idx = this.sections.findIndex((s) => s.id === candidate.id);
      if (idx === -1) continue;
      currentTokens -= candidate.estimatedTokens;
      this.sections.splice(idx, 1);
      removedSections.push(candidate.id);
    }

    // Phase 2: truncate what remains
    if (currentTokens > policy.targetTokens) {
      const remaining = this.sections.filter(
        (s) => s.kind === "volatile" && !policy.protectedSections.has(s.id),
      );
      for (const section of remaining) {
        if (currentTokens <= policy.targetTokens) break;
        const targetChars = Math.floor(section.content.length * 0.4);
        const truncated =
          section.content.slice(0, targetChars) +
          "\n[… truncated for context limit]";
        const savedTokens = section.estimatedTokens - estimateTokens(truncated);
        section.content = truncated;
        section.estimatedTokens = estimateTokens(truncated);
        currentTokens -= savedTokens;
        truncatedSections.push(section.id);
      }
    }

    return {
      compacted: true,
      originalTokens,
      finalTokens: currentTokens,
      removedSections,
      truncatedSections,
    };
  }

  getSections(): readonly PromptSection[] {
    return this.sections;
  }
}
