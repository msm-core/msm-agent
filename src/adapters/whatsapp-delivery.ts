/**
 * WhatsAppDeliveryAdapter — Delivers agent responses via the Kader WhatsApp Gateway.
 *
 * The gateway is a separate microservice that manages Baileys WebSocket connections.
 * This adapter calls its REST API to send messages to a specific WhatsApp contact.
 *
 * @see https://github.com/msm-ai/kader (apps/whatsapp-gateway)
 *
 * Setup:
 *   1. Run the Kader whatsapp-gateway service (docker or node)
 *   2. Connect a WhatsApp session via the gateway QR flow
 *   3. Configure this adapter with the gateway URL, API key, tenantId, accountId
 *
 * Environment variables (used by the CLI):
 *   WHATSAPP_GATEWAY_URL   Gateway base URL (e.g. http://localhost:4000)
 *   WHATSAPP_GATEWAY_KEY   Bearer API key for the gateway
 *   WHATSAPP_TENANT_ID     Tenant ID registered in the gateway
 *   WHATSAPP_ACCOUNT_ID    Account ID registered in the gateway
 */

import type { DeliveryAdapter } from "./delivery.js";
import type { LoopOutcome } from "../core/types.js";

export interface WhatsAppDeliveryAdapterOptions {
  /** Base URL of the whatsapp-gateway service, e.g. "http://localhost:4000" */
  gatewayUrl: string;
  /** Bearer API key for the gateway */
  apiKey?: string;
  /** Tenant ID as configured in the gateway */
  tenantId: string;
  /** Account ID (WhatsApp account) as configured in the gateway */
  accountId: string;
  /** Timeout for gateway HTTP calls in ms (default: 10_000) */
  timeoutMs?: number;
}

/**
 * Extract the plaintext message to send for a given LoopOutcome.
 * WhatsApp is a text channel — rich formats are flattened to text.
 */
function outcomeToText(outcome: LoopOutcome): string | null {
  switch (outcome.type) {
    case "response":
      return outcome.text;
    case "clarification":
      return outcome.question;
    case "escalated":
      return `Your request has been escalated: ${outcome.reason}`;
    case "waiting_approval":
      return "Your request requires operator approval. We'll notify you once it's reviewed.";
    case "delegated":
      return `Your request has been forwarded to: ${outcome.targetRole}`;
    case "error":
      return "Sorry, something went wrong. Please try again.";
    case "aborted":
      return "Your request was cancelled.";
    case "suppressed":
      return null;
    case "custom":
      return null; // caller decides
  }
}

export class WhatsAppDeliveryAdapter implements DeliveryAdapter {
  private readonly opts: Required<
    Pick<
      WhatsAppDeliveryAdapterOptions,
      "gatewayUrl" | "tenantId" | "accountId" | "timeoutMs"
    >
  > &
    Pick<WhatsAppDeliveryAdapterOptions, "apiKey">;

  private constructor(opts: WhatsAppDeliveryAdapterOptions) {
    this.opts = {
      gatewayUrl: opts.gatewayUrl.replace(/\/+$/, ""), // strip trailing slash
      apiKey: opts.apiKey,
      tenantId: opts.tenantId,
      accountId: opts.accountId,
      timeoutMs: opts.timeoutMs ?? 10_000,
    };
  }

  static connect(
    opts: WhatsAppDeliveryAdapterOptions,
  ): WhatsAppDeliveryAdapter {
    if (!opts.gatewayUrl)
      throw new Error("WhatsAppDeliveryAdapter: gatewayUrl is required");
    if (!opts.tenantId)
      throw new Error("WhatsAppDeliveryAdapter: tenantId is required");
    if (!opts.accountId)
      throw new Error("WhatsAppDeliveryAdapter: accountId is required");
    return new WhatsAppDeliveryAdapter(opts);
  }

  async send(sessionId: string, outcome: LoopOutcome): Promise<void> {
    const text = outcomeToText(outcome);
    if (!text) return; // nothing to send for this outcome type

    const body = JSON.stringify({
      tenantId: this.opts.tenantId,
      accountId: this.opts.accountId,
      to: sessionId, // sessionId is the WhatsApp phone number / sender JID
      message: text,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.apiKey) {
      headers["Authorization"] = `Bearer ${this.opts.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    try {
      const res = await fetch(`${this.opts.gatewayUrl}/messages/send`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(
          `WhatsApp gateway send failed (${res.status}): ${detail}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Typing indicators are not supported by the gateway — no-op.
  async sendTyping(_sessionId: string): Promise<void> {
    return;
  }

  // Approval is handled externally (dashboard POST /task/approve) — return "pending".
  async requestApproval(
    sessionId: string,
    taskId: string,
    toolName: string,
    _toolParams: Record<string, unknown>,
    _reasoning: string,
  ): Promise<boolean | "pending"> {
    // Notify the contact that approval is pending, then return "pending"
    // so the loop pauses and waits for an approval_callback event.
    const notice =
      `⏳ Action "${toolName}" requires approval. ` +
      `Task ID: ${taskId}. Your operator will be notified.`;

    await this.send(sessionId, {
      type: "response",
      text: notice,
      language: "en",
      payload: { type: "final_output", content: notice, confidence: 1 },
    });

    return "pending";
  }
}
