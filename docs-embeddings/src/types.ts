/**
 * Types for the embedding pipeline
 */

// Import from ingestion pipeline
export interface DocumentChunk {
  content: string;
  doc_path: string;
  section: string;
  section_path: string[];
  page_context: string;
  url: string;
  content_hash: string;
  source_repo: string;
  commit_sha: string;
  token_count: number;
  is_oversized: boolean;
  metadata: {
    page_title?: string;
    sidebar_title?: string;
    [key: string]: any;
  };
}

// Vector database record
// FIX #2: Removed content field
export interface VectorRecord {
  id: string;                    // content_hash
  embedding: number[];           // 1024-dim for Titan v2
  metadata: {
    doc_path: string;
    section_path: string;        // JSON stringified array
    page_context: string;
    source_repo: string;
    commit_sha: string;
    is_oversized: boolean;
    token_count: number;
    url: string;
    [key: string]: any;          // Forward all chunk metadata (source_type, product, etc.)
  };
}

// Sync state tracking
export interface SyncState {
  commit_sha: string;
  indexed_hashes: Set<string>;   // content_hash of all indexed chunks
  total_vectors: number;
  last_synced: string;           // ISO timestamp
}

// Sync result stats
export interface SyncStats {
  total_chunks: number;
  embeddable_chunks: number;
  skipped_too_small: number;
  skipped_too_large: number;
  vectors_inserted: number;
  vectors_updated: number;       // metadata-only updates
  vectors_deleted: number;
  embedding_api_calls: number;   // Should be 0 on re-run
  s3_uploaded: number;
  s3_skipped: number;
  sync_duration_ms: number;
}

// Config
export interface EmbeddingConfig {
  ingestionOutputPath: string;
  stateFilePath: string;
  awsRegion: string;              // AWS region for Bedrock
  bedrockModelId: string;         // amazon.titan-embed-text-v2:0
  pineconeApiKey: string;
  pineconeIndex: string;
  batchSize: number;              // 100 vectors per upsert
  s3ContentBucket?: string;       // S3 bucket for content upload (optional)
  dryRun?: boolean;               // Skip external calls, validate only
  embeddingConcurrency?: number;  // Parallel Bedrock calls (default 5)
}
