/**
 * AgentDefinition Schema
 *
 * The validated IR produced by parsing an agent.md or agent.it file.
 * This is distinct from AgentConfig (the loop runtime settings in core/types.ts).
 *
 * AgentDefinition = who the agent IS and what it can do.
 * AgentConfig     = how the loop BEHAVES (iterations, thresholds, etc.)
 */

import { z } from "zod";
import type { AgentConfig } from "../core/types.js";
import type { GatesConfig } from "../core/gates.js";

// ─── Sub-schemas ─────────────────────────────────────────────

export const PersonaSchema = z.object({
  /** Display name of the agent persona (e.g. "Nour") */
  name: z.string().optional(),
  /** Languages the agent operates in (e.g. ["ar", "en"]) */
  language: z.array(z.string()).default([]),
  /** Tone/style descriptor (e.g. "warm, direct, solution-focused") */
  style: z.string().optional(),
});

export const BrainSchema = z.object({
  /**
   * LLM provider.
   * - "openai" / "anthropic" / "ollama"  → simple direct-call brain
   * - "msm"                               → full MSM 5-layer pipeline brain
   * - "custom"                            → caller supplies brain in createAgent()
   */
  provider: z.enum(["openai", "anthropic", "ollama", "msm", "custom"]),
  /** Model name (e.g. "gpt-4o-mini", "claude-3-5-haiku", "llama3") */
  model: z.string().optional(),
  /** Override base URL — useful for local Ollama or proxies */
  endpoint: z.string().url().optional(),
  /**
   * Language routing hint (Phase 15 — Arabic-Native Routing).
   * - "arabic" / "ar" → build a RoutingBrain: Arabic input → Arabic-capable model
   * - "auto"          → detect per-request; falls back to primary if no Arabic model set
   * - omitted         → no language routing (existing behaviour)
   */
  language: z.enum(["arabic", "english", "ar", "en", "auto"]).optional(),
});

export const MemoryDefinitionSchema = z.object({
  /** Topics/entities the agent should retain across conversations */
  retain: z.array(z.string()).default([]),
});

// ─── Equipment ───────────────────────────────────────────────

export const ConnectorCredentialsSchema = z.object({
  /** Auth scheme for the connector */
  type: z.enum(["api_key", "bearer", "basic"]),
  /**
   * Credential value — supports ${ENV_VAR} substitution at runtime.
   * The EquipmentToolAdapter resolves these from process.env when activated.
   */
  value: z.string(),
  /** Custom header name for api_key auth (default: "X-API-Key") */
  headerName: z.string().optional(),
});

export const EquipmentConnectorSchema = z.object({
  /** Connector type identifier — must match a registered ConnectorFactory */
  type: z.string().min(1),
  /** Scoped operations this agent may call (e.g. "orders.list", "bookings.create") */
  operations: z.array(z.string()).default([]),
  /** Access level granted to this agent for this connector */
  access: z.enum(["read", "write", "readwrite"]).default("readwrite"),
  /** Base URL for the external service (supports ${ENV_VAR}) */
  endpoint: z.string().optional(),
  /** Per-agent credentials — used instead of shared tenant-level credentials */
  credentials: ConnectorCredentialsSchema.optional(),
});

export const AgentEquipmentSchema = z.object({
  /** External connectors bound to this agent (e.g. Shopify, Fresha, HubSpot) */
  connectors: z.array(EquipmentConnectorSchema).default([]),
  /**
   * Channels this agent is allowed to send messages on.
   * When defined, gates channel tools to only these channels.
   * When undefined, falls back to runtime defaults.
   */
  channels: z.array(z.string()).default([]),
  /**
   * Tool names activated exclusively for this agent beyond role defaults.
   * These are injected into the tool catalog unconditionally.
   */
  dedicatedTools: z.array(z.string()).default([]),
});

export const LimitsSchema = z.object({
  /** Maps to AgentConfig.maxToolCallsPerTask */
  toolCalls: z.number().int().positive().optional(),
  /** Maps to AgentConfig.maxIterations */
  iterations: z.number().int().positive().optional(),
  /** Maps to AgentConfig.confidenceThreshold (0–1) */
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

// ─── Business Hours ────────────────────────────────────────

export const BusinessHoursScheduleSchema = z.object({
  /** Days this window applies to (e.g. ["mon","tue","wed","thu","fri"]) */
  days: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])),
  /** Opening time in "HH:MM" 24-hour format */
  from: z.string().regex(/^\d{1,2}:\d{2}$/, "must be HH:MM format"),
  /** Closing time in "HH:MM" 24-hour format */
  to: z.string().regex(/^\d{1,2}:\d{2}$/, "must be HH:MM format"),
});

export const BusinessHoursGateConfigSchema = z.object({
  /** IANA timezone string (e.g. "Asia/Dubai", "America/New_York", "UTC") */
  timezone: z.string().default("UTC"),
  /** One or more time windows that define when the agent is open */
  schedule: z.array(BusinessHoursScheduleSchema).default([]),
  /** Response sent when outside hours. Falls back to generic closed message. */
  closedMessage: z.string().optional(),
  /** Arabic version of the closed message (optional) */
  closedMessageAr: z.string().optional(),
});

// ─── Root schema ─────────────────────────────────────────────

export const AgentDefinitionSchema = z.object({
  /** Human-readable agent name (e.g. "Support Agent") */
  name: z.string().min(1, "Agent must have a name"),
  /** Domain or purpose description (e.g. "e-commerce customer support") */
  domain: z.string().optional(),

  persona: PersonaSchema.default({}),

  /**
   * What the agent can do — plain-language capability strings.
   * These are used to build the system prompt and match tool names.
   */
  capabilities: z.array(z.string()).default([]),

  memory: MemoryDefinitionSchema.default({}),

  /**
   * Hard behavioural rules injected into the system prompt.
   * Keep these declarative — the brain enforces them.
   */
  rules: z.array(z.string()).default([]),

  limits: LimitsSchema.default({}),

  brain: BrainSchema,

  /**
   * Equipment — what external systems this agent can reach and what tools it has.
   * Declared in the ## Equipment section of the agent definition file.
   * Resolved at runtime by EquipmentToolAdapter + ConnectorRegistry.
   */
  equipment: AgentEquipmentSchema.optional(),

  /**
   * Skills — named tool packs activated for this agent.
   * Declared in the ## Skills section of the agent definition file.
   * Each name must match a registered SkillFactory in SkillRegistry.
   * Skills are in-process tool bundles (no credentials needed), unlike
   * equipment connectors which reach external APIs.
   */
  skills: z.array(z.string()).default([]),

  /**
   * Business hours — when the agent is open for conversations.
   * Declared in the ## Hours section of the agent definition file.
   * Outside these hours, a canned closed message is returned without LLM call.
   */
  hours: BusinessHoursGateConfigSchema.optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type BrainConfig = z.infer<typeof BrainSchema>;
export type LimitsConfig = z.infer<typeof LimitsSchema>;
export type AgentEquipment = z.infer<typeof AgentEquipmentSchema>;
export type EquipmentConnector = z.infer<typeof EquipmentConnectorSchema>;
export type ConnectorCredentials = z.infer<typeof ConnectorCredentialsSchema>;
export type BusinessHoursSchedule = z.infer<typeof BusinessHoursScheduleSchema>;
export type BusinessHoursGateConfig = z.infer<
  typeof BusinessHoursGateConfigSchema
>;

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Extract the subset of AgentConfig (loop runtime settings) that can be
 * derived from an AgentDefinition. Pass the result as `config` in createAgent().
 */
export function toAgentConfig(def: AgentDefinition): Partial<AgentConfig> {
  const partial: Partial<AgentConfig> = {};
  if (def.limits.toolCalls !== undefined) {
    partial.maxToolCallsPerTask = def.limits.toolCalls;
  }
  if (def.limits.iterations !== undefined) {
    partial.maxIterations = def.limits.iterations;
  }
  if (def.limits.confidenceThreshold !== undefined) {
    partial.confidenceThreshold = def.limits.confidenceThreshold;
  }
  return partial;
}

/**
 * Extract the GatesConfig from an AgentDefinition.
 * Returns undefined when no gates are configured.
 * Acknowledgement gate is always enabled when any gates config is produced.
 */
export function toGatesConfig(def: AgentDefinition): GatesConfig | undefined {
  const hasHours = !!def.hours;
  if (!hasHours) return undefined;
  return {
    acknowledgement: true,
    businessHours: def.hours,
  };
}

/**
 * Render a human-readable EQUIPMENT block for injection into the system prompt.
 * Returns null when the agent has no equipment (so the caller can skip injection).
 *
 * Output format:
 *   EQUIPMENT (connected systems):
 *   - shopify: orders.list, orders.get [read]
 *   - fresha: bookings.create, bookings.list [readwrite]
 *   DEDICATED TOOLS: generate_quote, send_sms
 */
export function renderEquipmentBlock(
  equipment: AgentEquipment | undefined,
): string | null {
  if (!equipment) return null;

  const lines: string[] = [];

  if (equipment.connectors.length > 0) {
    lines.push("EQUIPMENT (connected systems):");
    for (const c of equipment.connectors) {
      const ops =
        c.operations.length > 0 ? c.operations.join(", ") : "all operations";
      lines.push(`- ${c.type}: ${ops} [${c.access}]`);
    }
  }

  if (equipment.dedicatedTools.length > 0) {
    lines.push(`DEDICATED TOOLS: ${equipment.dedicatedTools.join(", ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
