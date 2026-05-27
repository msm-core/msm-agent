/**
 * KnowledgeAdapter — Vector knowledge base interface.
 *
 * Separate from MemoryAdapter (session history) — this is for static indexed
 * documents that the agent can retrieve via semantic similarity search.
 *
 * Typical flow:
 *   1. Before deployment: index your docs via adapter.indexDocument()
 *   2. At runtime: agent loop calls adapter.search(query) and injects hits
 *      into the brain prompt as [knowledge] context entries
 *
 * Use QdrantKnowledgeAdapter for production (Qdrant vector DB).
 */

export interface KnowledgeHit {
  /** Document identifier provided at indexing time. */
  docId: string;
  /** Document title provided at indexing time. */
  title: string;
  /** The matching chunk text. */
  text: string;
  /** Cosine similarity score (0–1). Higher is more relevant. */
  score: number;
  /** Index of this chunk within the document (0-based). */
  chunkIndex: number;
  /** Optional tags provided at indexing time. */
  tags?: string[];
}

export interface KnowledgeSearchOpts {
  /**
   * Maximum number of hits to return.
   * @default 5
   */
  topK?: number;
  /**
   * Minimum score threshold — hits below this are discarded.
   * @default 0.15
   */
  minScore?: number;
  /**
   * Filter by tags (AND logic — chunk must have all provided tags).
   */
  tags?: string[];
}

export interface KnowledgeIndexOpts {
  /** Optional tags for filtering at search time. */
  tags?: string[];
  /**
   * Chunk size in characters.
   * @default 3000
   */
  chunkSize?: number;
  /**
   * Overlap between consecutive chunks in characters.
   * @default 500
   */
  chunkOverlap?: number;
}

export interface KnowledgeAdapter {
  /**
   * Search the knowledge base using a natural-language query.
   * The adapter generates the query embedding internally.
   */
  search(query: string, opts?: KnowledgeSearchOpts): Promise<KnowledgeHit[]>;

  /**
   * Index a document into the knowledge base.
   * Chunks the content, embeds each chunk, and upserts to the vector store.
   * Re-indexing an existing docId replaces all its chunks.
   *
   * @returns Number of chunks indexed.
   */
  indexDocument(
    docId: string,
    title: string,
    content: string,
    opts?: KnowledgeIndexOpts,
  ): Promise<number>;

  /**
   * Remove all vectors for a document.
   */
  deleteDocument(docId: string): Promise<void>;

  /**
   * Retrieve all indexed chunks for a document (no vector query).
   * Useful for inspection and re-indexing workflows.
   */
  getChunks?(
    docId: string,
  ): Promise<Array<{ chunkIndex: number; text: string; title: string }>>;

  /**
   * Clean up connections (if any) on shutdown.
   */
  close?(): Promise<void>;
}
