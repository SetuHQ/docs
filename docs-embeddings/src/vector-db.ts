/**
 * Vector Database Client (Pinecone)
 */

import { Pinecone } from '@pinecone-database/pinecone';
import type { VectorRecord } from './types.js';

export class VectorDB {
  private client: Pinecone;
  private indexName: string;
  private index: any;

  constructor(apiKey: string, indexName: string) {
    this.client = new Pinecone({ apiKey });
    this.indexName = indexName;
  }

  /**
   * Initialize connection to index
   */
  async connect(): Promise<void> {
    this.index = this.client.index(this.indexName);
    console.log(`Connected to Pinecone index: ${this.indexName}`);
  }

  /**
   * Upsert vectors in batches
   *
   * Upsert = INSERT if not exists, UPDATE if exists (by ID)
   */
  async upsertVectors(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    const vectors = records.map(record => ({
      id: record.id,
      values: record.embedding,
      metadata: record.metadata
    }));

    await this.index.upsert(vectors);
  }

  /**
   * Delete vectors by IDs
   */
  async deleteVectors(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.index.deleteMany(ids);
  }

  /**
   * Fetch vectors by IDs (returns embeddings + metadata)
   *
   * Used for metadata-only updates to avoid re-embedding
   *
   * Batches fetch requests to avoid 414 URI Too Large errors
   */
  async fetchVectors(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map();

    const embeddings = new Map<string, number[]>();
    const FETCH_BATCH_SIZE = 100; // Max IDs per fetch request to avoid 414 errors

    // Batch fetch to avoid URI length limits
    for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE) {
      const batch = ids.slice(i, i + FETCH_BATCH_SIZE);
      const result = await this.index.fetch(batch);

      for (const id of batch) {
        if (result.records[id]) {
          embeddings.set(id, result.records[id].values);
        }
      }
    }

    return embeddings;
  }

  /**
   * Get index stats
   */
  async getStats(): Promise<{ totalVectorCount: number }> {
    const stats = await this.index.describeIndexStats();
    return {
      totalVectorCount: stats.totalRecordCount || 0
    };
  }

  /**
   * List all vector IDs in the index.
   *
   * Tries listPaginated first (serverless indexes), then falls back
   * to a zero-vector query (pod-based indexes, capped at 10 000).
   */
  async listAllIds(): Promise<string[]> {
    const allIds: string[] = [];

    // Attempt 1: listPaginated (available on serverless indexes)
    try {
      let paginationToken: string | undefined;
      do {
        const response: any = await this.index.listPaginated({
          limit: 100,
          paginationToken
        });

        if (response.vectors) {
          for (const v of response.vectors) {
            if (v.id) allIds.push(v.id);
          }
        }

        paginationToken = response.pagination?.next;
      } while (paginationToken);

      return allIds;
    } catch {
      // listPaginated not available — fall through
    }

    // Attempt 2: zero-vector query (works on all index types, max 10 000)
    const stats = await this.getStats();
    const topK = Math.min(stats.totalVectorCount, 10000);

    if (topK === 0) return [];

    const result = await this.index.query({
      vector: new Array(1024).fill(0),
      topK,
      includeMetadata: false,
      includeValues: false
    });

    if (result.matches) {
      for (const match of result.matches) {
        allIds.push(match.id);
      }
    }

    if (allIds.length === topK) {
      console.warn(`Warning: Pinecone returned exactly ${topK} results — index may contain more vectors. Consider paginated listing.`);
    }

    return allIds;
  }

  /**
   * Fetch vector metadata by IDs (drops embedding values).
   *
   * Used for backup — saves IDs + metadata without large embedding arrays.
   */
  async fetchVectorsWithMetadata(
    ids: string[]
  ): Promise<Array<{ id: string; metadata: Record<string, any> }>> {
    if (ids.length === 0) return [];

    const results: Array<{ id: string; metadata: Record<string, any> }> = [];
    const BATCH = 100;

    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const response = await this.index.fetch(batch);

      for (const id of batch) {
        if (response.records[id]) {
          results.push({
            id,
            metadata: response.records[id].metadata || {}
          });
        }
      }
    }

    return results;
  }
}
