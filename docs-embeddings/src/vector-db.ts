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
      metadata: {
        // FIX #2: content removed from metadata
        doc_path: record.metadata.doc_path,
        section_path: record.metadata.section_path,
        page_context: record.metadata.page_context,
        source_repo: record.metadata.source_repo,
        commit_sha: record.metadata.commit_sha,
        is_oversized: record.metadata.is_oversized,
        token_count: record.metadata.token_count,
        url: record.metadata.url
      }
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
   */
  async fetchVectors(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map();

    const result = await this.index.fetch(ids);
    const embeddings = new Map<string, number[]>();

    for (const id of ids) {
      if (result.records[id]) {
        embeddings.set(id, result.records[id].values);
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
}
