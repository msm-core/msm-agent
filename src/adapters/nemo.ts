/**
 * Nemo Adapter — optional fast pre-classifier integration
 *
 * Wraps a NemoSession (from nemo-ai) into the NemoLike interface consumed by
 * createAgent({ nemo }). Disabled by default — pass an instance only when you
 * want sub-millisecond intent pre-classification before the brain loop.
 *
 * nemo-ai is an optional peer dependency. Install it separately:
 *   npm install nemo-ai
 *
 * What the adapter does:
 *   run()   → tokenizes + encodes the text, classifies into one of 42 semantic
 *             fields, returns field / confidence / gate decision in <1ms.
 *   teach() → reinforces a confirmed field into nemo's semantic memory so the
 *             skip_llm rate rises over time without any manual retraining.
 *
 * Gate decisions (from nemo-ai constants):
 *   skip_llm   (confidence ≥ 0.55) — high-frequency known intent, no LLM needed
 *   llm_assist (confidence ≥ 0.35) — partial signal, field hint injected into prompt
 *   full_llm   (confidence < 0.35) — nemo unsure, brain takes full responsibility
 *
 * Usage:
 *
 *   import { NemoSession } from "nemo-ai";
 *   import { createNemoAdapter } from "msm-agent/adapters/nemo";
 *
 *   const session = await NemoSession.load("./.nemo.json");
 *   const agent = createAgent({
 *     brain,
 *     nemo: createNemoAdapter(session),   // ← optional; omit to disable
 *     ...adapters,
 *   });
 *
 * @see https://github.com/msm-core/nemo
 */

import type { NemoLike } from "../core/types.js";

/** Minimal surface we call on NemoSession — avoids importing nemo-ai at the type level */
interface NemoSessionLike {
  run(text: string): {
    field: string;
    confidence: number;
    gate: string;
  };
  teach(
    text: string,
    confirmedField: string,
    meta?: Record<string, unknown>,
  ): void;
}

/**
 * Wrap a NemoSession as a NemoLike adapter for createAgent({ nemo }).
 *
 * @param session  A loaded NemoSession instance (from `NemoSession.load(path)`).
 * @param options  Optional tuning.
 * @param options.minConfidence  Skip injecting hints below this threshold (default 0.25).
 *                               Avoids polluting brain context with very-low-confidence
 *                               guesses. Set to 0 to always inject.
 */
export function createNemoAdapter(
  session: NemoSessionLike,
  options: { minConfidence?: number } = {},
): NemoLike {
  const minConfidence = options.minConfidence ?? 0.25;

  return {
    run(text: string) {
      try {
        const result = session.run(text);
        // Below minConfidence threshold: return a neutral "unknown" so the agent
        // does not inject a misleading hint into the brain context.
        if (result.confidence < minConfidence) {
          return {
            field: "unknown",
            confidence: result.confidence,
            gate: "full_llm",
          };
        }
        return result;
      } catch {
        // Nemo must never crash the agent — fail open
        return { field: "unknown", confidence: 0, gate: "full_llm" };
      }
    },

    teach(text: string, field: string, meta?: Record<string, unknown>) {
      try {
        session.teach(text, field, meta);
      } catch {
        // Fail silently — teach() is best-effort, never critical
      }
    },
  };
}
