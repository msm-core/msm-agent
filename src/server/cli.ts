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
import { InMemoryJobAdapter } from "../adapters/jobs.js";
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
import { InMemoryAdapter } from "../adapters-dummy/memory.js";
import { SQLiteMemoryAdapter } from "../adapters/sqlite-memory.js";
import { InMemoryControlBus } from "../adapters-dummy/control-bus.js";
import { MockToolAdapter } from "../adapters-dummy/tools.js";
import type { KnowledgeAdapter } from "../adapters/knowledge.js";
import { QdrantKnowledgeAdapter } from "../adapters/qdrant-knowledge.js";
import { ManualEventAdapter } from "../adapters-dummy/events.js";
import { ConsoleDeliveryAdapter } from "../adapters-dummy/delivery.js";
import { createAgentServer } from "./http.js";

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

  // ── Shared memory adapter ────────────────────────────────
  const databaseUrl = process.env["DATABASE_URL"];
  const memoryPath = process.env["MEMORY_PATH"];
  let memoryAdapter: MemoryAdapter;
  let sqliteAdapter: SQLiteMemoryAdapter | null = null;

  if (
    databaseUrl?.startsWith("postgresql://") ||
    databaseUrl?.startsWith("postgres://")
  ) {
    log("Memory: PostgreSQL (shared)");
    const { PostgresMemoryAdapter } =
      await import("../adapters/postgres-memory.js");
    memoryAdapter = await PostgresMemoryAdapter.connect(databaseUrl);
  } else if (
    databaseUrl?.startsWith("mongodb://") ||
    databaseUrl?.startsWith("mongodb+srv://")
  ) {
    log("Memory: MongoDB (shared)");
    const { MongoMemoryAdapter } = await import("../adapters/mongo-memory.js");
    memoryAdapter = await MongoMemoryAdapter.connect(databaseUrl);
  } else if (memoryPath) {
    log(`Memory: SQLite (${memoryPath}) — dev/single-instance only (shared)`);
    sqliteAdapter = new SQLiteMemoryAdapter(memoryPath);
    memoryAdapter = sqliteAdapter;
  } else {
    log(
      "Memory: in-memory (state lost on restart — set DATABASE_URL for persistence)",
    );
    memoryAdapter = new InMemoryAdapter();
  }

  const neo4jUrl = process.env["NEO4J_URL"];
  if (neo4jUrl) {
    const password = process.env["NEO4J_PASSWORD"];
    if (!password)
      throw new Error("NEO4J_PASSWORD is required when NEO4J_URL is set");
    log(`Memory: Neo4j graph layer (${neo4jUrl}) wrapping primary store`);
    const { Neo4jMemoryAdapter } = await import("../adapters/neo4j-memory.js");
    memoryAdapter = await Neo4jMemoryAdapter.connect({
      url: neo4jUrl,
      user: process.env["NEO4J_USER"] ?? "neo4j",
      password,
      primary: memoryAdapter,
    });
  }

  // ── Shared control bus ───────────────────────────────────
  const redisUrl = process.env["REDIS_URL"];
  let controlBus: ControlBusAdapter;
  if (redisUrl) {
    log(`Control bus: Redis (${redisUrl}) (shared)`);
    const { RedisControlBus } =
      await import("../adapters/redis-control-bus.js");
    controlBus = await RedisControlBus.connect(redisUrl);
  } else {
    log("Control bus: in-memory (set REDIS_URL for cross-instance signals)");
    controlBus = new InMemoryControlBus();
  }

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
    let agentKb: KnowledgeAdapter | undefined;
    const qdrantUrl = process.env["QDRANT_URL"];
    if (qdrantUrl) {
      const embedProvider =
        (process.env["EMBED_PROVIDER"] as
          | "gemini"
          | "openai"
          | "ollama"
          | undefined) ??
        (process.env["GEMINI_API_KEY"]
          ? "gemini"
          : process.env["OPENAI_API_KEY"]
            ? "openai"
            : "ollama");
      const embedApiKey =
        embedProvider === "gemini"
          ? process.env["GEMINI_API_KEY"]
          : embedProvider === "openai"
            ? process.env["OPENAI_API_KEY"]
            : undefined;
      const collection = `${agentName}_kb`;
      agentKb = QdrantKnowledgeAdapter.create({
        url: qdrantUrl,
        apiKey: process.env["QDRANT_API_KEY"],
        collection,
        embedProvider,
        embedApiKey,
        ollamaUrl:
          process.env["OLLAMA_EMBED_URL"] ??
          process.env["OLLAMA_ENDPOINT"] ??
          "http://localhost:11434",
      });
      log(`  KB: Qdrant collection "${collection}" (embed=${embedProvider})`);
    }

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
  let jobAdapter: JobAdapter | undefined;
  if (process.env["ENABLE_JOBS"] === "true") {
    if (memoryPath) {
      log(`Jobs: SQLite (${memoryPath})`);
      const { SQLiteJobAdapter } = await import("../adapters/sqlite-jobs.js");
      jobAdapter = SQLiteJobAdapter.connect(memoryPath);
    } else {
      log("Jobs: in-memory");
      jobAdapter = new InMemoryJobAdapter();
    }
  }

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

  // ── Select memory adapter ────────────────────────────────
  const databaseUrl = process.env["DATABASE_URL"];
  const memoryPath = process.env["MEMORY_PATH"];

  let memoryAdapter: MemoryAdapter;
  let sqliteAdapter: SQLiteMemoryAdapter | null = null;

  if (
    databaseUrl?.startsWith("postgresql://") ||
    databaseUrl?.startsWith("postgres://")
  ) {
    log("Memory: PostgreSQL");
    const { PostgresMemoryAdapter } =
      await import("../adapters/postgres-memory.js");
    memoryAdapter = await PostgresMemoryAdapter.connect(databaseUrl);
  } else if (
    databaseUrl?.startsWith("mongodb://") ||
    databaseUrl?.startsWith("mongodb+srv://")
  ) {
    log("Memory: MongoDB");
    const { MongoMemoryAdapter } = await import("../adapters/mongo-memory.js");
    memoryAdapter = await MongoMemoryAdapter.connect(databaseUrl);
  } else if (memoryPath) {
    log(`Memory: SQLite (${memoryPath}) — dev/single-instance only`);
    sqliteAdapter = new SQLiteMemoryAdapter(memoryPath);
    memoryAdapter = sqliteAdapter;
  } else {
    log(
      "Memory: in-memory (state lost on restart — set DATABASE_URL for persistence)",
    );
    memoryAdapter = new InMemoryAdapter();
  }

  // ── Neo4j graph enrichment (optional, wraps primary store) ──
  const neo4jUrl = process.env["NEO4J_URL"];
  if (neo4jUrl) {
    const password = process.env["NEO4J_PASSWORD"];
    if (!password)
      throw new Error("NEO4J_PASSWORD is required when NEO4J_URL is set");
    log(`Memory: Neo4j graph layer (${neo4jUrl}) wrapping primary store`);
    const { Neo4jMemoryAdapter } = await import("../adapters/neo4j-memory.js");
    memoryAdapter = await Neo4jMemoryAdapter.connect({
      url: neo4jUrl,
      user: process.env["NEO4J_USER"] ?? "neo4j",
      password,
      primary: memoryAdapter,
    });
  }

  // ── Select control bus ───────────────────────────────────
  const redisUrl = process.env["REDIS_URL"];
  let controlBus: ControlBusAdapter;
  if (redisUrl) {
    log(`Control bus: Redis (${redisUrl})`);
    const { RedisControlBus } =
      await import("../adapters/redis-control-bus.js");
    controlBus = await RedisControlBus.connect(redisUrl);
  } else {
    log("Control bus: in-memory (set REDIS_URL for cross-instance signals)");
    controlBus = new InMemoryControlBus();
  }

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
  // When WHATSAPP_GATEWAY_URL is set, wire the WhatsApp delivery + event adapters.
  // The gateway forwards inbound messages to POST /webhook/whatsapp on this server.
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
    // Wire the event adapter so inbound webhooks flow into the agent loop.
    // (Registration is deferred to after createAgent below.)
  } else {
    log("Channel: console (set WHATSAPP_GATEWAY_URL to enable WhatsApp)");
    delivery = new ConsoleDeliveryAdapter();
  }

  // ── Create and start agent ───────────────────────────────
  // ── Evolving Layer (optional) ─────────────────────────────
  let evolvingAdapter:
    | import("../adapters/evolving.js").EvolvingAdapter
    | undefined;
  const evolvingMode = process.env["EVOLVING_MODE"];
  if (evolvingMode === "shadow" || evolvingMode === "assist") {
    log(`Evolving: ${evolvingMode} mode`);
    const { MemoryEvolvingAdapter } = await import("../adapters/evolving.js");
    evolvingAdapter = new MemoryEvolvingAdapter(memoryAdapter, evolvingMode);
    // Phase 14 — Self-Improving Loop: analyse accumulated quality flags on startup
    if (evolvingMode === "assist" && evolvingAdapter.refreshStrategies) {
      await evolvingAdapter.refreshStrategies(memoryAdapter).catch(() => {});
      log("Evolving: strategy notes refreshed from quality history");
    }
  }

  const agentConfig = toAgentConfig(def);
  const gatesConfig = toGatesConfig(def);
  const equipmentBlock = renderEquipmentBlock(def.equipment) ?? undefined;

  // ── Knowledge Base (Qdrant, optional) ───────────────────
  let knowledgeAdapter: KnowledgeAdapter | undefined;
  const qdrantUrl = process.env["QDRANT_URL"];
  if (qdrantUrl) {
    const embedProvider =
      (process.env["EMBED_PROVIDER"] as
        | "gemini"
        | "openai"
        | "ollama"
        | undefined) ??
      (process.env["GEMINI_API_KEY"]
        ? "gemini"
        : process.env["OPENAI_API_KEY"]
          ? "openai"
          : "ollama");

    const embedApiKey =
      embedProvider === "gemini"
        ? process.env["GEMINI_API_KEY"]
        : embedProvider === "openai"
          ? process.env["OPENAI_API_KEY"]
          : undefined;

    const collectionDefault =
      def.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") + "_kb";

    knowledgeAdapter = QdrantKnowledgeAdapter.create({
      url: qdrantUrl,
      apiKey: process.env["QDRANT_API_KEY"],
      collection: process.env["QDRANT_COLLECTION"] ?? collectionDefault,
      embedProvider,
      embedApiKey,
      embedModel: process.env["EMBED_MODEL"],
      ollamaUrl:
        process.env["OLLAMA_EMBED_URL"] ??
        process.env["OLLAMA_ENDPOINT"] ??
        "http://localhost:11434",
    });
    log(
      `Knowledge: Qdrant (${qdrantUrl}) — embed=${embedProvider}, collection=${process.env["QDRANT_COLLECTION"] ?? collectionDefault}`,
    );
  }

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
  let jobAdapter: JobAdapter | undefined;
  if (process.env["ENABLE_JOBS"] === "true") {
    if (memoryPath) {
      log(`Jobs: SQLite (${memoryPath})`);
      const { SQLiteJobAdapter } = await import("../adapters/sqlite-jobs.js");
      jobAdapter = SQLiteJobAdapter.connect(memoryPath);
    } else {
      log("Jobs: in-memory (set MEMORY_PATH to persist jobs across restarts)");
      jobAdapter = new InMemoryJobAdapter();
    }
  }

  const server = createAgentServer(agent, def, {
    port,
    host,
    memory: memoryAdapter,
    controlBus,
    dashboardPassword,
    whatsAppEvents,
    jobs: jobAdapter,
    sovereign,
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
