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
const MIN_EMBEDDABLE_TOKENS = 50;    // Below this: too little semantic content
const MAX_EMBEDDABLE_TOKENS = 1600;  // Above this: dominates vector search (Titan v2 supports 8192)
const OVERSIZED_THRESHOLD = 1200;    // Flag for special handling

/**
 * Doc path prefixes that bypass MAX_EMBEDDABLE_TOKENS.
 * Critical content that MUST be embedded regardless of token count.
 * Titan v2 supports up to 8192 tokens so this is safe.
 */
export const FORCE_EMBED_PATTERNS: string[] = [
  'api-reference/payments/umap',  // UMAP mandate responses are critical business content
];

/**
 * Checks if a chunk matches a force-embed pattern (critical content
 * that must be embedded regardless of token limits).
 */
export function isForceEmbeddable(chunk: DocumentChunk): boolean {
  return FORCE_EMBED_PATTERNS.some(p => chunk.doc_path.startsWith(p));
}

/**
 * Determines if a chunk should be embedded based on token thresholds
 * and force-embed overrides.
 */
export function shouldEmbed(chunk: DocumentChunk): boolean {
  const tokenCount = chunk.token_count;

  if (tokenCount < MIN_EMBEDDABLE_TOKENS) {
    return false;
  }

  if (tokenCount >= MIN_EMBEDDABLE_TOKENS && tokenCount <= 70) {
    console.warn(`Warning: near-minimum chunk (${tokenCount} tokens) in "${chunk.doc_path}" — may have low retrieval quality`);
  }

  if (tokenCount > MAX_EMBEDDABLE_TOKENS) {
    if (isForceEmbeddable(chunk)) {
      console.warn(`Force-embedding oversized chunk (${tokenCount} tokens) for critical path: ${chunk.doc_path}`);
      return true;
    }
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
      if (isForceEmbeddable(chunk)) {
        embeddable.push(chunk);
      } else {
        tooLarge.push(chunk);
      }
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
  console.log(`  - Too small (<${MIN_EMBEDDABLE_TOKENS} tok):   ${stats.tooSmall} (${((stats.tooSmall / stats.total) * 100).toFixed(1)}%)`);
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
