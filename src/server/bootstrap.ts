/**
 * Bootstrap helpers — adapter construction from environment variables.
 *
 * Exported so both `runSingleAgent()` and `runHub()` in cli.ts use the same
 * logic. Each function reads its own subset of env vars and logs what it chose.
 */

import type { MemoryAdapter } from "../adapters/memory.js";
import type { ControlBusAdapter } from "../adapters/control-bus.js";
import type { JobAdapter } from "../adapters/jobs.js";
import type { KnowledgeAdapter } from "../adapters/knowledge.js";
import type { EvolvingAdapter } from "../adapters/evolving.js";
import { InMemoryAdapter } from "../adapters-dummy/memory.js";
import { SQLiteMemoryAdapter } from "../adapters/sqlite-memory.js";
import { InMemoryControlBus } from "../adapters-dummy/control-bus.js";
import { InMemoryJobAdapter } from "../adapters/jobs.js";
import { QdrantKnowledgeAdapter } from "../adapters/qdrant-knowledge.js";

function log(msg: string): void {
  console.log(`[msm-agent] ${msg}`);
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export interface BuiltMemory {
  adapter: MemoryAdapter;
  /** Non-null only when SQLite was chosen — exposes synchronous search. */
  sqliteAdapter: SQLiteMemoryAdapter | null;
  /** SQLite file path used, if any. */
  memoryPath: string | undefined;
}

/**
 * Build the primary memory adapter from environment variables.
 *
 * Priority: DATABASE_URL (Postgres → Mongo) → MEMORY_PATH (SQLite) → in-memory.
 * If NEO4J_URL is also set the chosen adapter is wrapped in Neo4jMemoryAdapter.
 *
 * @param label  Optional suffix appended to log messages (e.g. " (shared)").
 */
export async function buildMemoryAdapter(label = ""): Promise<BuiltMemory> {
  const databaseUrl = process.env["DATABASE_URL"];
  const memoryPath = process.env["MEMORY_PATH"];
  let adapter: MemoryAdapter;
  let sqliteAdapter: SQLiteMemoryAdapter | null = null;

  if (
    databaseUrl?.startsWith("postgresql://") ||
    databaseUrl?.startsWith("postgres://")
  ) {
    log(`Memory: PostgreSQL${label}`);
    const { PostgresMemoryAdapter } =
      await import("../adapters/postgres-memory.js");
    adapter = await PostgresMemoryAdapter.connect(databaseUrl);
  } else if (
    databaseUrl?.startsWith("mongodb://") ||
    databaseUrl?.startsWith("mongodb+srv://")
  ) {
    log(`Memory: MongoDB${label}`);
    const { MongoMemoryAdapter } = await import("../adapters/mongo-memory.js");
    adapter = await MongoMemoryAdapter.connect(databaseUrl);
  } else if (memoryPath) {
    log(`Memory: SQLite (${memoryPath})${label}`);
    sqliteAdapter = new SQLiteMemoryAdapter(memoryPath);
    adapter = sqliteAdapter;
  } else {
    log(
      "Memory: in-memory (state lost on restart — set DATABASE_URL for persistence)",
    );
    adapter = new InMemoryAdapter();
  }

  // Optional: Neo4j graph layer wrapping the primary store
  const neo4jUrl = process.env["NEO4J_URL"];
  if (neo4jUrl) {
    const password = process.env["NEO4J_PASSWORD"];
    if (!password)
      throw new Error("NEO4J_PASSWORD is required when NEO4J_URL is set");
    log(`Memory: Neo4j graph layer (${neo4jUrl}) wrapping primary store`);
    const { Neo4jMemoryAdapter } = await import("../adapters/neo4j-memory.js");
    adapter = await Neo4jMemoryAdapter.connect({
      url: neo4jUrl,
      user: process.env["NEO4J_USER"] ?? "neo4j",
      password,
      primary: adapter,
    });
  }

  return { adapter, sqliteAdapter, memoryPath };
}

// ─── Control bus ──────────────────────────────────────────────────────────────

/**
 * Build the control bus from environment variables.
 *
 * REDIS_URL → RedisControlBus; otherwise InMemoryControlBus.
 */
export async function buildControlBus(label = ""): Promise<ControlBusAdapter> {
  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl) {
    log(`Control bus: Redis (${redisUrl})${label}`);
    const { RedisControlBus } =
      await import("../adapters/redis-control-bus.js");
    return RedisControlBus.connect(redisUrl);
  }
  log("Control bus: in-memory (set REDIS_URL for cross-instance signals)");
  return new InMemoryControlBus();
}

// ─── Knowledge (Qdrant) ───────────────────────────────────────────────────────

function resolveEmbedProvider(): "gemini" | "openai" | "ollama" {
  const explicit = process.env["EMBED_PROVIDER"] as
    | "gemini"
    | "openai"
    | "ollama"
    | undefined;
  if (explicit) return explicit;
  if (process.env["GEMINI_API_KEY"]) return "gemini";
  if (process.env["OPENAI_API_KEY"]) return "openai";
  return "ollama";
}

/**
 * Build the Qdrant knowledge adapter when QDRANT_URL is set.
 * Returns undefined when QDRANT_URL is not configured.
 */
export function buildKnowledgeAdapter(
  collection: string,
): KnowledgeAdapter | undefined {
  const qdrantUrl = process.env["QDRANT_URL"];
  if (!qdrantUrl) return undefined;

  const embedProvider = resolveEmbedProvider();
  const embedApiKey =
    embedProvider === "gemini"
      ? process.env["GEMINI_API_KEY"]
      : embedProvider === "openai"
        ? process.env["OPENAI_API_KEY"]
        : undefined;

  log(
    `Knowledge: Qdrant (${qdrantUrl}) — embed=${embedProvider}, collection=${collection}`,
  );

  return QdrantKnowledgeAdapter.create({
    url: qdrantUrl,
    apiKey: process.env["QDRANT_API_KEY"],
    collection,
    embedProvider,
    embedApiKey,
    embedModel: process.env["EMBED_MODEL"],
    ollamaUrl:
      process.env["OLLAMA_EMBED_URL"] ??
      process.env["OLLAMA_ENDPOINT"] ??
      "http://localhost:11434",
  });
}

// ─── Evolving ─────────────────────────────────────────────────────────────────

/**
 * Build the evolving adapter when EVOLVING_MODE is "shadow" or "assist".
 * Returns undefined when EVOLVING_MODE is unset or "off".
 */
export async function buildEvolvingAdapter(
  memory: MemoryAdapter,
): Promise<EvolvingAdapter | undefined> {
  const evolvingMode = process.env["EVOLVING_MODE"];
  if (evolvingMode !== "shadow" && evolvingMode !== "assist") return undefined;

  log(`Evolving: ${evolvingMode} mode`);
  const { MemoryEvolvingAdapter } = await import("../adapters/evolving.js");
  const adapter = new MemoryEvolvingAdapter(memory, evolvingMode);

  if (evolvingMode === "assist" && adapter.refreshStrategies) {
    await adapter.refreshStrategies(memory).catch(() => {});
    log("Evolving: strategy notes refreshed from quality history");
  }

  return adapter;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * Build the job adapter when ENABLE_JOBS=true.
 * Returns undefined otherwise.
 */
export async function buildJobAdapter(
  memoryPath?: string,
): Promise<JobAdapter | undefined> {
  if (process.env["ENABLE_JOBS"] !== "true") return undefined;

  if (memoryPath) {
    log(`Jobs: SQLite (${memoryPath})`);
    const { SQLiteJobAdapter } = await import("../adapters/sqlite-jobs.js");
    return SQLiteJobAdapter.connect(memoryPath);
  }

  log("Jobs: in-memory (set MEMORY_PATH to persist jobs across restarts)");
  return new InMemoryJobAdapter();
}
