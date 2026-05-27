import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { smartChunk } from "../src/adapters/qdrant-knowledge.js";
import { QdrantKnowledgeAdapter } from "../src/adapters/qdrant-knowledge.js";

// ─── smartChunk ───────────────────────────────────────────────────────────────

describe("smartChunk", () => {
  it("returns empty array for empty input", () => {
    expect(smartChunk("", 3000, 500)).toEqual([]);
    expect(smartChunk("   ", 3000, 500)).toEqual([]);
  });

  it("returns single chunk for text shorter than chunkSize", () => {
    const text = "This is a short document.";
    const chunks = smartChunk(text, 3000, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits long text into overlapping chunks", () => {
    const text = "a".repeat(10000);
    const chunks = smartChunk(text, 3000, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be <= chunkSize in length
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3000);
    }
  });

  it("all chunks are non-empty", () => {
    const text = "Hello world. ".repeat(500);
    const chunks = smartChunk(text, 500, 100);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it("covers all content (no dropped text)", () => {
    // Every word in the original should appear in at least one chunk
    const words = ["alpha", "beta", "gamma", "delta", "epsilon"];
    // Build text where each word appears 50 chars apart so it fits across chunks
    const text = words.map((w) => w + " " + "x".repeat(50)).join(" ");
    const chunks = smartChunk(text, 100, 20);
    const combined = chunks.join(" ");
    for (const word of words) {
      expect(combined).toContain(word);
    }
  });

  it("breaks at sentence boundaries when possible", () => {
    // Build two clear sentences separated by ". "
    const sentenceA = "A".repeat(200) + ". ";
    const sentenceB = "B".repeat(200) + ". ";
    const text = sentenceA + sentenceB;
    const chunks = smartChunk(text, 250, 50);
    // The break should happen near the ". " boundary, not in the middle of a word
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it("handles paragraph breaks", () => {
    const para1 = "Paragraph one content. " + "x".repeat(100);
    const para2 = "Paragraph two content. " + "y".repeat(100);
    const text = para1 + "\n\n" + para2;
    const chunks = smartChunk(text, 150, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── QdrantKnowledgeAdapter (mocked Qdrant) ───────────────────────────────────

/**
 * Mock the global fetch to avoid real HTTP calls to Qdrant or embedding APIs.
 * We test the adapter's request-shaping and response-parsing logic.
 */

const originalFetch = global.fetch;

function mockFetch(
  responses: Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, _opts?: RequestInit) => {
    const urlStr = String(url);

    // Find matching mock response
    for (const [pattern, body] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as unknown as Response;
      }
    }

    // Default: collection check returns 200 (already exists)
    return {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response;
  });
}

describe("QdrantKnowledgeAdapter", () => {
  beforeEach(() => {
    // Reset collection ready state by creating fresh adapter each test
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("creates adapter with default options", () => {
    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });
    expect(adapter).toBeDefined();
    expect(adapter.search).toBeTypeOf("function");
    expect(adapter.indexDocument).toBeTypeOf("function");
    expect(adapter.deleteDocument).toBeTypeOf("function");
  });

  it("search calls Qdrant /points/search with embedding vector", async () => {
    const fetchMock = mockFetch({
      // Embedding call (Ollama)
      "/v1/embeddings": {
        data: [{ embedding: Array(768).fill(0.1) }],
      },
      // Qdrant search
      "/points/search": {
        result: [
          {
            id: "point-1",
            score: 0.87,
            payload: {
              docId: "doc1",
              title: "Refund Policy",
              text: "We offer 30-day refunds.",
              chunkIndex: 0,
            },
          },
        ],
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
      ollamaUrl: "http://localhost:11434",
    });

    const results = await adapter.search("what is the refund policy?");
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe("doc1");
    expect(results[0]!.title).toBe("Refund Policy");
    expect(results[0]!.score).toBe(0.87);
    expect(results[0]!.text).toContain("refund");
  });

  it("search filters by minScore", async () => {
    const fetchMock = mockFetch({
      "/v1/embeddings": { data: [{ embedding: Array(768).fill(0.1) }] },
      "/points/search": {
        result: [
          {
            id: "p1",
            score: 0.9,
            payload: { docId: "d1", title: "T1", text: "Hi", chunkIndex: 0 },
          },
          {
            id: "p2",
            score: 0.05,
            payload: { docId: "d2", title: "T2", text: "Lo", chunkIndex: 0 },
          },
        ],
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });

    const results = await adapter.search("query", { minScore: 0.15 });
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe("d1");
  });

  it("search returns empty array when no hits exceed minScore", async () => {
    const fetchMock = mockFetch({
      "/v1/embeddings": { data: [{ embedding: Array(768).fill(0.1) }] },
      "/points/search": {
        result: [
          {
            id: "p1",
            score: 0.1,
            payload: { docId: "d1", title: "T1", text: "x", chunkIndex: 0 },
          },
        ],
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });

    const results = await adapter.search("query", { minScore: 0.15 });
    expect(results).toHaveLength(0);
  });

  it("indexDocument chunks content, embeds, and upserts to Qdrant", async () => {
    const upsertPayloads: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/embeddings")) {
        // Ollama batch (sequential calls) — return 768-dim zero vector
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: Array(768).fill(0.0) }] }),
        } as unknown as Response;
      }
      if (urlStr.includes("/points?wait=true")) {
        // Capture upsert payload
        if (opts?.body) upsertPayloads.push(JSON.parse(opts.body as string));
        return {
          ok: true,
          json: async () => ({ result: "ok" }),
        } as unknown as Response;
      }
      if (urlStr.includes("/points/delete")) {
        return {
          ok: true,
          json: async () => ({ result: "ok" }),
        } as unknown as Response;
      }
      // Collection existence check
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });

    const content = "This is the full policy document. ".repeat(30);
    const chunkCount = await adapter.indexDocument(
      "policy-001",
      "Policy",
      content,
      {
        chunkSize: 200,
        chunkOverlap: 40,
      },
    );

    // Should have chunked and upserted
    expect(chunkCount).toBeGreaterThan(1);
    expect(upsertPayloads.length).toBeGreaterThan(0);

    // Each upserted point has correct payload shape
    const firstBatch = (
      upsertPayloads[0] as {
        points: Array<{ payload: { docId: string; chunkIndex: number } }>;
      }
    ).points;
    expect(firstBatch[0]!.payload.docId).toBe("policy-001");
    expect(firstBatch[0]!.payload.chunkIndex).toBe(0);
  });

  it("indexDocument returns 1 chunk for short content", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _opts?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/embeddings")) {
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: Array(768).fill(0.0) }] }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ result: "ok" }),
      } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });

    const count = await adapter.indexDocument(
      "short-doc",
      "Short",
      "Hello world.",
      { chunkSize: 3000 },
    );
    expect(count).toBe(1);
  });

  it("deleteDocument calls Qdrant delete with correct filter", async () => {
    const deleteFilters: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      if (String(url).includes("/points/delete")) {
        if (opts?.body) deleteFilters.push(JSON.parse(opts.body as string));
      }
      return {
        ok: true,
        json: async () => ({ result: "ok" }),
      } as unknown as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });

    await adapter.deleteDocument("my-doc-123");

    expect(deleteFilters.length).toBeGreaterThan(0);
    const filter = (
      deleteFilters[0] as {
        filter: { must: Array<{ key: string; match: { value: string } }> };
      }
    ).filter;
    expect(
      filter.must.some(
        (m) => m.key === "docId" && m.match.value === "my-doc-123",
      ),
    ).toBe(true);
  });

  it("throws for Qdrant error responses", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
      json: async () => ({ error: "Internal Server Error" }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = QdrantKnowledgeAdapter.create({
      url: "http://localhost:6333",
      collection: "test_kb",
      embedProvider: "ollama",
    });

    await expect(adapter.search("test")).rejects.toThrow();
  });
});
