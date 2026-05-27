/**
 * agent_meta — built-in signalling tool for OpenAI and Anthropic brains.
 *
 * Injected automatically alongside user tools so the brain can explicitly
 * request clarification, escalate to a human, or delegate to another agent —
 * without relying on guards or low-confidence thresholds.
 *
 * The brain adapter translates the tool call into the appropriate
 * BrainPayload before returning it to the loop. The loop itself never
 * sees "agent_meta" — it only sees CLARIFY / ESCALATE / DELEGATE actions.
 */

import type { BrainPayload } from "../core/types.js";
import { STANDARD_ACTIONS } from "../core/types.js";

/** Tool definition shape expected by brain adapters */
export interface AgentMetaToolDef {
  name: "agent_meta";
  description: string;
  parameters: Record<
    string,
    { type: string; description: string; required: boolean }
  >;
}

export const AGENT_META_TOOL: AgentMetaToolDef = {
  name: "agent_meta",
  description:
    "Signal a meta-action when you cannot proceed normally. " +
    'Use "clarify" to ask the user for missing information. ' +
    'Use "escalate" to hand off to a human agent when the request is out of scope or requires authority you lack. ' +
    'Use "delegate" to route to a specialist agent role. ' +
    "Only call this when truly necessary — do not use it as an easy escape from hard tasks.",
  parameters: {
    action: {
      type: "string",
      description:
        '"clarify" | "escalate" | "delegate". ' +
        "clarify = ask user a question; escalate = human handoff; delegate = route to another agent.",
      required: true,
    },
    message: {
      type: "string",
      description:
        'For "clarify": the specific question to ask the user (be concise). ' +
        'For "escalate": the reason this case needs human handling. ' +
        'For "delegate": the exact role name to route to (e.g. "billing", "legal").',
      required: true,
    },
  },
};

/**
 * Translate an agent_meta tool call into the correct BrainPayload.
 * Returns null if the action value is unrecognised (caller should fall through
 * to normal USE_TOOL handling).
 */
export function resolveAgentMeta(
  action: string,
  message: string,
): BrainPayload | null {
  switch (action) {
    case "clarify":
      return {
        orchestration: {
          action: STANDARD_ACTIONS.CLARIFY,
          confidence: 1.0,
          reasoning: message,
        },
        generation: { response_text: message },
        final_output: { text: message, language: "en" },
      };

    case "escalate":
      return {
        orchestration: {
          action: STANDARD_ACTIONS.ESCALATE,
          confidence: 1.0,
          reasoning: message,
        },
      };

    case "delegate":
      return {
        orchestration: {
          action: STANDARD_ACTIONS.DELEGATE,
          confidence: 1.0,
          delegate_to_role: message,
        },
      };

    default:
      return null;
  }
}
