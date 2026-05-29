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
 * Usage (zero-config — session manages saves automatically):
 *
 *   import { NemoSession } from "nemo-ai";
 *   import { createNemoAdapter } from "msm-agent/adapters/nemo";
 *
 *   // loadOrCreate: starts fresh on first run, restores memory on restart
 *   const session = NemoSession.loadOrCreate("./.nemo.json");
 *   const agent = createAgent({
 *     brain,
 *     nemo: createNemoAdapter(session),   // ← session auto-saves every 100 teach() calls + SIGTERM
 *     ...adapters,
 *   });
 *
 * Usage (adapter controls save lifecycle — for custom intervals or shutdown hooks):
 *
 *   const session = NemoSession.loadOrCreate("./.nemo.json", {
 *     autoSaveEvery: 0,    // disable session's own auto-save
 *     shutdownHook: false, // disable session's own shutdown hook
 *   });
 *   const agent = createAgent({
 *     brain,
 *     nemo: createNemoAdapter(session, {
 *       save: { every: 50, onShutdown: true },
 *     }),
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
  /** Optional — if present, the adapter can trigger saves on its own schedule. */
  save?(): void;
}

/**
 * Controls whether / how the adapter triggers session saves, on top of the
 * session's own built-in auto-save. Useful when you want the agent config to
 * be the single source of truth for persistence behaviour.
 *
 * Pass `false` to disable adapter-managed saving entirely (session manages itself).
 * Omit entirely to also leave saving to the session (same as false for this field).
 */
export type SaveOptions =
  | {
      /**
       * Save every N teach() calls (adapter-side counter).
       * Independent of the session's own autoSaveEvery.
       */
      every?: number;
      /**
       * Register SIGTERM / SIGINT handlers to flush state on process exit.
       * Node.js only. Use when session was created with shutdownHook: false.
       */
      onShutdown?: boolean;
    }
  | false;

/**
 * Wrap a NemoSession as a NemoLike adapter for createAgent({ nemo }).
 *
 * @param session  A NemoSession instance (from `NemoSession.loadOrCreate(path)`).
 * @param options  Optional tuning.
 * @param options.minConfidence  Skip injecting hints below this threshold (default 0.25).
 * @param options.save           Adapter-level save strategy (default: session manages itself).
 */
export function createNemoAdapter(
  session: NemoSessionLike,
  options: { minConfidence?: number; save?: SaveOptions } = {},
): NemoLike {
  const minConfidence = options.minConfidence ?? 0.25;
  const saveOpts = options.save;

  // Adapter-level teach counter (only used when save.every is set)
  let teachCount = 0;
  const saveEvery =
    saveOpts !== false && saveOpts?.every !== undefined ? saveOpts.every : 0;

  // Adapter-level shutdown hook (only when explicitly opted in)
  if (
    saveOpts !== false &&
    saveOpts?.onShutdown === true &&
    typeof process !== "undefined" &&
    typeof (process as NodeJS.Process).once === "function"
  ) {
    const onExit = () => {
      try {
        session.save?.();
      } catch {
        /* best effort */
      }
    };
    process.once("SIGTERM", onExit);
    process.once("SIGINT", onExit);
  }

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
        // Adapter-level interval save (only when save.every is configured)
        if (saveEvery > 0 && session.save) {
          teachCount++;
          if (teachCount % saveEvery === 0) {
            try {
              session.save();
            } catch {
              /* best effort */
            }
          }
        }
      } catch {
        // Fail silently — teach() is best-effort, never critical
      }
    },
  };
}
