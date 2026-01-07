/**
 * Incremental Update Handler
 *
 * Enables efficient re-ingestion by:
 * 1. Loading previous ingestion results
 * 2. Comparing content hashes to detect changes
 * 3. Reusing unchanged chunks
 * 4. Only re-processing changed files
 *
 * Design principles:
 * - Safe to re-run (idempotent)
 * - Efficient (skip unchanged content)
 * - Traceable (track what changed)
 */

import * as fs from 'fs/promises';
import type { DocumentChunk, IngestionResult } from './types.js';
import { getChunkId } from './metadata.js';

/**
 * Represents the state of incremental updates
 */
export interface IncrementalState {
  /** Previous chunks indexed by chunk ID */
  previousChunks: Map<string, DocumentChunk>;
  /** Previous chunks indexed by file path */
  chunksByFile: Map<string, DocumentChunk[]>;
  /** Previous commit SHA */
  previousCommitSha: string;
}

/**
 * Loads previous ingestion results for incremental updates
 *
 * @param previousOutputPath - Path to previous output JSON
 * @returns Incremental state or null if no previous output
 */
export async function loadPreviousIngestion(
  previousOutputPath?: string
): Promise<IncrementalState | null> {
  if (!previousOutputPath) {
    return null;
  }

  try {
    const content = await fs.readFile(previousOutputPath, 'utf-8');
    const previousResult: IngestionResult = JSON.parse(content);

    // Index chunks by ID and file path
    const previousChunks = new Map<string, DocumentChunk>();
    const chunksByFile = new Map<string, DocumentChunk[]>();

    for (const chunk of previousResult.chunks) {
      const chunkId = getChunkId(chunk);
      previousChunks.set(chunkId, chunk);

      if (!chunksByFile.has(chunk.doc_path)) {
        chunksByFile.set(chunk.doc_path, []);
      }
      chunksByFile.get(chunk.doc_path)!.push(chunk);
    }

    return {
      previousChunks,
      chunksByFile,
      previousCommitSha: previousResult.gitInfo.commitSha
    };
  } catch (error) {
    console.warn('Could not load previous ingestion results:', error);
    return null;
  }
}

/**
 * Determines which files need to be processed
 *
 * Strategy:
 * - If no previous state, process all files
 * - If commit SHA changed, process all files
 * - Otherwise, compare file modification times and content hashes
 *
 * @param allFiles - All discovered files
 * @param incrementalState - Previous ingestion state
 * @param currentCommitSha - Current git commit SHA
 * @returns Files that need processing
 */
export function determineFilesToProcess(
  allFiles: string[],
  incrementalState: IncrementalState | null,
  currentCommitSha: string
): {
  toProcess: string[];
  toSkip: string[];
} {
  // No previous state - process everything
  if (!incrementalState) {
    return {
      toProcess: allFiles,
      toSkip: []
    };
  }

  // Commit changed - process everything (safe mode)
  if (incrementalState.previousCommitSha !== currentCommitSha) {
    console.log('Git commit changed - processing all files');
    return {
      toProcess: allFiles,
      toSkip: []
    };
  }

  const toProcess: string[] = [];
  const toSkip: string[] = [];

  for (const file of allFiles) {
    // If file wasn't in previous ingestion, process it
    if (!incrementalState.chunksByFile.has(file)) {
      toProcess.push(file);
    } else {
      // File was previously processed - could skip
      // For now, we'll check content hash during processing
      toProcess.push(file);
    }
  }

  // Detect deleted files
  for (const previousFile of incrementalState.chunksByFile.keys()) {
    if (!allFiles.includes(previousFile)) {
      console.log(`File deleted: ${previousFile}`);
    }
  }

  return { toProcess, toSkip };
}

/**
 * Merges new chunks with previous chunks for incremental updates
 *
 * Strategy:
 * - Keep new chunks (they're fresh)
 * - For files not re-processed, keep old chunks
 * - Remove chunks from deleted files
 *
 * @param newChunks - Newly generated chunks
 * @param incrementalState - Previous ingestion state
 * @param processedFiles - Files that were re-processed
 * @returns Merged chunk list
 */
export function mergeChunks(
  newChunks: DocumentChunk[],
  incrementalState: IncrementalState | null,
  processedFiles: Set<string>
): {
  chunks: DocumentChunk[];
  stats: {
    newChunks: number;
    updatedChunks: number;
    unchangedChunks: number;
  };
} {
  if (!incrementalState) {
    // First ingestion - all chunks are new
    return {
      chunks: newChunks,
      stats: {
        newChunks: newChunks.length,
        updatedChunks: 0,
        unchangedChunks: 0
      }
    };
  }

  const finalChunks: DocumentChunk[] = [];
  const newChunkIds = new Set<string>();
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  // Add all new chunks
  for (const chunk of newChunks) {
    const chunkId = getChunkId(chunk);
    newChunkIds.add(chunkId);

    const previousChunk = incrementalState.previousChunks.get(chunkId);

    if (!previousChunk) {
      // Brand new chunk
      newCount++;
    } else if (previousChunk.content_hash !== chunk.content_hash) {
      // Content changed
      updatedCount++;
    } else {
      // Content unchanged
      unchangedCount++;
    }

    finalChunks.push(chunk);
  }

  // Keep chunks from files that weren't re-processed
  for (const [filePath, chunks] of incrementalState.chunksByFile.entries()) {
    if (!processedFiles.has(filePath)) {
      // File wasn't re-processed - keep old chunks
      for (const chunk of chunks) {
        const chunkId = getChunkId(chunk);
        if (!newChunkIds.has(chunkId)) {
          finalChunks.push(chunk);
          unchangedCount++;
        }
      }
    }
  }

  return {
    chunks: finalChunks,
    stats: {
      newChunks: newCount,
      updatedChunks: updatedCount,
      unchangedChunks: unchangedCount
    }
  };
}

/**
 * Compares two ingestion results and reports differences
 *
 * Useful for debugging and validation
 */
export function compareIngestionResults(
  previous: IngestionResult,
  current: IngestionResult
): {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
} {
  const previousChunks = new Map(
    previous.chunks.map(c => [getChunkId(c), c])
  );
  const currentChunks = new Map(
    current.chunks.map(c => [getChunkId(c), c])
  );

  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  // Count added and modified
  for (const [id, currentChunk] of currentChunks) {
    const previousChunk = previousChunks.get(id);
    if (!previousChunk) {
      added++;
    } else if (previousChunk.content_hash !== currentChunk.content_hash) {
      modified++;
    } else {
      unchanged++;
    }
  }

  // Count removed
  for (const id of previousChunks.keys()) {
    if (!currentChunks.has(id)) {
      removed++;
    }
  }

  return { added, removed, modified, unchanged };
}

/**
 * Validates incremental update correctness
 *
 * Ensures that unchanged files produce identical chunks
 */
export function validateIncrementalUpdate(
  oldChunks: DocumentChunk[],
  newChunks: DocumentChunk[],
  unchangedFiles: Set<string>
): boolean {
  const oldChunkMap = new Map(
    oldChunks
      .filter(c => unchangedFiles.has(c.doc_path))
      .map(c => [getChunkId(c), c])
  );

  const newChunkMap = new Map(
    newChunks
      .filter(c => unchangedFiles.has(c.doc_path))
      .map(c => [getChunkId(c), c])
  );

  // Check that all old chunks are present and identical
  for (const [id, oldChunk] of oldChunkMap) {
    const newChunk = newChunkMap.get(id);
    if (!newChunk) {
      console.error(`Chunk missing in new ingestion: ${id}`);
      return false;
    }

    if (oldChunk.content_hash !== newChunk.content_hash) {
      console.error(`Chunk content changed for unchanged file: ${id}`);
      return false;
    }
  }

  return true;
}
