/**
 * Routing Brain — Phase 15 (Arabic-Native Routing)
 *
 * Wraps two Brain instances and selects between them per request based on
 * the detected language of the user's input. Arabic input routes to the
 * arabic-capable brain; everything else routes to the primary brain.
 *
 * Both brains implement the same Brain interface — the rest of the runtime
 * never sees the difference.
 *
 * Usage:
 *   const routing = new RoutingBrain(primaryBrain, arabicBrain);
 *   // Arabic text  → arabicBrain.run()
 *   // English text → primaryBrain.run()
 */

import type { Brain, BrainPayload } from "../core/types.js";
import { detectLanguage } from "./language-detect.js";

export class RoutingBrain implements Brain {
  constructor(
    /** Default brain for English (and all non-Arabic) input */
    private readonly primary: Brain,
    /**
     * Brain for Arabic input.
     * If undefined, all input falls through to the primary brain.
     * This graceful fallback lets `language: auto` work even when
     * ARABIC_OLLAMA_MODEL / ARABIC_OPENAI_MODEL are not configured.
     */
    private readonly arabic: Brain | undefined,
  ) {}

  async run(input: Parameters<Brain["run"]>[0]): Promise<BrainPayload> {
    const lang = detectLanguage(input.raw);
    const brain = lang === "ar" && this.arabic ? this.arabic : this.primary;
    return brain.run(input);
  }
}
