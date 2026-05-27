/**
 * WhatsAppEventAdapter — Receives inbound messages from the Kader WhatsApp Gateway.
 *
 * The gateway posts inbound messages (from WhatsApp contacts) to a configurable
 * webhook URL with an HMAC-SHA256 signature. This adapter:
 *   1. Exposes a `handleWebhook(rawBody, signature)` method for the HTTP server
 *   2. Verifies the HMAC signature (using WHATSAPP_WEBHOOK_SECRET)
 *   3. Maps each inbound message to a `user_message` AgentEvent
 *   4. Uses the sender's phone number (senderId) as the agent sessionId so that
 *      each WhatsApp contact gets an isolated conversation history
 *
 * Integration with the HTTP server:
 *   The HTTP server adds `POST /webhook/whatsapp` when a `WhatsAppEventAdapter`
 *   is provided in `ServerOptions`. The gateway is configured to POST to that URL.
 *
 * Gateway webhook payload (x-dalil-signature header contains HMAC):
 *   {
 *     messageId: string,
 *     senderId: string,       ← becomes agent sessionId
 *     senderName: string | null,
 *     content: string,        ← becomes event.text
 *     timestamp: string,
 *     sessionId: string,      ← gateway's internal session (ignored here)
 *     metadata: object
 *   }
 *
 * Environment variables (used by the CLI):
 *   WHATSAPP_WEBHOOK_SECRET   HMAC signing secret from the gateway (optional but recommended)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventAdapter } from "./events.js";
import type { AgentEvent } from "../core/types.js";

export interface WhatsAppEventAdapterOptions {
  /**
   * HMAC-SHA256 signing secret shared with the gateway (WHATSAPP_GATEWAY_WEBHOOK_SECRET).
   * If omitted, signature verification is skipped (acceptable in private networks;
   * NOT recommended when the webhook endpoint is public).
   */
  webhookSecret?: string;
}

interface GatewayInboundPayload {
  messageId: string;
  senderId: string;
  senderName: string | null;
  content: string;
  timestamp: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}

export class WhatsAppEventAdapter implements EventAdapter {
  private handler?: (event: AgentEvent) => Promise<void>;
  private readonly secret?: string;

  constructor(opts: WhatsAppEventAdapterOptions = {}) {
    this.secret = opts.webhookSecret;
  }

  static create(opts: WhatsAppEventAdapterOptions = {}): WhatsAppEventAdapter {
    return new WhatsAppEventAdapter(opts);
  }

  onEvent(handler: (event: AgentEvent) => Promise<void>): void {
    this.handler = handler;
  }

  /** start() and stop() are no-ops — delivery is push-based via POST /webhook/whatsapp */
  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  /**
   * Process a raw webhook body from the gateway.
   *
   * Returns `true` if the message was accepted (ACK to gateway),
   * or throws with a descriptive error on signature failure / bad payload.
   *
   * @param rawBody   The raw request body string (before JSON.parse)
   * @param signature The value of the `x-dalil-signature` header (may be empty/null)
   */
  async handleWebhook(
    rawBody: string,
    signature: string | null,
  ): Promise<void> {
    // ── Signature verification ──────────────────────────────
    if (this.secret) {
      if (!signature) {
        throw new WebhookAuthError("Missing x-dalil-signature header");
      }
      const expected = createHmac("sha256", this.secret)
        .update(rawBody)
        .digest("hex");

      // Parse the body first to re-serialize only the canonical payload (same as gateway)
      let body: GatewayInboundPayload;
      try {
        body = JSON.parse(rawBody) as GatewayInboundPayload;
      } catch {
        throw new WebhookParseError("Invalid JSON in webhook body");
      }

      // The gateway signs the canonicalized JSON object, not the raw body string.
      // Re-produce the exact serialization the gateway used.
      const canonical = JSON.stringify({
        messageId: body.messageId,
        senderId: body.senderId,
        senderName: body.senderName ?? null,
        content: body.content,
        timestamp: body.timestamp,
        sessionId: body.sessionId,
        metadata: body.metadata ?? {},
      });

      const expectedFromCanonical = createHmac("sha256", this.secret)
        .update(canonical)
        .digest("hex");

      const expectedBuf = Buffer.from(expectedFromCanonical, "hex");
      const suppliedBuf = Buffer.from(signature, "hex");

      if (
        expectedBuf.length !== suppliedBuf.length ||
        !timingSafeEqual(expectedBuf, suppliedBuf)
      ) {
        throw new WebhookAuthError("Invalid webhook signature");
      }

      await this.dispatch(body);
    } else {
      // No secret configured — skip verification and parse the body.
      let body: GatewayInboundPayload;
      try {
        body = JSON.parse(rawBody) as GatewayInboundPayload;
      } catch {
        throw new WebhookParseError("Invalid JSON in webhook body");
      }
      await this.dispatch(body);
    }
  }

  private async dispatch(payload: GatewayInboundPayload): Promise<void> {
    if (!payload.senderId || !payload.content) {
      throw new WebhookParseError(
        "Webhook payload missing senderId or content",
      );
    }

    if (!this.handler) {
      // No handler registered yet — silently drop (agent not started)
      return;
    }

    const event: AgentEvent = {
      type: "user_message",
      // Use sender's phone number as the session ID so each WhatsApp contact
      // gets an isolated conversation history in the memory adapter.
      sessionId: payload.senderId,
      text: payload.content,
      modality: "text",
    };

    await this.handler(event);
  }
}

// ─── Error types ──────────────────────────────────────────────

export class WebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookAuthError";
  }
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookParseError";
  }
}
