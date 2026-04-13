/**
 * DeliveryAdapter — How the agent delivers responses to users.
 *
 * In dalil: WhatsApp (interactive buttons/lists), Telegram, widget, SSE dashboard.
 * In msm-agent: you bring your own. The dummy adapter logs to console.
 */

import type { LoopOutcome } from "../core/types.js";

export interface DeliveryAdapter {
  /** Deliver the agent's response to the user */
  send(sessionId: string, outcome: LoopOutcome): Promise<void>;

  /** Optional: request human approval before executing a destructive action */
  requestApproval?(
    sessionId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<boolean>;

  /** Optional: send typing/processing indicator */
  sendTyping?(sessionId: string): Promise<void>;
}
