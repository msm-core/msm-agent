/**
 * msm-agent — Portable Agent Framework
 *
 * The agent is the "hands" — it receives events, asks the brain
 * what to do, executes tools, feeds results back, and delivers responses.
 * The brain never executes anything — it only decides.
 *
 * This package is brain-agnostic. Any brain that returns BrainPayload works.
 * For MSM integration, use the bridge: import { wrapMSM } from "msm-agent/bridge/msm"
 */

// ─── Core ────────────────────────────────────────────────────
export { createAgent } from "./core/agent.js";
export type { CreateAgentOptions } from "./core/agent.js";

export { createAgentHub, isAgentHub } from "./core/hub.js";
export type { AgentHubHandle, AgentHubMeta } from "./core/hub.js";

export type {
  AgentConfig,
  AgentEvent,
  AgentHandle,
  Brain,
  BrainPayload,
  BrainOrchestration,
  BrainGeneration,
  BrainFinalOutput,
  ToolResult,
  PlanStep,
  OrchestrationAction,
  GuardSignal,
  LoopOutcome,
  Message,
  RunState,
  StepResult,
  TaskPlan,
  TaskState,
  TaskStatus,
  ActionReceipt,
  ResponseEvidence,
  ResponseFormat,
  ControlCommand,
} from "./core/types.js";
export { DEFAULT_CONFIG, STANDARD_ACTIONS } from "./core/types.js";

// ─── Loop (for advanced usage) ───────────────────────────────
export { executeEvent } from "./core/loop.js";
export type { LoopDeps } from "./core/loop.js";

// ─── Guards ──────────────────────────────────────────────────
export { checkGuards, hasHardBlock } from "./core/guards.js";

// ─── Planner ─────────────────────────────────────────────────
export {
  createPlan,
  advancePlanStep,
  failPlanStep,
  canReplan,
  replan,
  clearPlan,
  isPlanComplete,
  getCurrentStep,
} from "./core/planner.js";

// ─── Tool Dedup ──────────────────────────────────────────────
export { checkDedup } from "./core/tool-dedup.js";
export type { DedupResult } from "./core/tool-dedup.js";

// ─── Flush Gate ──────────────────────────────────────────────
export { FlushGate } from "./core/flush-gate.js";
export type { FlushGateOptions } from "./core/flush-gate.js";

// ─── Context Builder ─────────────────────────────────────────
export { buildContext } from "./core/context.js";
export type { BrainInput, ContextOptions } from "./core/context.js";
// ─── Output Sanitization ─────────────────────────────────
export { sanitizeOutput, containsSensitiveData } from "./core/sanitize.js";
export type { SanitizeResult } from "./core/sanitize.js";

// ─── Input Guard (Prompt Injection Defense) ──────────────
export { guardInput } from "./core/input-guard.js";
export type { InputGuardResult } from "./core/input-guard.js";
// ─── Adapter Interfaces ─────────────────────────────────────
export type { MemoryAdapter, MemoryEntry } from "./adapters/memory.js";
export type {
  ToolAdapter,
  ToolDefinition,
  ToolParameter,
  ToolRateLimit,
  ToolValidationResult,
} from "./adapters/tools.js";
export type { EventAdapter } from "./adapters/events.js";
export type { DeliveryAdapter } from "./adapters/delivery.js";
export type { ControlBusAdapter } from "./adapters/control-bus.js";
export type {
  KnowledgeAdapter,
  KnowledgeHit,
  KnowledgeSearchOpts,
  KnowledgeIndexOpts,
} from "./adapters/knowledge.js";

// ─── Production Adapters ──────────────────────────────────────
// All adapters are selected automatically in the CLI via environment variables.
// For custom wiring, import and instantiate them directly.

// SQLite — dev/demo single-instance persistence (node:sqlite built-in, Node 22+)
// Activate: MEMORY_PATH=/data/agent.db
// Extra: searchSync() feeds L4 of the 5-layer prompt synchronously.
export { SQLiteMemoryAdapter } from "./adapters/sqlite-memory.js";

// PostgreSQL — production memory (pnpm add postgres)
// Activate: DATABASE_URL=postgresql://user:pass@host:5432/dbname
export { PostgresMemoryAdapter } from "./adapters/postgres-memory.js";

// MongoDB — production memory with Atlas Vector Search support (pnpm add mongodb)
// Activate: DATABASE_URL=mongodb://... or mongodb+srv://...
export { MongoMemoryAdapter } from "./adapters/mongo-memory.js";

// Neo4j — graph-enriched memory layer, wraps a primary adapter (pnpm add neo4j-driver)
// Activate: NEO4J_URL=bolt://... (set alongside DATABASE_URL or MEMORY_PATH)
export { Neo4jMemoryAdapter } from "./adapters/neo4j-memory.js";
export type { Neo4jMemoryAdapterOptions } from "./adapters/neo4j-memory.js";

// Redis — distributed control bus: kill/pause/disable signals (pnpm add ioredis)
// Activate: REDIS_URL=redis://host:6379
export { RedisControlBus } from "./adapters/redis-control-bus.js";

// Qdrant — vector knowledge base: semantic search over indexed documents (no extra dep)
// Uses pure REST API — no SDK required. Works with Qdrant OSS and Qdrant Cloud.
// Activate: QDRANT_URL=http://localhost:6333 (set EMBED_PROVIDER + key for embeddings)
// Embedding providers: gemini (GEMINI_API_KEY) | openai (OPENAI_API_KEY) | ollama (local)
export {
  QdrantKnowledgeAdapter,
  smartChunk,
} from "./adapters/qdrant-knowledge.js";
export type {
  QdrantKnowledgeOptions,
  EmbedProvider,
} from "./adapters/qdrant-knowledge.js";

// BullMQ — durable async event queue built on Redis (pnpm add bullmq ioredis)
// Use for background jobs, cron scheduling, and retry semantics.
export { BullMQEventAdapter } from "./adapters/redis-event-queue.js";
export type { BullMQEventAdapterOptions } from "./adapters/redis-event-queue.js";

// WhatsApp — event + delivery adapters for the Kader WhatsApp Gateway
// EventAdapter: receives inbound messages via POST /webhook/whatsapp (built into HTTP server)
// DeliveryAdapter: sends responses via the gateway's REST API
// Activate: WHATSAPP_GATEWAY_URL + WHATSAPP_TENANT_ID + WHATSAPP_ACCOUNT_ID
export { WhatsAppEventAdapter } from "./adapters/whatsapp-event.js";
export type { WhatsAppEventAdapterOptions } from "./adapters/whatsapp-event.js";
export { WhatsAppDeliveryAdapter } from "./adapters/whatsapp-delivery.js";
export type { WhatsAppDeliveryAdapterOptions } from "./adapters/whatsapp-delivery.js";

// Jobs — long-running named workflows with step/duration budgets (Phase 7)
// Activate: ENABLE_JOBS=true in the CLI.
// InMemoryJobAdapter: dev/test (default when ENABLE_JOBS=true)
// SQLiteJobAdapter: persistent dev/single-instance (MEMORY_PATH must also be set)
export { InMemoryJobAdapter, generateJobId } from "./adapters/jobs.js";
export type { Job, JobAdapter, JobBudget, JobStatus } from "./adapters/jobs.js";
export { SQLiteJobAdapter } from "./adapters/sqlite-jobs.js";

// ─── Dummy Adapters (testing & demos) ────────────────────────
export { InMemoryAdapter } from "./adapters-dummy/memory.js";
export { MockToolAdapter } from "./adapters-dummy/tools.js";
export type { MockToolResponse } from "./adapters-dummy/tools.js";
export { ManualEventAdapter } from "./adapters-dummy/events.js";
export { ConsoleDeliveryAdapter } from "./adapters-dummy/delivery.js";
export { InMemoryControlBus } from "./adapters-dummy/control-bus.js";

// ─── Bridge Adapters (brain integration) ─────────────────────
export { wrapMSM } from "./bridge/msm.js";
export type { MSMPipeline } from "./bridge/msm.js";

// ─── Definition Layer ─────────────────────────────────────────
// Load agent definitions from .md or .it files.
// AgentDefinition = who the agent IS (persona, capabilities, brain config).
// Use toAgentConfig() to extract loop runtime settings for createAgent().
export {
  loadAgent,
  parseAgentSource,
  parseItSource,
  parseMdSource,
  toAgentConfig,
  toGatesConfig,
  renderEquipmentBlock,
  AgentDefinitionSchema,
  PersonaSchema,
  BrainSchema,
  LimitsSchema,
} from "./definition/index.js";
export type {
  AgentDefinition,
  Persona,
  BrainConfig,
  LimitsConfig,
  AgentEquipment,
  EquipmentConnector,
  ConnectorCredentials,
} from "./definition/index.js";

// ─── Brains ───────────────────────────────────────────────────
// Direct LLM brain implementations (native fetch, no extra deps).
// buildBrain(def) → Brain  reads credentials from env vars.
// Phase 15: detectLanguage(), RoutingBrain for Arabic-native routing.
export {
  buildBrain,
  buildDirectBrain,
  buildArabicBrain,
  buildSystemPrompt,
  createOpenAIBrain,
  createAnthropicBrain,
  createOllamaBrain,
  detectLanguage,
  ARABIC_BLOCK_START,
  ARABIC_BLOCK_END,
  ARABIC_FRACTION_THRESHOLD,
  RoutingBrain,
} from "./brains/index.js";
export type {
  BrainFactoryOptions,
  DetectedLanguage,
  OpenAIBrainOptions,
  AnthropicBrainOptions,
  OllamaBrainOptions,
} from "./brains/index.js";

// ─── Server ───────────────────────────────────────────────────
// HTTP microservice wrapper — createAgentServer(agent, def, opts)
export { createAgentServer } from "./server/index.js";
export type { ServerOptions } from "./server/index.js";

// ─── Equipment ────────────────────────────────────────────────
// Connector registry and equipment-based tool adapter.
// Register connectors with ConnectorRegistry.register(), then create an
// EquipmentToolAdapter from the agent definition's equipment block.
export {
  ConnectorRegistry,
  EquipmentToolAdapter,
} from "./adapters/equipment.js";
export type {
  ConnectorToolDef,
  ResolvedConnectorConfig,
  ConnectorFactory,
} from "./adapters/equipment.js";
// ─── Skills ───────────────────────────────────────────────────
// Named tool packs — reusable in-process tool bundles.
// Register with SkillRegistry.register(), activate via '## Skills' in agent definition.
export { SkillRegistry, SkillToolAdapter } from "./adapters/skills.js";
export type {
  SkillToolDef,
  SkillFactory,
  SkillOptions,
} from "./adapters/skills.js";
// ─── Pre-processing Gates ─────────────────────────────────────
// Zero-LLM filters applied before the brain loop.
// Gate 1 — Acknowledgement: suppress "ok / thanks / تمام" messages (no delivery).
// Gate 2 — Business hours: return canned closed message outside working hours.
// Pass GatesConfig to createAgent({ gates }) to activate.
export {
  isAcknowledgement,
  isWithinBusinessHours,
  checkGates,
  parseDays,
} from "./core/gates.js";
export type {
  GatesConfig,
  BusinessHoursGateConfig,
  BusinessHoursSchedule,
  DayOfWeek,
} from "./core/gates.js";
// ─── Quality Scoring ──────────────────────────────────────────
// Signal-based quality scoring after each task outcome (Phase 13).
// scoreOutcome(outcome) → QualityScore — zero LLM cost, derived from LoopOutcome.
// FLAG_STRATEGIES — maps quality flags to actionable improvement hints (Phase 14).
export { scoreOutcome, FLAG_STRATEGIES } from "./core/quality.js";
export type { QualityScore, QualityFlag } from "./core/quality.js";
// ─── Evolving Layer ───────────────────────────────────────────
// Structured outcome learning from agent task history.
// NoneEvolvingAdapter — default, zero side effects.
// MemoryEvolvingAdapter — shadow/assist using existing MemoryAdapter.
export {
  NoneEvolvingAdapter,
  MemoryEvolvingAdapter,
} from "./adapters/evolving.js";
export type {
  EvolvingAdapter,
  EvolvingContext,
  EvolvingMode,
} from "./adapters/evolving.js";
// Phase 17 — Deeper Evolving Layer: decay scoring, contradiction detection, consolidation.
export {
  consolidateStrategies,
  computeDecayScore,
  computeTaskWeight,
  areContradictory,
  DECAY_PRUNE_THRESHOLD,
  CONTRADICTION_PAIRS,
} from "./adapters/evolving-consolidation.js";
export type {
  ConsolidationReport,
  SignalEdge,
  SignalGraph,
} from "./adapters/evolving-consolidation.js";

// ─── Prompt System ────────────────────────────────────────────
// 5-layer prompt assembler with section registry, compaction, and injection detection.
// buildPrompt(input) → { systemPrompt, userPrompt, registryStats, compaction }
// Phase 3 (memory) fills input.memoryLines to activate L4.
export {
  buildPrompt,
  SectionRegistry,
  estimateTokens,
  getCompactionPolicy,
} from "./prompt/index.js";
export {
  CORE_RULES,
  INTERACTION_RULES,
  detectInjection,
  INJECTION_WARNING,
} from "./prompt/index.js";
export type {
  PromptInput,
  PromptResult,
  SectionKind,
  PromptSection,
  SectionRegistryStats,
  CompactionPolicy,
  CompactionResult,
} from "./prompt/index.js";
