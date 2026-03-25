/**
 * Incremental Embedding Sync
 *
 * FIX #1: Generate embeddings ONLY for new content_hash values
 * FIX #2: Do not store content in vector metadata
 */

import * as fs from 'fs/promises';
import { BedrockEmbedder } from './embedder.js';
import { VectorDB } from './vector-db.js';
import { ContentUploader } from './content-uploader.js';
import type {
  DocumentChunk,
  VectorRecord,
  SyncState,
  SyncStats,
  EmbeddingConfig
} from './types.js';

const REQUIRED_CHUNK_FIELDS: (keyof DocumentChunk)[] = [
  'content',
  'doc_path',
  'section',
  'url',
  'content_hash',
  'source_repo',
  'commit_sha',
  'token_count',
];

// Titan v2 embedding dimension
const EMBEDDING_DIM = 1024;

// Embedding token thresholds (must match embedding-helpers.ts in docs-ingestion)
const MIN_EMBEDDABLE_TOKENS = 80;
const MAX_EMBEDDABLE_TOKENS = 1400;

export class EmbeddingSync {
  private embedder: BedrockEmbedder;
  private vectorDB: VectorDB | null = null;
  private config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = config;
    this.embedder = new BedrockEmbedder(config.awsRegion, config.bedrockModelId);
    // Defer VectorDB construction — Pinecone validates apiKey eagerly,
    // and dry-run mode doesn't need a real key.
    if (!config.dryRun) {
      this.vectorDB = new VectorDB(config.pineconeApiKey, config.pineconeIndex);
    }
  }

  private getVectorDB(): VectorDB {
    if (!this.vectorDB) {
      throw new Error('VectorDB not initialized (are you in dry-run mode?)');
    }
    return this.vectorDB;
  }

  /**
   * Run incremental sync
   */
  async sync(): Promise<SyncStats> {
    const startTime = Date.now();
    const dryRun = this.config.dryRun ?? false;

    console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

    if (dryRun) {
      console.log('🔄 Starting embedding sync (DRY RUN — no external calls)\n');
    } else {
      console.log('🔄 Starting embedding sync\n');
    }

    // Connect to vector DB (skip in dry-run)
    if (!dryRun) {
      await this.getVectorDB().connect();
    }

    // Load ingestion output
    console.log('📥 Loading ingestion output...');
    const chunks = await this.loadChunks();
    console.log(`   Loaded ${chunks.length} chunks`);
    console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`);

    // Validate required fields on all chunks
    if (dryRun) {
      console.log('✅ Validating required fields...');
      const validationErrors = this.validateChunkFields(chunks);
      if (validationErrors.length > 0) {
        console.error('   VALIDATION FAILURES:');
        for (const err of validationErrors.slice(0, 20)) {
          console.error(`   ${err}`);
        }
        throw new Error(`${validationErrors.length} chunks have missing required fields`);
      }
      console.log(`   All ${chunks.length} chunks have required fields\n`);
    }

    // Upload ALL chunks to S3 (content retrieval layer)
    let s3Uploaded = 0;
    let s3Skipped = 0;
    if (this.config.s3ContentBucket && !dryRun) {
      console.log('📦 Uploading content to S3...');
      const uploader = new ContentUploader(
        this.config.s3ContentBucket,
        this.config.awsRegion
      );
      const s3Result = await uploader.uploadChunks(chunks);
      s3Uploaded = s3Result.uploaded;
      s3Skipped = s3Result.skipped;
    } else if (dryRun && this.config.s3ContentBucket) {
      console.log(`📦 S3 upload: would upload to bucket "${this.config.s3ContentBucket}" (skipped — dry run)\n`);
    } else if (!this.config.s3ContentBucket) {
      console.log('📦 S3 upload: skipped (no CONTENT_BUCKET_NAME configured)\n');
    }

    // Filter embeddable chunks
    console.log('🔍 Filtering embeddable chunks...');
    const { embeddable: rawEmbeddable, tooSmall, tooLarge } = this.filterChunks(chunks);

    // Deduplicate by content_hash — if chunks.json carries duplicates
    // (e.g. from a merge bug), process each content_hash only once.
    const seen = new Set<string>();
    const embeddable: DocumentChunk[] = [];
    for (const chunk of rawEmbeddable) {
      if (!seen.has(chunk.content_hash)) {
        seen.add(chunk.content_hash);
        embeddable.push(chunk);
      }
    }
    const deduped = rawEmbeddable.length - embeddable.length;

    console.log(`   Embeddable: ${embeddable.length}${deduped > 0 ? ` (${deduped} duplicates removed)` : ''}`);
    console.log(`   Too small: ${tooSmall.length}`);
    console.log(`   Too large: ${tooLarge.length}\n`);

    // Load previous state (empty state in dry-run)
    let previousState: SyncState;
    if (dryRun) {
      previousState = {
        commit_sha: '',
        indexed_hashes: new Set(),
        total_vectors: 0,
        last_synced: new Date().toISOString()
      };
      console.log('📋 Skipping state file (dry run)\n');
    } else {
      console.log('📋 Loading previous sync state...');
      previousState = await this.loadState();
      console.log(`   Previously indexed: ${previousState.indexed_hashes.size} vectors\n`);
    }

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

    if (dryRun) {
      // Dry run: generate mock embeddings to validate dimensions
      console.log(`🤖 Validating ${operations.toInsert.length} chunks can be embedded (mock)...`);
      const mockRecords = this.generateMockVectorRecords(operations.toInsert);
      const badDim = mockRecords.filter(r => r.embedding.length !== EMBEDDING_DIM);
      if (badDim.length > 0) {
        throw new Error(`${badDim.length} mock vectors have wrong dimensions`);
      }
      console.log(`   Mock vector dimension: ${EMBEDDING_DIM}`);
      console.log(`   All ${mockRecords.length} records valid\n`);
      inserted = operations.toInsert.length;
      updated = operations.toUpdate.length;
    } else {
      // FIX #1: Generate embeddings ONLY for new chunks.
      // Process in stages of STAGE_SIZE to allow periodic state saves.
      // If the process crashes at stage N, stages 0..N-1 are already
      // persisted in the state file and won't be re-embedded on retry.
      if (operations.toInsert.length > 0) {
        const STAGE_SIZE = 100;
        const stages = Math.ceil(operations.toInsert.length / STAGE_SIZE);
        const embeddedHashes = new Set<string>();
        console.log(`🤖 Generating ${operations.toInsert.length} NEW embeddings (${stages} stages of up to ${STAGE_SIZE})...\n`);

        for (let s = 0; s < operations.toInsert.length; s += STAGE_SIZE) {
          const stage = operations.toInsert.slice(s, s + STAGE_SIZE);
          const stageNum = Math.floor(s / STAGE_SIZE) + 1;

          // Embed
          const stageRecords = await this.generateVectorRecords(stage);
          inserted += stageRecords.length;

          // Track only successfully embedded hashes
          for (const record of stageRecords) {
            embeddedHashes.add(record.id);
          }

          // Upsert FIRST — Pinecone upsert is idempotent by ID, so
          // re-upserting on retry is safe. State is saved AFTER upsert
          // so we never record a hash that isn't actually in Pinecone.
          await this.batchUpsert(stageRecords);

          // Save state AFTER successful upsert
          const intermediateHashes = new Set([
            ...previousState.indexed_hashes,
            ...embeddedHashes,
          ]);
          const intermediateState: SyncState = {
            commit_sha: chunks[0]?.commit_sha || previousState.commit_sha,
            indexed_hashes: intermediateHashes,
            total_vectors: intermediateHashes.size,
            last_synced: new Date().toISOString(),
          };
          await this.saveState(intermediateState);
          console.log(`   Stage ${stageNum}/${stages}: embedded + upserted + state saved (${inserted}/${operations.toInsert.length})\n`);
        }
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
      if (operations.toDelete.length > 0) {
        console.log(`🗑️  Deleting ${operations.toDelete.length} stale vectors...`);
        for (const hash of operations.toDelete) {
          console.log(`  Deleted: ${hash}`);
        }
        await this.batchDelete(operations.toDelete);
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
    }

    // Calculate stats
    const stats: SyncStats = {
      total_chunks: chunks.length,
      embeddable_chunks: embeddable.length,
      skipped_too_small: tooSmall.length,
      skipped_too_large: tooLarge.length,
      vectors_inserted: inserted,
      vectors_updated: updated,
      vectors_deleted: dryRun ? 0 : operations.toDelete.length,
      embedding_api_calls: dryRun ? 0 : this.embedder.getApiCallCount(),
      s3_uploaded: s3Uploaded,
      s3_skipped: s3Skipped,
      sync_duration_ms: Date.now() - startTime
    };

    this.printSummary(stats, dryRun);

    console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

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
      if (chunk.token_count < MIN_EMBEDDABLE_TOKENS) {
        tooSmall.push(chunk);
      } else if (chunk.token_count > MAX_EMBEDDABLE_TOKENS) {
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
    const emptyState: SyncState = {
      commit_sha: '',
      indexed_hashes: new Set(),
      total_vectors: 0,
      last_synced: new Date().toISOString()
    };

    let content: string;
    try {
      content = await fs.readFile(this.config.stateFilePath, 'utf-8');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // No previous state file — first run
        return emptyState;
      }
      throw error;
    }

    try {
      const data = JSON.parse(content);
      return {
        commit_sha: data.commit_sha,
        indexed_hashes: new Set(data.indexed_hashes),
        total_vectors: data.total_vectors,
        last_synced: data.last_synced
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        const backupPath = `${this.config.stateFilePath}.corrupt.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        console.warn(`  Warning: State file is corrupt, backing up to ${backupPath} and starting fresh`);
        await fs.rename(this.config.stateFilePath, backupPath);
        return emptyState;
      }
      throw error;
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

    const tmpPath = `${this.config.stateFilePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.config.stateFilePath);
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
   * Build vector metadata from a DocumentChunk.
   *
   * Forwards all chunk.metadata fields (source_type, product, category,
   * spec_version, page_title, etc.) alongside the standard fields.
   * No branching on chunk type — all chunks are handled uniformly.
   */
  private buildVectorMetadata(chunk: DocumentChunk): VectorRecord['metadata'] {
    return {
      doc_path: chunk.doc_path,
      section_path: JSON.stringify(chunk.section_path),
      page_context: chunk.page_context,
      source_repo: chunk.source_repo,
      commit_sha: chunk.commit_sha,
      is_oversized: chunk.is_oversized,
      token_count: chunk.token_count,
      url: chunk.url,
      ...chunk.metadata
    };
  }

  /**
   * Validate that all chunks have required fields.
   * Returns an array of error strings (empty = all valid).
   */
  private validateChunkFields(chunks: DocumentChunk[]): string[] {
    const errors: string[] = [];
    for (const chunk of chunks) {
      for (const field of REQUIRED_CHUNK_FIELDS) {
        if (chunk[field] === undefined || chunk[field] === null) {
          errors.push(`${chunk.doc_path || '(unknown)'}: missing ${field}`);
        }
      }
    }
    return errors;
  }

  /**
   * Generate mock vector records without calling Bedrock.
   * Used in dry-run mode to validate metadata construction.
   */
  private generateMockVectorRecords(chunks: DocumentChunk[]): VectorRecord[] {
    return chunks.map(chunk => ({
      id: chunk.content_hash,
      embedding: new Array(EMBEDDING_DIM).fill(0),
      metadata: this.buildVectorMetadata(chunk)
    }));
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
    const concurrency = this.config.embeddingConcurrency ?? 5;
    const results: (VectorRecord | undefined)[] = new Array(chunks.length);
    const errors: { hash: string; message: string }[] = [];
    let completed = 0;
    let nextIdx = 0;

    // Worker pool: each worker grabs the next available chunk, embeds it,
    // then grabs another. Faster workers naturally process more items.
    // Unlike fixed-batch Promise.all, a slow retry in one worker doesn't
    // block others from making progress.
    const worker = async (): Promise<void> => {
      while (nextIdx < chunks.length) {
        const i = nextIdx++;  // atomic in single-threaded JS
        const chunk = chunks[i];
        try {
          const embedding = await this.embedder.generateEmbedding(chunk.content);
          results[i] = {
            id: chunk.content_hash,
            embedding,
            metadata: this.buildVectorMetadata(chunk),
          };
        } catch (error: any) {
          const hash = chunk.content_hash;
          const message = error?.message || String(error);
          console.error(`  Embedding failed for chunk ${hash}: ${message}`);
          errors.push({ hash, message });
          results[i] = undefined;
        }
        completed++;
        if (completed % 50 === 0 || completed === chunks.length) {
          console.log(`   Generated ${completed}/${chunks.length} embeddings...`);
        }
      }
    };

    const workerCount = Math.min(concurrency, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const validResults = results.filter((r): r is VectorRecord => r !== undefined);

    if (errors.length > validResults.length * 0.02) {
      throw new Error(
        `Too many embedding failures: ${errors.length} failed out of ${chunks.length} chunks (${errors.slice(0, 5).map(e => e.hash).join(', ')}${errors.length > 5 ? '...' : ''})`
      );
    }

    return validResults;
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
    const existingEmbeddings = await this.getVectorDB().fetchVectors(contentHashes);

    const records: VectorRecord[] = [];

    for (const chunk of chunks) {
      const embedding = existingEmbeddings.get(chunk.content_hash);

      if (!embedding) {
        console.warn(`   Warning: Missing embedding for hash ${chunk.content_hash}, skipping update`);
        continue;
      }

      const record: VectorRecord = {
        id: chunk.content_hash,
        embedding,  // Reuse existing embedding
        metadata: this.buildVectorMetadata(chunk)
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
    const failedBatches: number[] = [];
    let consecutiveFailures = 0;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize);
      let success = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.getVectorDB().upsertVectors(batch);
          success = true;
          consecutiveFailures = 0;
          break;
        } catch (error: any) {
          const message = error?.message || String(error);
          if (attempt < 3) {
            const backoffMs = 1000 * Math.pow(2, attempt - 1);
            console.warn(`  Retry ${attempt}/3 for batch ${batchIndex}: ${message}`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          } else {
            console.error(`  Batch ${batchIndex} failed permanently after 3 attempts: ${message}`);
            failedBatches.push(batchIndex);
            consecutiveFailures++;
          }
        }
      }

      // Circuit breaker: stop if 3 consecutive batches fail
      if (consecutiveFailures >= 3) {
        throw new Error(`Circuit breaker triggered: ${consecutiveFailures} consecutive batch failures. Halting upsert to prevent further damage.`);
      }

      if (success && (i + batchSize) % 500 === 0 && i + batchSize < records.length) {
        console.log(`   Upserted ${Math.min(i + batchSize, records.length)}/${records.length} vectors...`);
      }
    }

    if (failedBatches.length > 0) {
      console.error(`  ${failedBatches.length} batch(es) failed permanently: [${failedBatches.join(', ')}]`);
    }
  }

  /**
   * Batch delete vectors
   */
  private async batchDelete(ids: string[]): Promise<void> {
    const batchSize = this.config.batchSize;

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      let success = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.getVectorDB().deleteVectors(batch);
          success = true;
          break;
        } catch (error: any) {
          const message = error?.message || String(error);
          if (attempt < 3) {
            const backoffMs = 1000 * Math.pow(2, attempt - 1);
            console.warn(`  Delete retry ${attempt}/3: ${message}`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          } else {
            console.error(`  Delete batch failed permanently after 3 attempts: ${message}`);
            throw error;
          }
        }
      }
    }
  }

  /**
   * Print summary
   */
  private printSummary(stats: SyncStats, dryRun: boolean = false): void {
    const label = dryRun ? '📊 Embedding Sync Summary (DRY RUN)' : '📊 Embedding Sync Summary';
    console.log(label);
    console.log('═══════════════════════════════════════');
    console.log(`Total chunks:          ${stats.total_chunks}`);
    console.log(`Embeddable chunks:     ${stats.embeddable_chunks}`);
    console.log('');
    console.log(`Skipped (< ${MIN_EMBEDDABLE_TOKENS} tok):    ${stats.skipped_too_small}`);
    console.log(`Skipped (> ${MAX_EMBEDDABLE_TOKENS} tok):  ${stats.skipped_too_large}`);
    console.log('');
    if (dryRun) {
      console.log(`Would insert:          ${stats.vectors_inserted}`);
      console.log(`Would update:          ${stats.vectors_updated} (metadata only)`);
      console.log(`Would delete:          ${stats.vectors_deleted}`);
    } else {
      console.log(`Vectors inserted:      ${stats.vectors_inserted}`);
      console.log(`Vectors updated:       ${stats.vectors_updated} (metadata only)`);
      console.log(`Vectors deleted:       ${stats.vectors_deleted}`);
    }
    console.log('');
    if (stats.s3_uploaded > 0 || stats.s3_skipped > 0) {
      console.log(`S3 uploaded:           ${stats.s3_uploaded}`);
      console.log(`S3 skipped (exists):   ${stats.s3_skipped}`);
      console.log('');
    }
    console.log(`Bedrock API calls:     ${stats.embedding_api_calls}`);
    console.log(`Sync duration:         ${(stats.sync_duration_ms / 1000).toFixed(2)}s`);
    console.log('═══════════════════════════════════════\n');

    if (dryRun) {
      console.log('✅ Dry run passed — all chunks valid, no external calls made\n');
    } else if (stats.embedding_api_calls === 0 && stats.vectors_inserted === 0) {
      console.log('✅ No new content - zero embedding calls made\n');
    }

    if (!dryRun) {
      console.log('✨ Embedding sync complete!\n');
    }
  }
}
