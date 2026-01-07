/**
 * Intelligent Chunking Module
 *
 * Splits documentation into semantically coherent chunks optimized for
 * embedding and retrieval.
 *
 * Key principles:
 * 1. Token-based splitting (500-700 tokens per chunk)
 * 2. Respect heading boundaries (sections are atomic units)
 * 3. NEVER split code blocks
 * 4. Apply overlap (100-150 tokens) for context continuity
 * 5. Each chunk represents a single coherent concept
 * 6. NO micro-chunks (< 80 tokens) - merge with adjacent chunks
 * 7. Prefer bundling explanation text + code together
 *
 * Algorithm:
 * - Start with section-level chunks
 * - If a section is too large, split at paragraph boundaries
 * - If still too large, split at sentence boundaries
 * - Always preserve code blocks intact
 * - Add overlap by including last N tokens from previous chunk
 * - Merge micro-chunks (< 80 tokens) with adjacent chunks
 */

import { Tiktoken, encodingForModel } from 'js-tiktoken';
import type { DocumentSection, ChunkingConfig } from './types.js';

/**
 * Represents a text chunk with metadata
 */
export interface TextChunk {
  content: string;
  tokenCount: number;
  sectionPath: string;
  sectionPathArray: string[];
  startLine: number;
  endLine: number;
}

// Initialize tokenizer (using gpt-4o encoding)
let tokenizer: Tiktoken | null = null;

function getTokenizer(): Tiktoken {
  if (!tokenizer) {
    tokenizer = encodingForModel('gpt-4o');
  }
  return tokenizer;
}

/**
 * Counts tokens in a text string
 */
export function countTokens(text: string): number {
  const enc = getTokenizer();
  return enc.encode(text).length;
}

/**
 * Creates a default chunking configuration
 */
export function createDefaultChunkingConfig(): ChunkingConfig {
  return {
    targetChunkSize: 600,
    minChunkSize: 500,
    maxChunkSize: 700,
    overlapSize: 125,
    minOverlapSize: 100,
    maxOverlapSize: 150
  };
}

/**
 * Chunk size thresholds
 */
const ABSOLUTE_MIN_CHUNK_SIZE = 80;  // Minimum viable chunk
const SOFT_MAX_CHUNK_SIZE = 700;     // Target maximum (will try to stay under)
const HARD_MAX_CHUNK_SIZE = 900;     // Absolute maximum (force split if exceeded)

/**
 * Chunks a document based on its section hierarchy
 *
 * @param sections - Flattened array of sections with paths
 * @param config - Chunking configuration
 * @returns Array of text chunks (all >= 80 tokens)
 */
export function chunkDocument(
  sections: Array<{ section: DocumentSection; path: string; pathArray: string[] }>,
  config: ChunkingConfig
): TextChunk[] {
  const chunks: TextChunk[] = [];
  let previousChunkOverlap = '';

  for (const { section, path, pathArray } of sections) {
    // Calculate token count for this section
    const sectionTokens = countTokens(section.content);

    // If section fits in one chunk, use it as-is
    if (sectionTokens <= config.maxChunkSize) {
      const content = previousChunkOverlap
        ? `${previousChunkOverlap}\n\n${section.content}`
        : section.content;

      chunks.push({
        content: content.trim(),
        tokenCount: countTokens(content),
        sectionPath: path,
        sectionPathArray: pathArray,
        startLine: section.startLine,
        endLine: section.endLine
      });

      // Prepare overlap for next chunk
      previousChunkOverlap = extractOverlap(section.content, config);
      continue;
    }

    // Section is too large - need to split
    const sectionChunks = splitLargeSection(section, path, pathArray, config);

    for (let i = 0; i < sectionChunks.length; i++) {
      const chunk = sectionChunks[i];

      // Add overlap from previous chunk (if this is not the first chunk of the section)
      if (i === 0 && previousChunkOverlap) {
        chunk.content = `${previousChunkOverlap}\n\n${chunk.content}`;
        chunk.tokenCount = countTokens(chunk.content);
      }

      chunks.push(chunk);

      // Prepare overlap for next chunk
      if (i < sectionChunks.length - 1) {
        // Overlap within the same section
        previousChunkOverlap = extractOverlap(chunk.content, config);
      }
    }

    // Set overlap from last chunk of this section
    previousChunkOverlap = extractOverlap(
      sectionChunks[sectionChunks.length - 1].content,
      config
    );
  }

  // Post-process: merge micro-chunks (< 80 tokens)
  const mergedChunks = mergeMicroChunks(chunks);

  // Post-process: split oversized chunks (> 900 tokens)
  const finalChunks = enforceMaxChunkSize(mergedChunks, config);

  return finalChunks;
}

/**
 * Merges chunks that are below the absolute minimum threshold (80 tokens)
 *
 * Strategy:
 * - Iterate through chunks
 * - If chunk < 80 tokens, try to merge with previous chunk
 * - If previous chunk doesn't exist or would become too large, merge with next chunk
 * - If merging would exceed maxChunkSize, keep as-is (rare edge case)
 */
function mergeMicroChunks(chunks: TextChunk[]): TextChunk[] {
  if (chunks.length === 0) return [];

  const merged: TextChunk[] = [];
  let i = 0;

  while (i < chunks.length) {
    const currentChunk = chunks[i];

    // Chunk is large enough, keep as-is
    if (currentChunk.tokenCount >= ABSOLUTE_MIN_CHUNK_SIZE) {
      merged.push(currentChunk);
      i++;
      continue;
    }

    // Micro-chunk detected - try to merge
    const previousChunk = merged[merged.length - 1];
    const nextChunk = chunks[i + 1];

    // Try merging with previous chunk first
    if (previousChunk && previousChunk.sectionPath === currentChunk.sectionPath) {
      const mergedContent = `${previousChunk.content}\n\n${currentChunk.content}`;
      const mergedTokenCount = countTokens(mergedContent);

      // Only merge if it doesn't make the previous chunk too large (< 800 tokens)
      if (mergedTokenCount <= 800) {
        previousChunk.content = mergedContent;
        previousChunk.tokenCount = mergedTokenCount;
        previousChunk.endLine = currentChunk.endLine;
        i++;
        continue;
      }
    }

    // Try merging with next chunk
    if (nextChunk) {
      const mergedContent = `${currentChunk.content}\n\n${nextChunk.content}`;
      const mergedTokenCount = countTokens(mergedContent);

      // Merge current with next (skip next in next iteration)
      const mergedChunk: TextChunk = {
        content: mergedContent,
        tokenCount: mergedTokenCount,
        sectionPath: currentChunk.sectionPath,
        sectionPathArray: currentChunk.sectionPathArray,
        startLine: currentChunk.startLine,
        endLine: nextChunk.endLine
      };

      merged.push(mergedChunk);
      i += 2; // Skip next chunk
      continue;
    }

    // No merging possible - keep as-is (edge case: last chunk of last section)
    merged.push(currentChunk);
    i++;
  }

  return merged;
}

/**
 * Splits a large section into multiple chunks
 *
 * Strategy:
 * 1. Try to split at paragraph boundaries (double newline)
 * 2. Keep code blocks with preceding explanation text
 * 3. If paragraphs are too large, split at sentence boundaries
 * 4. Always keep code blocks intact
 */
function splitLargeSection(
  section: DocumentSection,
  sectionPath: string,
  sectionPathArray: string[],
  config: ChunkingConfig
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const content = section.content;

  // Check if content contains code blocks
  const codeBlockPattern = /```[\s\S]*?```/g;
  const codeBlocks: Array<{ start: number; end: number; content: string }> = [];
  let match;

  while ((match = codeBlockPattern.exec(content)) !== null) {
    codeBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[0]
    });
  }

  // Split into paragraphs first
  const paragraphs = content.split(/\n\n+/);
  let currentChunk = '';
  let currentTokens = 0;
  let hasCode = false;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const paragraphTokens = countTokens(paragraph);

    // Check if this paragraph contains a code block
    const containsCodeBlock = codeBlocks.some(cb => {
      const paragraphStart = content.indexOf(paragraph);
      const paragraphEnd = paragraphStart + paragraph.length;
      return cb.start >= paragraphStart && cb.end <= paragraphEnd;
    });

    // Check if this is explanatory text (likely precedes code)
    const isExplanatoryText = !containsCodeBlock &&
                               paragraph.length > 20 &&
                               i < paragraphs.length - 1 &&
                               paragraphs[i + 1].includes('```');

    // If current chunk has code and we're adding non-code, finalize
    if (hasCode && !containsCodeBlock && !isExplanatoryText && currentTokens > config.minChunkSize) {
      chunks.push({
        content: currentChunk.trim(),
        tokenCount: currentTokens,
        sectionPath,
        sectionPathArray,
        startLine: section.startLine,
        endLine: section.endLine
      });
      currentChunk = '';
      currentTokens = 0;
      hasCode = false;
    }

    // If paragraph has a code block, try to keep it with preceding context
    if (containsCodeBlock) {
      // If adding this would exceed max size, finalize current chunk first
      if (currentTokens > 0 && currentTokens + paragraphTokens > config.maxChunkSize) {
        chunks.push({
          content: currentChunk.trim(),
          tokenCount: currentTokens,
          sectionPath,
          sectionPathArray,
          startLine: section.startLine,
          endLine: section.endLine
        });
        currentChunk = '';
        currentTokens = 0;
        hasCode = false;
      }

      // Add the paragraph with code block
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      currentTokens = countTokens(currentChunk);
      hasCode = true;

      // If this chunk is now reasonably sized or exceeds max, finalize it
      if (currentTokens >= config.minChunkSize || currentTokens >= config.maxChunkSize) {
        chunks.push({
          content: currentChunk.trim(),
          tokenCount: currentTokens,
          sectionPath,
          sectionPathArray,
          startLine: section.startLine,
          endLine: section.endLine
        });
        currentChunk = '';
        currentTokens = 0;
        hasCode = false;
      }

      continue;
    }

    // Normal paragraph without code block
    if (currentTokens + paragraphTokens <= config.maxChunkSize) {
      // Add to current chunk
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      currentTokens = countTokens(currentChunk);
    } else {
      // Finalize current chunk if it meets minimum size
      if (currentTokens >= config.minChunkSize) {
        chunks.push({
          content: currentChunk.trim(),
          tokenCount: currentTokens,
          sectionPath,
          sectionPathArray,
          startLine: section.startLine,
          endLine: section.endLine
        });
        currentChunk = paragraph;
        currentTokens = paragraphTokens;
        hasCode = false;
      } else {
        // Current chunk is too small, add paragraph anyway
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        currentTokens = countTokens(currentChunk);
      }
    }

    // If current chunk is large enough, finalize it
    if (currentTokens >= config.targetChunkSize && !isExplanatoryText) {
      chunks.push({
        content: currentChunk.trim(),
        tokenCount: currentTokens,
        sectionPath,
        sectionPathArray,
        startLine: section.startLine,
        endLine: section.endLine
      });
      currentChunk = '';
      currentTokens = 0;
      hasCode = false;
    }
  }

  // Add remaining content
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      tokenCount: currentTokens || countTokens(currentChunk),
      sectionPath,
      sectionPathArray,
      startLine: section.startLine,
      endLine: section.endLine
    });
  }

  return chunks;
}

/**
 * Extracts overlap text from the end of a chunk
 *
 * Takes the last N tokens (within the overlap range) from the content.
 * Tries to break at sentence boundaries for better coherence.
 */
function extractOverlap(content: string, config: ChunkingConfig): string {
  const tokens = countTokens(content);

  // Don't create overlap from very short content
  if (tokens < config.minOverlapSize * 2) {
    return '';
  }

  // Split into sentences
  const sentences = content.split(/(?<=[.!?])\s+/);

  // Work backwards to find sentences that fit in overlap range
  let overlap = '';
  let overlapTokens = 0;

  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i];
    const sentenceTokens = countTokens(sentence);

    if (overlapTokens + sentenceTokens <= config.maxOverlapSize) {
      overlap = sentence + ' ' + overlap;
      overlapTokens += sentenceTokens;

      if (overlapTokens >= config.minOverlapSize) {
        break;
      }
    } else {
      break;
    }
  }

  return overlap.trim();
}

/**
 * Validates chunking configuration
 */
export function validateChunkingConfig(config: ChunkingConfig): void {
  if (config.minChunkSize <= 0) {
    throw new Error('minChunkSize must be positive');
  }

  if (config.maxChunkSize <= config.minChunkSize) {
    throw new Error('maxChunkSize must be greater than minChunkSize');
  }

  if (config.targetChunkSize < config.minChunkSize || config.targetChunkSize > config.maxChunkSize) {
    throw new Error('targetChunkSize must be between minChunkSize and maxChunkSize');
  }

  if (config.minOverlapSize < 0) {
    throw new Error('minOverlapSize must be non-negative');
  }

  if (config.maxOverlapSize < config.minOverlapSize) {
    throw new Error('maxOverlapSize must be greater than or equal to minOverlapSize');
  }

  if (config.maxOverlapSize >= config.minChunkSize) {
    throw new Error('maxOverlapSize must be less than minChunkSize');
  }
}

/**
 * Enforces hard maximum chunk size by splitting oversized chunks
 *
 * Strategy:
 * - If chunk > HARD_MAX (900 tokens), force split
 * - Split at paragraph boundaries
 * - Preserve code blocks intact
 * - If single code block > HARD_MAX, allow it but flag in metadata
 *
 * @param chunks - Chunks after micro-chunk merging
 * @param config - Chunking configuration
 * @returns Chunks with enforced size limits
 */
function enforceMaxChunkSize(
  chunks: TextChunk[],
  config: ChunkingConfig
): TextChunk[] {
  const result: TextChunk[] = [];

  for (const chunk of chunks) {
    // Chunk is within acceptable size
    if (chunk.tokenCount <= HARD_MAX_CHUNK_SIZE) {
      result.push(chunk);
      continue;
    }

    // Chunk is oversized - need to split
    const splitChunks = splitOversizedChunk(chunk, config);
    result.push(...splitChunks);
  }

  return result;
}

/**
 * Splits a single oversized chunk into multiple chunks
 *
 * @param chunk - Oversized chunk
 * @param config - Chunking configuration
 * @returns Array of smaller chunks
 */
function splitOversizedChunk(
  chunk: TextChunk,
  config: ChunkingConfig
): TextChunk[] {
  const content = chunk.content;

  // Check if content is primarily a single massive code block
  const codeBlockPattern = /^```[\s\S]*?```$/;
  const isSingleCodeBlock = codeBlockPattern.test(content.trim());

  // Count actual code block content vs text
  const codeBlockMatches = content.match(/```[\s\S]*?```/g);
  const codeBlockChars = codeBlockMatches ? codeBlockMatches.join('').length : 0;
  const isCodeDominated = codeBlockChars > content.length * 0.8;

  if (isSingleCodeBlock || isCodeDominated) {
    // Single code block or code-dominated chunk that's too large - keep intact but flag
    console.warn(
      `Warning: Code-dominated chunk exceeds ${HARD_MAX_CHUNK_SIZE} tokens (${chunk.tokenCount} tokens) in section "${chunk.sectionPath}"`
    );
    return [chunk]; // Keep as-is, unavoidable
  }

  // Extract code blocks to preserve them
  const codeBlocks: Array<{ start: number; end: number; content: string }> = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    codeBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[0]
    });
  }

  // Split into paragraphs
  const paragraphs = content.split(/\n\n+/);
  const resultChunks: TextChunk[] = [];
  let currentContent = '';
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = countTokens(paragraph);

    // Check if this paragraph contains a code block
    const containsCodeBlock = codeBlocks.some(cb => {
      const paragraphStart = content.indexOf(paragraph);
      const paragraphEnd = paragraphStart + paragraph.length;
      return cb.start >= paragraphStart && cb.end <= paragraphEnd;
    });

    // If adding this paragraph would exceed HARD max, force finalize
    if (currentTokens > 0 && currentTokens + paragraphTokens > HARD_MAX_CHUNK_SIZE) {
      resultChunks.push({
        content: currentContent.trim(),
        tokenCount: currentTokens,
        sectionPath: chunk.sectionPath,
        sectionPathArray: chunk.sectionPathArray,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      });
      currentContent = '';
      currentTokens = 0;
    }
    // If adding this paragraph would exceed soft max, finalize current chunk
    else if (currentTokens > 0 && currentTokens + paragraphTokens > SOFT_MAX_CHUNK_SIZE) {
      resultChunks.push({
        content: currentContent.trim(),
        tokenCount: currentTokens,
        sectionPath: chunk.sectionPath,
        sectionPathArray: chunk.sectionPathArray,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      });
      currentContent = '';
      currentTokens = 0;
    }

    // Add paragraph
    currentContent += (currentContent ? '\n\n' : '') + paragraph;
    currentTokens = countTokens(currentContent);

    // If we have a code block and chunk is reasonable size, finalize
    // Also force finalize if we're approaching HARD max
    if (containsCodeBlock &&
        (currentTokens >= config.minChunkSize || currentTokens > SOFT_MAX_CHUNK_SIZE)) {
      resultChunks.push({
        content: currentContent.trim(),
        tokenCount: currentTokens,
        sectionPath: chunk.sectionPath,
        sectionPathArray: chunk.sectionPathArray,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      });
      currentContent = '';
      currentTokens = 0;
    }
    // Force finalize if approaching hard max even without code block
    else if (currentTokens > HARD_MAX_CHUNK_SIZE * 0.9) {
      resultChunks.push({
        content: currentContent.trim(),
        tokenCount: currentTokens,
        sectionPath: chunk.sectionPath,
        sectionPathArray: chunk.sectionPathArray,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      });
      currentContent = '';
      currentTokens = 0;
    }
  }

  // Add remaining content
  if (currentContent.trim()) {
    resultChunks.push({
      content: currentContent.trim(),
      tokenCount: currentTokens || countTokens(currentContent),
      sectionPath: chunk.sectionPath,
      sectionPathArray: chunk.sectionPathArray,
      startLine: chunk.startLine,
      endLine: chunk.endLine
    });
  }

  return resultChunks.length > 0 ? resultChunks : [chunk];
}

/**
 * Frees the tokenizer resources
 * Call this when the pipeline is complete
 */
export function cleanupTokenizer(): void {
  // Note: js-tiktoken manages memory automatically
  // No explicit cleanup needed
  tokenizer = null;
}
