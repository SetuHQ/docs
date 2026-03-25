/**
 * Embedding Helper Module
 *
 * Provides guardrails for the embedding pipeline to filter chunks
 * that would hurt retrieval quality.
 *
 * IMPORTANT: This module does NOT modify chunks.
 * It only provides decision logic for the embedding pipeline.
 */

import type { DocumentChunk } from './types.js';

/**
 * Embedding thresholds
 */
const MIN_EMBEDDABLE_TOKENS = 80;    // Below this: too little semantic content
const MAX_EMBEDDABLE_TOKENS = 1400;  // Above this: dominates vector search (includes safety margin)
const OVERSIZED_THRESHOLD = 1200;    // Flag for special handling

/**
 * Determines if a chunk should be embedded
 *
 * Rules:
 * - Skip if < 80 tokens (micro-chunks with no semantic value)
 * - Skip if > 1500 tokens (oversized chunks that dominate retrieval)
 * - Embed everything else
 *
 * This function is called by the embedding pipeline, NOT during ingestion.
 * Chunks are never deleted, only filtered for embedding.
 *
 * @param chunk - Document chunk to evaluate
 * @returns true if chunk should be embedded, false otherwise
 *
 * Example:
 * ```typescript
 * const chunksToEmbed = allChunks.filter(shouldEmbed);
 * ```
 */
export function shouldEmbed(chunk: DocumentChunk): boolean {
  const tokenCount = chunk.token_count;

  // Too small - insufficient semantic content for meaningful embedding
  if (tokenCount < MIN_EMBEDDABLE_TOKENS) {
    return false;
  }

  // Warn about near-minimum chunks that may have low retrieval quality
  if (tokenCount >= MIN_EMBEDDABLE_TOKENS && tokenCount <= 100) {
    console.warn(`Warning: near-minimum chunk (${tokenCount} tokens) in "${chunk.doc_path}" — may have low retrieval quality`);
  }

  // Too large - will dominate vector search and hurt retrieval precision
  if (tokenCount > MAX_EMBEDDABLE_TOKENS) {
    return false;
  }

  return true;
}

/**
 * Categorizes chunks by embeddability
 *
 * @param chunks - Array of document chunks
 * @returns Categorized chunks with counts
 */
export function categorizeChunks(chunks: DocumentChunk[]): {
  embeddable: DocumentChunk[];
  tooSmall: DocumentChunk[];
  tooLarge: DocumentChunk[];
  oversized: DocumentChunk[];
  stats: {
    total: number;
    embeddable: number;
    tooSmall: number;
    tooLarge: number;
    oversized: number;
  };
} {
  const embeddable: DocumentChunk[] = [];
  const tooSmall: DocumentChunk[] = [];
  const tooLarge: DocumentChunk[] = [];
  const oversized: DocumentChunk[] = [];

  for (const chunk of chunks) {
    const tokenCount = chunk.token_count;

    // Categorize by embeddability
    if (tokenCount < MIN_EMBEDDABLE_TOKENS) {
      tooSmall.push(chunk);
    } else if (tokenCount > MAX_EMBEDDABLE_TOKENS) {
      tooLarge.push(chunk);
    } else {
      embeddable.push(chunk);
    }

    // Also flag oversized (informational)
    if (tokenCount > OVERSIZED_THRESHOLD) {
      oversized.push(chunk);
    }
  }

  return {
    embeddable,
    tooSmall,
    tooLarge,
    oversized,
    stats: {
      total: chunks.length,
      embeddable: embeddable.length,
      tooSmall: tooSmall.length,
      tooLarge: tooLarge.length,
      oversized: oversized.length
    }
  };
}

/**
 * Logs embedding statistics
 *
 * @param stats - Statistics from categorizeChunks
 */
export function logEmbeddingStats(stats: ReturnType<typeof categorizeChunks>['stats']): void {
  console.log('\n📊 Embedding Readiness Report');
  console.log('═══════════════════════════════════════');
  console.log(`Total chunks:              ${stats.total}`);
  console.log(`Embeddable chunks:         ${stats.embeddable} (${((stats.embeddable / stats.total) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('Skipped chunks:');
  console.log(`  - Too small (<80 tok):   ${stats.tooSmall} (${((stats.tooSmall / stats.total) * 100).toFixed(1)}%)`);
  console.log(`  - Too large (>${MAX_EMBEDDABLE_TOKENS} tok): ${stats.tooLarge} (${((stats.tooLarge / stats.total) * 100).toFixed(1)}%)`);
  console.log('');
  console.log(`Oversized (>1200 tok):     ${stats.oversized} (${((stats.oversized / stats.total) * 100).toFixed(1)}%)`);
  console.log('  ↳ These chunks are embeddable but may need special handling');
  console.log('═══════════════════════════════════════\n');
}

/**
 * Validates that a chunk has required fields for embedding
 *
 * @param chunk - Chunk to validate
 * @returns true if valid, false otherwise
 */
export function isValidForEmbedding(chunk: DocumentChunk): boolean {
  return !!(
    chunk.content &&
    chunk.content.trim().length > 0 &&
    chunk.content_hash &&
    chunk.section_path &&
    chunk.page_context
  );
}
