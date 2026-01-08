/**
 * Incremental Embedding Sync
 *
 * FIX #1: Generate embeddings ONLY for new content_hash values
 * FIX #2: Do not store content in vector metadata
 */

import * as fs from 'fs/promises';
import { BedrockEmbedder } from './embedder.js';
import { VectorDB } from './vector-db.js';
import type {
  DocumentChunk,
  VectorRecord,
  SyncState,
  SyncStats,
  EmbeddingConfig
} from './types.js';

export class EmbeddingSync {
  private embedder: BedrockEmbedder;
  private vectorDB: VectorDB;
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.embedder = new BedrockEmbedder(config.awsRegion, config.bedrockModelId);
    this.vectorDB = new VectorDB(config.pineconeApiKey, config.pineconeIndex);
  }

  /**
   * Run incremental sync
   */
  async sync(): Promise<SyncStats> {
    const startTime = Date.now();

    console.log('🔄 Starting embedding sync\n');

    // Connect to vector DB
    await this.vectorDB.connect();

    // Load ingestion output
    console.log('📥 Loading ingestion output...');
    const chunks = await this.loadChunks();
    console.log(`   Loaded ${chunks.length} chunks\n`);

    // Filter embeddable chunks
    console.log('🔍 Filtering embeddable chunks...');
    const { embeddable, tooSmall, tooLarge } = this.filterChunks(chunks);
    console.log(`   Embeddable: ${embeddable.length}`);
    console.log(`   Too small: ${tooSmall.length}`);
    console.log(`   Too large: ${tooLarge.length}\n`);

    // Load previous state
    console.log('📋 Loading previous sync state...');
    const previousState = await this.loadState();
    console.log(`   Previously indexed: ${previousState.indexed_hashes.size} vectors\n`);

    // Determine operations
    console.log('🔎 Determining sync operations...');
    const operations = this.determineSyncOperations(
      embeddable,
      previousState.indexed_hashes
    );
    console.log(`   To insert (new): ${operations.toInsert.length}`);
    console.log(`   To update (metadata only): ${operations.toUpdate.length}`);
    console.log(`   To delete (stale): ${operations.toDelete.length}\n`);

    let inserted = 0;
    let updated = 0;

    // FIX #1: Generate embeddings ONLY for new chunks
    if (operations.toInsert.length > 0) {
      console.log(`🤖 Generating ${operations.toInsert.length} NEW embeddings...`);

      const newVectorRecords = await this.generateVectorRecords(operations.toInsert);

      console.log('   Done\n');

      // Upsert new vectors
      console.log('💾 Upserting new vectors to database...');
      await this.batchUpsert(newVectorRecords);
      inserted = operations.toInsert.length;
      console.log(`   Upserted ${newVectorRecords.length} new vectors\n`);
    }

    // FIX #1: Update metadata without re-embedding
    if (operations.toUpdate.length > 0) {
      console.log(`📝 Updating metadata for ${operations.toUpdate.length} existing vectors...`);
      console.log('   (No embedding generation - content_hash unchanged)');

      const updatedVectorRecords = await this.updateMetadataOnly(operations.toUpdate);

      console.log('   Done\n');

      // Upsert updated metadata
      console.log('💾 Upserting metadata updates to database...');
      await this.batchUpsert(updatedVectorRecords);
      updated = operations.toUpdate.length;
      console.log(`   Updated ${updatedVectorRecords.length} vectors\n`);
    }

    // Delete removed chunks
    let deleted = 0;
    if (operations.toDelete.length > 0) {
      console.log(`🗑️  Deleting ${operations.toDelete.length} stale vectors...`);
      await this.batchDelete(operations.toDelete);
      deleted = operations.toDelete.length;
      console.log('   Done\n');
    }

    // Save new state
    console.log('💾 Saving sync state...');
    const newState: SyncState = {
      commit_sha: chunks[0]?.commit_sha || previousState.commit_sha,
      indexed_hashes: new Set(embeddable.map(c => c.content_hash)),
      total_vectors: embeddable.length,
      last_synced: new Date().toISOString()
    };
    await this.saveState(newState);
    console.log('   Done\n');

    // Calculate stats
    const stats: SyncStats = {
      total_chunks: chunks.length,
      embeddable_chunks: embeddable.length,
      skipped_too_small: tooSmall.length,
      skipped_too_large: tooLarge.length,
      vectors_inserted: inserted,
      vectors_updated: updated,
      vectors_deleted: deleted,
      embedding_api_calls: this.embedder.getApiCallCount(),  // Should be 0 on re-run
      sync_duration_ms: Date.now() - startTime
    };

    this.printSummary(stats);

    return stats;
  }

  /**
   * Load chunks from ingestion output
   */
  private async loadChunks(): Promise<DocumentChunk[]> {
    const content = await fs.readFile(this.config.ingestionOutputPath, 'utf-8');
    const data = JSON.parse(content);
    return data.chunks;
  }

  /**
   * Filter chunks by embeddability
   */
  private filterChunks(chunks: DocumentChunk[]) {
    const embeddable: DocumentChunk[] = [];
    const tooSmall: DocumentChunk[] = [];
    const tooLarge: DocumentChunk[] = [];

    for (const chunk of chunks) {
      if (chunk.token_count < 80) {
        tooSmall.push(chunk);
      } else if (chunk.token_count > 1500) {
        tooLarge.push(chunk);
      } else {
        embeddable.push(chunk);
      }
    }

    return { embeddable, tooSmall, tooLarge };
  }

  /**
   * Load previous sync state
   */
  private async loadState(): Promise<SyncState> {
    try {
      const content = await fs.readFile(this.config.stateFilePath, 'utf-8');
      const data = JSON.parse(content);
      return {
        commit_sha: data.commit_sha,
        indexed_hashes: new Set(data.indexed_hashes),
        total_vectors: data.total_vectors,
        last_synced: data.last_synced
      };
    } catch (error) {
      // No previous state - first run
      return {
        commit_sha: '',
        indexed_hashes: new Set(),
        total_vectors: 0,
        last_synced: new Date().toISOString()
      };
    }
  }

  /**
   * Save sync state
   */
  private async saveState(state: SyncState): Promise<void> {
    const data = {
      commit_sha: state.commit_sha,
      indexed_hashes: Array.from(state.indexed_hashes),
      total_vectors: state.total_vectors,
      last_synced: state.last_synced
    };

    await fs.writeFile(
      this.config.stateFilePath,
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }

  /**
   * Determine what to insert/update/delete
   *
   * FIX #1: Separate NEW chunks from EXISTING chunks
   */
  private determineSyncOperations(
    currentChunks: DocumentChunk[],
    previousHashes: Set<string>
  ) {
    const currentHashes = new Set(currentChunks.map(c => c.content_hash));

    const toInsert: DocumentChunk[] = [];
    const toUpdate: DocumentChunk[] = [];
    const toDelete: string[] = [];

    // Determine inserts and updates
    for (const chunk of currentChunks) {
      if (previousHashes.has(chunk.content_hash)) {
        // Hash exists - metadata may have changed, but content is identical
        // Update metadata only, do NOT regenerate embedding
        toUpdate.push(chunk);
      } else {
        // Hash doesn't exist - this is a NEW chunk
        // Generate embedding and insert
        toInsert.push(chunk);
      }
    }

    // Determine deletes
    for (const hash of previousHashes) {
      if (!currentHashes.has(hash)) {
        toDelete.push(hash);
      }
    }

    return { toInsert, toUpdate, toDelete };
  }

  /**
   * Generate vector records with NEW embeddings
   *
   * FIX #1: Only called for new content_hash values
   * FIX #2: Do not include content in metadata
   */
  private async generateVectorRecords(
    chunks: DocumentChunk[]
  ): Promise<VectorRecord[]> {
    const records: VectorRecord[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Generate embedding (Bedrock API call)
      const embedding = await this.embedder.generateEmbedding(chunk.content);

      // Create vector record WITHOUT content in metadata
      const record: VectorRecord = {
        id: chunk.content_hash,
        embedding,
        metadata: {
          doc_path: chunk.doc_path,
          section_path: JSON.stringify(chunk.section_path),
          page_context: chunk.page_context,
          source_repo: chunk.source_repo,
          commit_sha: chunk.commit_sha,
          is_oversized: chunk.is_oversized,
          token_count: chunk.token_count,
          url: chunk.url
        }
      };

      records.push(record);

      // Progress indicator
      if ((i + 1) % 50 === 0) {
        console.log(`   Generated ${i + 1}/${chunks.length} embeddings...`);
      }
    }

    return records;
  }

  /**
   * Update metadata only for existing vectors
   *
   * FIX #1: Fetch existing embeddings from DB, update metadata only
   * Does NOT call Bedrock API
   */
  private async updateMetadataOnly(
    chunks: DocumentChunk[]
  ): Promise<VectorRecord[]> {
    if (chunks.length === 0) return [];

    const contentHashes = chunks.map(c => c.content_hash);

    // Fetch existing embeddings from vector DB
    console.log(`   Fetching ${contentHashes.length} existing embeddings from DB...`);
    const existingEmbeddings = await this.vectorDB.fetchVectors(contentHashes);

    const records: VectorRecord[] = [];

    for (const chunk of chunks) {
      const embedding = existingEmbeddings.get(chunk.content_hash);

      if (!embedding) {
        console.warn(`   Warning: Missing embedding for hash ${chunk.content_hash}, skipping update`);
        continue;
      }

      // Create vector record with EXISTING embedding + NEW metadata
      const record: VectorRecord = {
        id: chunk.content_hash,
        embedding,  // Reuse existing embedding
        metadata: {
          doc_path: chunk.doc_path,
          section_path: JSON.stringify(chunk.section_path),
          page_context: chunk.page_context,
          source_repo: chunk.source_repo,
          commit_sha: chunk.commit_sha,
          is_oversized: chunk.is_oversized,
          token_count: chunk.token_count,
          url: chunk.url
        }
      };

      records.push(record);
    }

    return records;
  }

  /**
   * Batch upsert vectors
   */
  private async batchUpsert(records: VectorRecord[]): Promise<void> {
    const batchSize = this.config.batchSize;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.vectorDB.upsertVectors(batch);

      // Progress indicator
      if ((i + batchSize) % 500 === 0 && i + batchSize < records.length) {
        console.log(`   Upserted ${Math.min(i + batchSize, records.length)}/${records.length} vectors...`);
      }
    }
  }

  /**
   * Batch delete vectors
   */
  private async batchDelete(ids: string[]): Promise<void> {
    const batchSize = this.config.batchSize;

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await this.vectorDB.deleteVectors(batch);
    }
  }

  /**
   * Print summary
   */
  private printSummary(stats: SyncStats): void {
    console.log('📊 Embedding Sync Summary');
    console.log('═══════════════════════════════════════');
    console.log(`Total chunks:          ${stats.total_chunks}`);
    console.log(`Embeddable chunks:     ${stats.embeddable_chunks}`);
    console.log('');
    console.log(`Skipped (< 80 tok):    ${stats.skipped_too_small}`);
    console.log(`Skipped (> 1500 tok):  ${stats.skipped_too_large}`);
    console.log('');
    console.log(`Vectors inserted:      ${stats.vectors_inserted}`);
    console.log(`Vectors updated:       ${stats.vectors_updated} (metadata only)`);
    console.log(`Vectors deleted:       ${stats.vectors_deleted}`);
    console.log('');
    console.log(`Bedrock API calls:     ${stats.embedding_api_calls}`);
    console.log(`Sync duration:         ${(stats.sync_duration_ms / 1000).toFixed(2)}s`);
    console.log('═══════════════════════════════════════\n');

    if (stats.embedding_api_calls === 0 && stats.vectors_inserted === 0) {
      console.log('✅ No new content - zero embedding calls made\n');
    }

    console.log('✨ Embedding sync complete!\n');
  }
}
