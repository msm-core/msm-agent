/**
 * QdrantKnowledgeAdapter — Vector KB backed by Qdrant.
 *
 * Uses pure REST (no SDK) exactly like the Kader reference implementation.
 * Embedding priority: Gemini → OpenAI → Ollama (local/sovereign)
 *
 * Quick start:
 *
 *   const kb = QdrantKnowledgeAdapter.create({
 *     url: "http://localhost:6333",
 *     collection: "support_kb",
 *     embedProvider: "openai",
 *     embedApiKey: process.env.OPENAI_API_KEY,
 *   });
 *
 *   // Index documents at deploy time
 *   await kb.indexDocument("doc1", "Refund Policy", fullText);
 *
 *   // Pass to createAgent — search happens automatically every loop iteration
 *   createAgent({ brain, memory, tools, ..., knowledge: kb });
 *
 * Environment variables (when using CLI):
 *   QDRANT_URL=http://localhost:6333
 *   QDRANT_COLLECTION=myagent_kb          (optional, defaults to agent name)
 *   QDRANT_API_KEY=...                    (optional, Qdrant Cloud)
 *   EMBED_PROVIDER=gemini|openai|ollama   (optional, auto-detected)
 *   GEMINI_API_KEY=...                    (if provider=gemini)
 *   OLLAMA_EMBED_MODEL=nomic-embed-text   (if provider=ollama)
 *   OLLAMA_EMBED_URL=http://localhost:11434
 */

import type {
  KnowledgeAdapter,
  KnowledgeHit,
  KnowledgeIndexOpts,
  KnowledgeSearchOpts,
} from "./knowledge.js";

// ─── Configuration ────────────────────────────────────────────────────────────

export type EmbedProvider = "gemini" | "openai" | "ollama";

export interface QdrantKnowledgeOptions {
  /** Qdrant base URL, e.g. http://localhost:6333 */
  url: string;
  /**
   * API key for Qdrant Cloud (or self-hosted with auth).
   * Leave undefined for unauthenticated local Qdrant.
   */
  apiKey?: string;
  /**
   * Collection name. Each agent should have its own collection.
   * @default "agent_kb"
   */
  collection?: string;
  /**
   * Which embedding provider to use.
   * Auto-detected from available keys if not specified:
   *   gemini (if embedApiKey provided) → openai (if embedApiKey provided) → ollama
   */
  embedProvider?: EmbedProvider;
  /**
   * API key for the embedding provider (Gemini or OpenAI).
   * For Ollama: not needed.
   */
  embedApiKey?: string;
  /**
   * Embedding model override.
   * Defaults: gemini="text-embedding-004", openai="text-embedding-3-small", ollama="nomic-embed-text"
   */
  embedModel?: string;
  /**
   * Ollama base URL (only relevant when embedProvider="ollama" or as fallback).
   * @default "http://localhost:11434"
   */
  ollamaUrl?: string;
  /**
   * Vector dimension. Must match the embedding model.
   * @default 768
   */
  vectorSize?: number;
  /**
   * Default chunk size in characters for indexDocument().
   * @default 3000
   */
  chunkSize?: number;
  /**
   * Default overlap in characters between consecutive chunks.
   * @default 500
   */
  chunkOverlap?: number;
}

// ─── Qdrant REST Types ────────────────────────────────────────────────────────

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantFilter {
  must?: Array<{ key: string; match: { value: string | number } }>;
}

interface QdrantSearchHit {
  id: string;
  score: number;
  payload?: {
    docId?: string;
    title?: string;
    text?: string;
    chunkIndex?: number;
    tags?: string[];
  };
}

interface ChunkPayload {
  docId: string;
  title: string;
  chunkIndex: number;
  text: string;
  tags?: string[];
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class QdrantKnowledgeAdapter implements KnowledgeAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly collection: string;
  private readonly provider: EmbedProvider;
  private readonly embedApiKey?: string;
  private readonly embedModel: string;
  private readonly ollamaUrl: string;
  private readonly vectorSize: number;
  private readonly defaultChunkSize: number;
  private readonly defaultChunkOverlap: number;

  /** Whether the collection has been confirmed to exist in Qdrant this session. */
  private collectionReady = false;

  private constructor(opts: Required<QdrantKnowledgeOptions>) {
    this.baseUrl = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.collection = opts.collection;
    this.provider = opts.embedProvider;
    this.embedApiKey = opts.embedApiKey;
    this.embedModel = opts.embedModel;
    this.ollamaUrl = opts.ollamaUrl.replace(/\/$/, "");
    this.vectorSize = opts.vectorSize;
    this.defaultChunkSize = opts.chunkSize;
    this.defaultChunkOverlap = opts.chunkOverlap;
  }

  /**
   * Create an adapter instance.
   * Provider is auto-detected if not specified:
   *   embedApiKey present → try gemini first, then openai based on provider hint
   *   otherwise → ollama
   */
  static create(opts: QdrantKnowledgeOptions): QdrantKnowledgeAdapter {
    const provider = resolveProvider(opts);
    const embedModel = resolveEmbedModel(provider, opts.embedModel);

    return new QdrantKnowledgeAdapter({
      url: opts.url,
      apiKey: opts.apiKey ?? "",
      collection: opts.collection ?? "agent_kb",
      embedProvider: provider,
      embedApiKey: opts.embedApiKey ?? "",
      embedModel,
      ollamaUrl: opts.ollamaUrl ?? "http://localhost:11434",
      vectorSize: opts.vectorSize ?? 768,
      chunkSize: opts.chunkSize ?? 3000,
      chunkOverlap: opts.chunkOverlap ?? 500,
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async search(
    query: string,
    opts: KnowledgeSearchOpts = {},
  ): Promise<KnowledgeHit[]> {
    const topK = opts.topK ?? 5;
    const minScore = opts.minScore ?? 0.15;

    await this.ensureCollection();
    const vector = await this.embed(query);

    const filter = buildTagFilter(opts.tags);
    const hits = await this.qdrantSearch(vector, topK, filter);

    return hits
      .filter((h) => h.score >= minScore)
      .map((h) => ({
        docId: h.payload?.docId ?? "",
        title: h.payload?.title ?? "",
        text: h.payload?.text ?? "",
        score: h.score,
        chunkIndex: h.payload?.chunkIndex ?? 0,
        tags: h.payload?.tags,
      }));
  }

  async indexDocument(
    docId: string,
    title: string,
    content: string,
    opts: KnowledgeIndexOpts = {},
  ): Promise<number> {
    const chunkSize = opts.chunkSize ?? this.defaultChunkSize;
    const chunkOverlap = opts.chunkOverlap ?? this.defaultChunkOverlap;

    await this.ensureCollection();

    // Delete existing chunks for this document before re-indexing
    await this.deletePointsByFilter({
      must: [{ key: "docId", match: { value: docId } }],
    });

    const chunks = smartChunk(content, chunkSize, chunkOverlap);
    if (chunks.length === 0) return 0;

    // Embed all chunks in one batch call
    const vectors = await this.embedBatch(chunks);

    const points: QdrantPoint[] = chunks.map((text, i) => ({
      id: randomPointId(),
      vector: vectors[i]!,
      payload: {
        docId,
        title,
        chunkIndex: i,
        text,
        tags: opts.tags ?? [],
      } satisfies ChunkPayload,
    }));

    await this.upsertPoints(points);
    return chunks.length;
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.ensureCollection();
    await this.deletePointsByFilter({
      must: [{ key: "docId", match: { value: docId } }],
    });
  }

  async getChunks(
    docId: string,
  ): Promise<Array<{ chunkIndex: number; text: string; title: string }>> {
    await this.ensureCollection();
    const filter: QdrantFilter = {
      must: [{ key: "docId", match: { value: docId } }],
    };

    const points = await this.qdrantScroll(filter);
    return points
      .map((p) => ({
        chunkIndex: (p.payload?.chunkIndex as number) ?? 0,
        text: (p.payload?.text as string) ?? "",
        title: (p.payload?.title as string) ?? "",
      }))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  // ─── Qdrant REST Client ──────────────────────────────────────────────────────

  private qdrantHeaders(): HeadersInit {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }

  private async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;
    const headers = this.qdrantHeaders();

    // Check if collection already exists
    const checkRes = await fetch(
      `${this.baseUrl}/collections/${this.collection}`,
      { headers },
    );

    if (checkRes.status === 404) {
      // Create collection
      const createRes = await fetch(
        `${this.baseUrl}/collections/${this.collection}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            vectors: { size: this.vectorSize, distance: "Cosine" },
          }),
        },
      );
      if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(
          `Qdrant: failed to create collection "${this.collection}": ${text}`,
        );
      }
    } else if (!checkRes.ok) {
      const text = await checkRes.text();
      throw new Error(
        `Qdrant: failed to check collection "${this.collection}": ${text}`,
      );
    }

    this.collectionReady = true;
  }

  private async qdrantSearch(
    vector: number[],
    topK: number,
    filter?: QdrantFilter,
  ): Promise<QdrantSearchHit[]> {
    const body: Record<string, unknown> = {
      vector,
      top: topK,
      with_payload: true,
      score_threshold: 0.0, // We filter by minScore in search()
    };
    if (filter && filter.must && filter.must.length > 0) body.filter = filter;

    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/search`,
      {
        method: "POST",
        headers: this.qdrantHeaders(),
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant search failed: ${text}`);
    }

    const data = (await res.json()) as { result: QdrantSearchHit[] };
    return data.result ?? [];
  }

  private async qdrantScroll(
    filter: QdrantFilter,
  ): Promise<Array<{ id: string; payload?: Record<string, unknown> }>> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/scroll`,
      {
        method: "POST",
        headers: this.qdrantHeaders(),
        body: JSON.stringify({ filter, limit: 1000, with_payload: true }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant scroll failed: ${text}`);
    }

    const data = (await res.json()) as {
      result: {
        points: Array<{ id: string; payload?: Record<string, unknown> }>;
      };
    };
    return data.result?.points ?? [];
  }

  private async upsertPoints(points: QdrantPoint[]): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points?wait=true`,
      {
        method: "PUT",
        headers: this.qdrantHeaders(),
        body: JSON.stringify({ points }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant upsert failed: ${text}`);
    }
  }

  private async deletePointsByFilter(filter: QdrantFilter): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/collections/${this.collection}/points/delete?wait=true`,
      {
        method: "POST",
        headers: this.qdrantHeaders(),
        body: JSON.stringify({ filter }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qdrant delete failed: ${text}`);
    }
  }

  // ─── Embedding ───────────────────────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, 2048);
    switch (this.provider) {
      case "gemini":
        return this.embedGemini(truncated);
      case "openai":
        return this.embedOpenAI(truncated);
      case "ollama":
        return this.embedOllama(truncated);
    }
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const truncated = texts.map((t) => t.slice(0, 2048));

    switch (this.provider) {
      case "gemini":
        return this.embedBatchGemini(truncated);
      case "openai":
        return this.embedBatchOpenAI(truncated);
      case "ollama":
        // Ollama has no batch endpoint — run sequentially
        return Promise.all(truncated.map((t) => this.embedOllama(t)));
    }
  }

  private async embedGemini(text: string): Promise<number[]> {
    const apiKey = this.embedApiKey;
    if (!apiKey) throw new Error("Gemini embedding requires embedApiKey");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.embedModel}:embedContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: this.vectorSize,
      }),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Gemini embed error (${res.status}): ${msg}`);
    }

    const data = (await res.json()) as { embedding: { values: number[] } };
    return data.embedding.values;
  }

  private async embedBatchGemini(texts: string[]): Promise<number[][]> {
    const apiKey = this.embedApiKey;
    if (!apiKey) throw new Error("Gemini embedding requires embedApiKey");

    const model = `models/${this.embedModel}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents?key=${apiKey}`;

    // Gemini batch: up to 100 items per call
    const BATCH = 100;
    const all: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: slice.map((text) => ({
            model,
            content: { parts: [{ text }] },
            outputDimensionality: this.vectorSize,
          })),
        }),
      });

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Gemini batch embed error (${res.status}): ${msg}`);
      }

      const data = (await res.json()) as {
        embeddings: Array<{ values: number[] }>;
      };
      all.push(...data.embeddings.map((e) => e.values));
    }

    return all;
  }

  private async embedOpenAI(text: string): Promise<number[]> {
    const apiKey = this.embedApiKey;
    if (!apiKey) throw new Error("OpenAI embedding requires embedApiKey");

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.embedModel,
        input: text,
        dimensions: this.vectorSize,
      }),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`OpenAI embed error (${res.status}): ${msg}`);
    }

    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0]!.embedding;
  }

  private async embedBatchOpenAI(texts: string[]): Promise<number[][]> {
    const apiKey = this.embedApiKey;
    if (!apiKey) throw new Error("OpenAI embedding requires embedApiKey");

    // OpenAI accepts array input for batch
    const BATCH = 100;
    const all: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.embedModel,
          input: slice,
          dimensions: this.vectorSize,
        }),
      });

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`OpenAI batch embed error (${res.status}): ${msg}`);
      }

      const data = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      // OpenAI returns in order — sort by index for safety
      const sorted = data.data.sort((a, b) => a.index - b.index);
      all.push(...sorted.map((d) => d.embedding));
    }

    return all;
  }

  private async embedOllama(text: string): Promise<number[]> {
    const model = this.embedModel;
    const res = await fetch(`${this.ollamaUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Ollama embed error (${res.status}): ${msg}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
      embedding?: number[];
    };

    // Ollama can return either format
    const embedding = data.data?.[0]?.embedding ?? data.embedding;
    if (!embedding?.length) throw new Error("Ollama returned empty embedding");
    return embedding;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks.
 *
 * Strategy: sentence-aware — tries to break at ". " or "\n" boundaries
 * near the chunk boundary. Falls back to hard cut if no boundary found.
 */
export function smartChunk(
  text: string,
  chunkSize = 3000,
  overlap = 500,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    const end = Math.min(start + chunkSize, trimmed.length);

    if (end === trimmed.length) {
      // Last chunk — take remainder
      const chunk = trimmed.slice(start).trim();
      if (chunk) chunks.push(chunk);
      break;
    }

    // Try to break at a sentence/paragraph boundary near `end`
    let breakAt = end;
    const searchStart = Math.max(
      start + Math.floor(chunkSize * 0.7),
      end - 200,
    );
    const searchSlice = trimmed.slice(searchStart, end);

    const paraBreak = searchSlice.lastIndexOf("\n\n");
    const sentBreak = searchSlice.lastIndexOf(". ");
    const lineBreak = searchSlice.lastIndexOf("\n");

    if (paraBreak !== -1) {
      breakAt = searchStart + paraBreak + 2;
    } else if (sentBreak !== -1) {
      breakAt = searchStart + sentBreak + 2;
    } else if (lineBreak !== -1) {
      breakAt = searchStart + lineBreak + 1;
    }

    const chunk = trimmed.slice(start, breakAt).trim();
    if (chunk) chunks.push(chunk);

    // Next chunk starts with overlap
    start = Math.max(start + 1, breakAt - overlap);
  }

  return chunks;
}

function resolveProvider(opts: QdrantKnowledgeOptions): EmbedProvider {
  if (opts.embedProvider) return opts.embedProvider;
  if (opts.embedApiKey) return "gemini"; // default to gemini when key provided
  return "ollama";
}

function resolveEmbedModel(
  provider: EmbedProvider,
  modelOverride?: string,
): string {
  if (modelOverride) return modelOverride;
  switch (provider) {
    case "gemini":
      return "text-embedding-004";
    case "openai":
      return "text-embedding-3-small";
    case "ollama":
      return "nomic-embed-text";
  }
}

function buildTagFilter(tags?: string[]): QdrantFilter {
  if (!tags || tags.length === 0) return {};
  return {
    must: tags.map((tag) => ({ key: "tags", match: { value: tag } })),
  };
}

/** Generate a random UUID v4 for Qdrant point IDs. */
function randomPointId(): string {
  // crypto.randomUUID is available in Node.js 14.17+
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
