/**
 * CLI Entry Point — Agent Microservice
 *
 * Boots the portable agent from an agent definition file and starts
 * the HTTP server. This is what runs inside Docker.
 *
 * ── Memory / Persistence ────────────────────────────────────────────────────
 *
 *   DATABASE_URL      PostgreSQL or MongoDB connection URL       [recommended]
 *     postgresql://user:pass@host:5432/dbname   → PostgresMemoryAdapter
 *     mongodb://user:pass@host:27017/dbname     → MongoMemoryAdapter
 *     mongodb+srv://...                         → MongoMemoryAdapter (Atlas)
 *
 *   MEMORY_PATH       SQLite file path (dev/demo only)           [optional]
 *     ./agent.db  → SQLiteMemoryAdapter  (single container, no HA)
 *
 *   (none)            In-memory only — state lost on restart     [tests only]
 *
 * ── Graph Memory (optional, wraps primary store) ────────────────────────────
 *
 *   NEO4J_URL         bolt://localhost:7687 or neo4j+s://...     [optional]
 *   NEO4J_USER        Neo4j username                             [default: neo4j]
 *   NEO4J_PASSWORD    Neo4j password                             [required if NEO4J_URL set]
 *
 * ── Control Bus (kill/pause/disable signals) ────────────────────────────────
 *
 *   REDIS_URL         redis://[:pass@]host:6379[/db]             [optional]
 *     → RedisControlBus (recommended for production)
 *     → Also enables: pnpm add bullmq for BullMQEventAdapter
 *
 * ── HTTP Server ─────────────────────────────────────────────────────────────
 *
 *   AGENT_FILE        Path to agent definition (.md or .it)      [required*]
 *   AGENT_FILES       Comma-separated paths for multi-agent hub   [required*]
 *                       AGENT_FILES=feasibility.md,legal.md,hr.md
 *                       Each agent name is taken from the definition file.
 *                       * Set exactly one of AGENT_FILE or AGENT_FILES.
 *   PORT              HTTP server port                            [default: 3000]
 *   HOST              HTTP server host                            [default: 0.0.0.0]
 *
 * ── MCP Server (optional, requires @modelcontextprotocol/sdk) ───────────────
 *
 *   ENABLE_MCP=true   Expose agent as an MCP server
 *   MCP_TRANSPORT     stdio (default) | http
 *   MCP_PORT          HTTP port for MCP server                    [default: 3001]
 *
 * ── Evolving Layer (optional) ────────────────────────────────────────────────
 *
 *   EVOLVING_MODE     off (default) | shadow | assist
 *     shadow  → records outcomes, never injects (safe observation)
 *     assist  → records outcomes AND injects past-approach hints into prompt
 *
 * ── LLM Credentials ─────────────────────────────────────────────────────────
 *
 *   OPENAI_API_KEY    OpenAI API key                             [if provider=openai]
 *   OPENAI_BASE_URL   Override base URL (Azure, proxies)         [optional]
 *   ANTHROPIC_API_KEY Anthropic API key                          [if provider=anthropic]
 *   GEMINI_API_KEY    Google Gemini API key                      [if embed_provider=gemini]
 *   OLLAMA_ENDPOINT   Ollama base URL                            [default: http://localhost:11434]
 *
 * ── Knowledge Base (Qdrant vector KB, optional) ────────────────────
 *
 *   QDRANT_URL        Qdrant base URL                            [enables KB]
 *     http://localhost:6333  → local Qdrant
 *     https://...qdrant.io   → Qdrant Cloud (add QDRANT_API_KEY)
 *
 *   QDRANT_COLLECTION Collection name                            [default: <agent-name>_kb]
 *   QDRANT_API_KEY    Qdrant Cloud API key                       [optional]
 *
 *   EMBED_PROVIDER    Embedding provider: gemini | openai | ollama  [default: auto]
 *                       gemini  → requires GEMINI_API_KEY
 *                       openai  → requires OPENAI_API_KEY
 *                       ollama  → no key needed (local)
 *   EMBED_MODEL       Override embedding model                   [optional]
 *   OLLAMA_EMBED_URL  Ollama base URL for embeddings             [default: OLLAMA_ENDPOINT]
 */

import type { MemoryAdapter } from "../adapters/memory.js";
import type { ControlBusAdapter } from "../adapters/control-bus.js";
import type { JobAdapter } from "../adapters/jobs.js";
import type { McpServerHandle } from "./mcp.js";
import type { ToolAdapter } from "../adapters/tools.js";
import { loadAgent } from "../definition/index.js";
import { buildBrain } from "../brains/factory.js";
import { createAgent } from "../core/agent.js";
import { createAgentHub } from "../core/hub.js";
import type { AgentHandle } from "../core/types.js";
import {
  toAgentConfig,
  toGatesConfig,
  renderEquipmentBlock,
} from "../definition/schema.js";
import { MockToolAdapter } from "../adapters-dummy/tools.js";
import type { KnowledgeAdapter } from "../adapters/knowledge.js";
import { ManualEventAdapter } from "../adapters-dummy/events.js";
import { ConsoleDeliveryAdapter } from "../adapters-dummy/delivery.js";
import { createAgentServer } from "./http.js";
import {
  buildMemoryAdapter,
  buildControlBus,
  buildKnowledgeAdapter,
  buildEvolvingAdapter,
  buildJobAdapter,
} from "./bootstrap.js";

// ─── Helpers ─────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[msm-agent] ${msg}`);
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Detect mode: hub vs single agent ────────────────────
  const agentFile = process.env["AGENT_FILE"];
  const agentFilesRaw = process.env["AGENT_FILES"];

  if (!agentFile && !agentFilesRaw) {
    console.error(
      "[msm-agent] Error: AGENT_FILE or AGENT_FILES environment variable is required",
    );
    console.error(
      "[msm-agent] Single:  AGENT_FILE=./support-agent.md node dist/server/cli.js",
    );
    console.error(
      "[msm-agent] Hub:     AGENT_FILES=./feasibility.md,./legal.md node dist/server/cli.js",
    );
    process.exit(1);
  }

  if (agentFile && agentFilesRaw) {
    console.error(
      "[msm-agent] Error: set either AGENT_FILE or AGENT_FILES — not both",
    );
    process.exit(1);
  }

  // ── Hub mode ─────────────────────────────────────────────
  if (agentFilesRaw) {
    await runHub(agentFilesRaw);
    return;
  }

  // ── Single-agent mode (existing behavior) ────────────────
  await runSingleAgent(agentFile!);
}

async function runHub(agentFilesRaw: string): Promise<void> {
  const agentFiles = agentFilesRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (agentFiles.length === 0) {
    console.error("[msm-agent] Error: AGENT_FILES is empty");
    process.exit(1);
  }

  log(`Hub mode — loading ${agentFiles.length} agent(s)`);

  // Sovereign check
  const sovereign = process.env["SOVEREIGN"] === "true";
  if (sovereign) {
    if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
      console.error(
        "[msm-agent] SOVEREIGN=true but cloud credentials are set. " +
          "Remove OPENAI_API_KEY / ANTHROPIC_API_KEY to prevent data leaving this infrastructure.",
      );
      process.exit(1);
    }
    if (!process.env["DATABASE_URL"] && !process.env["MEMORY_PATH"]) {
      process.env["MEMORY_PATH"] = "/data/agent.db";
    }
    log(
      "Sovereign mode: all processing is local — no cloud credentials loaded.",
    );
  }

  // ── Shared adapters ──────────────────────────────────────
  const {
    adapter: memoryAdapter,
    sqliteAdapter,
    memoryPath,
  } = await buildMemoryAdapter(" (shared)");
  const controlBus = await buildControlBus(" (shared)");

  const memoryContext = sqliteAdapter
    ? (q: string) =>
        sqliteAdapter!.searchSync(q, 5).map((e) => `[memory] ${e.content}`)
    : undefined;

  // ── Load definitions and build per-agent resources ───────
  const agentHandles: Record<string, AgentHandle> = {};
  const agentDefs: Record<
    string,
    import("../definition/index.js").AgentDefinition
  > = {};

  for (const filePath of agentFiles) {
    log(`Loading: ${filePath}`);
    let def = await loadAgent(filePath);

    if (
      sovereign &&
      (!def.brain?.provider ||
        def.brain.provider === "openai" ||
        def.brain.provider === "anthropic")
    ) {
      def = {
        ...def,
        brain: {
          ...def.brain,
          provider: "ollama",
          model: def.brain?.model ?? "phi4-mini",
        },
      };
    }

    // Derive a safe agent name from the definition name (lowercase, hyphenated)
    const agentName = def.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    log(
      `Agent "${agentName}" (${def.brain.provider}/${def.brain.model ?? "default"})`,
    );

    const brain = buildBrain(def, { memoryContext });

    let tools: ToolAdapter = new MockToolAdapter();
    if (def.equipment) {
      const { EquipmentToolAdapter } = await import("../adapters/equipment.js");
      tools = EquipmentToolAdapter.create(def.equipment, tools);
    }
    if (def.skills.length > 0) {
      const { SkillToolAdapter } = await import("../adapters/skills.js");
      tools = SkillToolAdapter.create(def.skills, {}, tools);
      log(`  Skills: ${def.skills.join(", ")}`);
    }

    const agentConfig = toAgentConfig(def);
    const gatesConfig = toGatesConfig(def);
    const equipmentBlock = renderEquipmentBlock(def.equipment) ?? undefined;

    // KB: each hub agent gets its own collection named <agentName>_kb
    const agentKb = buildKnowledgeAdapter(`${agentName}_kb`);

    agentHandles[agentName] = createAgent({
      brain,
      memory: memoryAdapter,
      tools,
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      controlBus,
      config: agentConfig,
      gates: gatesConfig,
      knowledge: agentKb,
      equipmentBlock,
    });
    agentDefs[agentName] = def;
  }

  const hub = createAgentHub(agentHandles);

  // ── Jobs ─────────────────────────────────────────────────
  const jobAdapter = await buildJobAdapter(memoryPath);

  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const hostAddr = process.env["HOST"] ?? "0.0.0.0";
  const dashboardPassword = process.env["DASHBOARD_PASSWORD"];

  const server = createAgentServer(hub, agentDefs, {
    port,
    host: hostAddr,
    memory: memoryAdapter,
    controlBus,
    dashboardPassword,
    jobs: jobAdapter,
    sovereign,
    apiKey: process.env["API_KEY"],
  });
  await server.start();

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log(`Received ${signal}, shutting down…`);
    await server.stop();
    for (const adapter of [memoryAdapter, controlBus, jobAdapter]) {
      const a = adapter as { close?: () => Promise<void> };
      await a.close?.();
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function runSingleAgent(agentFile: string): Promise<void> {
  log(`Loading agent definition: ${agentFile}`);
  let def = await loadAgent(agentFile);

  // ── Sovereign mode validation ────────────────────────────
  // SOVEREIGN=true guarantees all processing stays local: no cloud credentials
  // are accepted, Ollama is required, SQLite is the storage default.
  const sovereign = process.env["SOVEREIGN"] === "true";
  if (sovereign) {
    if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
      console.error(
        "[msm-agent] SOVEREIGN=true but cloud credentials are set. " +
          "Remove OPENAI_API_KEY / ANTHROPIC_API_KEY to prevent data leaving this infrastructure.",
      );
      process.exit(1);
    }
    // Default brain to ollama if definition has no provider declared
    if (
      !def.brain?.provider ||
      def.brain.provider === "openai" ||
      def.brain.provider === "anthropic"
    ) {
      def = {
        ...def,
        brain: {
          ...def.brain,
          provider: "ollama",
          model: def.brain?.model ?? "phi4-mini",
        },
      };
    }
    // Default storage to SQLite under /data when neither storage option is set
    if (!process.env["DATABASE_URL"] && !process.env["MEMORY_PATH"]) {
      process.env["MEMORY_PATH"] = "/data/agent.db";
    }
    log(
      "Sovereign mode: all processing is local — no cloud credentials loaded.",
    );
  }

  log(
    `Agent: "${def.name}" (${def.brain.provider}/${def.brain.model ?? "default"})`,
  );

  // ── Select adapters from env vars ───────────────────────
  const {
    adapter: memoryAdapter,
    sqliteAdapter,
    memoryPath,
  } = await buildMemoryAdapter();
  const controlBus = await buildControlBus();

  // ── L4 memory context for the 5-layer prompt ────────────
  // SQLite has a synchronous search; for Postgres/Mongo the context builder
  // will call memory.search() async per iteration (already integrated).
  const memoryContext = sqliteAdapter
    ? (q: string) =>
        sqliteAdapter!.searchSync(q, 5).map((e) => `[memory] ${e.content}`)
    : undefined;

  // ── Build brain ──────────────────────────────────────────
  const brain = buildBrain(def, { memoryContext });

  // ── Wire remaining adapters ──────────────────────────────
  let tools: ToolAdapter = new MockToolAdapter();

  // If the definition includes equipment, resolve connectors into tools
  if (def.equipment) {
    const { EquipmentToolAdapter } = await import("../adapters/equipment.js");
    tools = EquipmentToolAdapter.create(def.equipment, tools);
  }

  // If the definition includes skills, layer them on top
  if (def.skills.length > 0) {
    const { SkillToolAdapter } = await import("../adapters/skills.js");
    tools = SkillToolAdapter.create(def.skills, {}, tools);
    log(`Skills: ${def.skills.join(", ")}`);
  }

  const events = new ManualEventAdapter();

  // ── WhatsApp channel (optional) ──────────────────────────
  const whatsAppGatewayUrl = process.env["WHATSAPP_GATEWAY_URL"];
  const whatsAppTenantId = process.env["WHATSAPP_TENANT_ID"];
  const whatsAppAccountId = process.env["WHATSAPP_ACCOUNT_ID"];
  const whatsAppWebhookSecret = process.env["WHATSAPP_WEBHOOK_SECRET"];

  let whatsAppEvents:
    | import("../adapters/whatsapp-event.js").WhatsAppEventAdapter
    | undefined;
  let delivery: import("../adapters/delivery.js").DeliveryAdapter;

  if (whatsAppGatewayUrl && whatsAppTenantId && whatsAppAccountId) {
    log(`Channel: WhatsApp (gateway ${whatsAppGatewayUrl})`);
    const { WhatsAppEventAdapter } =
      await import("../adapters/whatsapp-event.js");
    const { WhatsAppDeliveryAdapter } =
      await import("../adapters/whatsapp-delivery.js");
    whatsAppEvents = WhatsAppEventAdapter.create({
      webhookSecret: whatsAppWebhookSecret,
    });
    delivery = WhatsAppDeliveryAdapter.connect({
      gatewayUrl: whatsAppGatewayUrl,
      apiKey: process.env["WHATSAPP_GATEWAY_KEY"],
      tenantId: whatsAppTenantId,
      accountId: whatsAppAccountId,
    });
  } else {
    log("Channel: console (set WHATSAPP_GATEWAY_URL to enable WhatsApp)");
    delivery = new ConsoleDeliveryAdapter();
  }

  // ── Evolving Layer (optional) ─────────────────────────────
  const evolvingAdapter = await buildEvolvingAdapter(memoryAdapter);

  const agentConfig = toAgentConfig(def);
  const gatesConfig = toGatesConfig(def);
  const equipmentBlock = renderEquipmentBlock(def.equipment) ?? undefined;

  // ── Knowledge Base (Qdrant, optional) ───────────────────
  const collectionDefault =
    def.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") + "_kb";
  const knowledgeAdapter = buildKnowledgeAdapter(
    process.env["QDRANT_COLLECTION"] ?? collectionDefault,
  );

  const agent = createAgent({
    brain,
    memory: memoryAdapter,
    tools,
    events,
    delivery,
    controlBus,
    config: agentConfig,
    evolving: evolvingAdapter,
    gates: gatesConfig,
    equipmentBlock,
    knowledge: knowledgeAdapter,
  });

  // Wire WhatsApp inbound events to the agent loop now that agent is created.
  if (whatsAppEvents) {
    whatsAppEvents.onEvent(async (event) => {
      await agent.handleEvent(event).catch((err: unknown) => {
        console.error("[msm-agent] WhatsApp event error:", err);
      });
    });
  }

  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const host = process.env["HOST"] ?? "0.0.0.0";
  const dashboardPassword = process.env["DASHBOARD_PASSWORD"];

  // ── Jobs (optional feature) ──────────────────────────────
  const jobAdapter = await buildJobAdapter(memoryPath);

  const server = createAgentServer(agent, def, {
    port,
    host,
    memory: memoryAdapter,
    controlBus,
    dashboardPassword,
    whatsAppEvents,
    jobs: jobAdapter,
    sovereign,
    apiKey: process.env["API_KEY"],
  });
  await server.start();

  // ── MCP Server (optional) ────────────────────────────────
  let mcpServer: McpServerHandle | undefined;
  if (process.env["ENABLE_MCP"] === "true") {
    const mcpTransport =
      (process.env["MCP_TRANSPORT"] as "stdio" | "http" | undefined) ?? "stdio";
    const mcpPort = parseInt(process.env["MCP_PORT"] ?? "3001", 10);
    log(
      `MCP: ${mcpTransport === "http" ? `HTTP on port ${mcpPort}` : "stdio"}`,
    );
    const { createMcpServer } = await import("./mcp.js");
    mcpServer = await createMcpServer(agent, def, {
      transport: mcpTransport,
      port: mcpPort,
      host,
      memory: memoryAdapter,
    });
  }

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log(`Received ${signal}, shutting down…`);
    await server.stop();
    await mcpServer?.stop();
    // Close connections that support it
    for (const adapter of [memoryAdapter, controlBus, jobAdapter]) {
      const a = adapter as { close?: () => Promise<void> };
      await a.close?.();
    }
    await evolvingAdapter?.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[msm-agent] Fatal error:", err);
  process.exit(1);
});
