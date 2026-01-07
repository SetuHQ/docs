/**
 * Documentation Ingestion Pipeline
 *
 * Main orchestrator that coordinates all modules to transform
 * a documentation repository into structured chunks ready for embedding.
 *
 * Pipeline flow:
 * 1. Scan repository for .md/.mdx files
 * 2. Parse each file (frontmatter + AST)
 * 3. Extract sections based on heading hierarchy
 * 4. Chunk sections intelligently (500-700 tokens)
 * 5. Enrich chunks with metadata (URLs, hashes, git info)
 * 6. Handle incremental updates (skip unchanged files)
 * 7. Output JSON for downstream processing
 *
 * Design principles:
 * - Deterministic (same input = same output)
 * - Incremental (skip unchanged content)
 * - Safe to re-run
 * - No LLM calls
 * - No embeddings (yet)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  scanDocumentationFiles,
  createDefaultScanConfig,
  validateScanConfig
} from './scanner.js';
import {
  parseMarkdownFile,
  extractSections,
  flattenSections
} from './parser.js';
import {
  chunkDocument,
  createDefaultChunkingConfig,
  validateChunkingConfig,
  cleanupTokenizer,
  countTokens
} from './chunker.js';
import {
  getGitInfo,
  enrichChunk,
  validateChunk
} from './metadata.js';
import {
  loadPreviousIngestion,
  determineFilesToProcess,
  mergeChunks
} from './deduplication.js';
import {
  categorizeChunks,
  logEmbeddingStats
} from './embedding-helpers.js';
import type {
  PipelineConfig,
  IngestionResult,
  IngestionStats,
  DocumentChunk
} from './types.js';

/**
 * Runs the complete ingestion pipeline
 *
 * @param config - Pipeline configuration
 * @returns Ingestion result with chunks and statistics
 *
 * Example:
 * ```ts
 * const result = await runIngestionPipeline({
 *   scan: {
 *     rootDir: '/path/to/docs/content',
 *     includeExtensions: ['.md', '.mdx'],
 *     excludeDirs: ['.git', 'node_modules'],
 *     excludePatterns: []
 *   },
 *   chunking: createDefaultChunkingConfig(),
 *   baseUrl: 'https://docs.setu.co',
 *   outputPath: './output/chunks.json'
 * });
 * ```
 */
export async function runIngestionPipeline(
  config: PipelineConfig
): Promise<IngestionResult> {
  const startTime = Date.now();

  console.log('🚀 Starting documentation ingestion pipeline\n');

  // Validate configuration
  validateScanConfig(config.scan);
  validateChunkingConfig(config.chunking);

  // Get git information
  // Look for git repo in rootDir or parent directories
  console.log('📋 Gathering git information...');
  let gitRepoPath = config.scan.rootDir;

  // If rootDir is 'content', check parent directory for .git
  if (path.basename(config.scan.rootDir) === 'content') {
    gitRepoPath = path.dirname(config.scan.rootDir);
  }

  const gitInfo = await getGitInfo(gitRepoPath);
  console.log(`   Commit: ${gitInfo.commitSha.substring(0, 8)}`);
  console.log(`   Branch: ${gitInfo.branch}`);
  console.log(`   Repo: ${gitInfo.repoName}\n`);

  // Load previous ingestion for incremental updates
  console.log('🔍 Checking for previous ingestion...');
  const incrementalState = await loadPreviousIngestion(config.previousOutputPath);
  if (incrementalState) {
    console.log(`   Found previous ingestion with ${incrementalState.previousChunks.size} chunks\n`);
  } else {
    console.log('   No previous ingestion found - processing all files\n');
  }

  // Scan for documentation files
  console.log('📁 Scanning for documentation files...');
  const allFiles = await scanDocumentationFiles(config.scan);
  console.log(`   Found ${allFiles.length} files\n`);

  // Determine which files need processing
  const { toProcess } = determineFilesToProcess(
    allFiles,
    incrementalState,
    gitInfo.commitSha
  );
  console.log(`📝 Processing ${toProcess.length} files...\n`);

  // Process each file
  const allChunks: DocumentChunk[] = [];
  const processedFiles = new Set<string>();
  let processedCount = 0;
  let skippedCount = 0;

  for (const relativePath of toProcess) {
    const absolutePath = path.join(config.scan.rootDir, relativePath);

    try {
      // Parse the markdown file
      const parsedDoc = await parseMarkdownFile(absolutePath, relativePath);

      // Extract sections
      const sections = extractSections(parsedDoc.ast);
      const flatSections = flattenSections(sections);

      // Skip empty documents
      if (flatSections.length === 0) {
        console.log(`   ⚠️  Skipping ${relativePath} (no content)`);
        skippedCount++;
        continue;
      }

      // Chunk the document
      const textChunks = chunkDocument(flatSections, config.chunking);

      // Enrich chunks with metadata
      const documentChunks = textChunks.map(chunk =>
        enrichChunk(
          chunk,
          relativePath,
          parsedDoc.frontmatter,
          gitInfo,
          config.baseUrl
        )
      );

      // Validate chunks
      for (const chunk of documentChunks) {
        validateChunk(chunk);
      }

      allChunks.push(...documentChunks);
      processedFiles.add(relativePath);
      processedCount++;

      // Progress indicator
      if (processedCount % 10 === 0) {
        console.log(`   Processed ${processedCount}/${toProcess.length} files...`);
      }
    } catch (error) {
      console.error(`   ❌ Error processing ${relativePath}:`, error);
      // Continue with other files
    }
  }

  console.log(`\n✅ Processed ${processedCount} files, skipped ${skippedCount} files\n`);

  // Merge with previous chunks for incremental updates
  console.log('🔄 Merging with previous ingestion...');
  const { chunks: finalChunks, stats: mergeStats } = mergeChunks(
    allChunks,
    incrementalState,
    processedFiles
  );
  console.log(`   New chunks: ${mergeStats.newChunks}`);
  console.log(`   Updated chunks: ${mergeStats.updatedChunks}`);
  console.log(`   Unchanged chunks: ${mergeStats.unchangedChunks}\n`);

  // Calculate statistics
  const endTime = Date.now();
  const stats: IngestionStats = {
    totalFiles: allFiles.length,
    processedFiles: processedCount,
    skippedFiles: skippedCount,
    totalChunks: finalChunks.length,
    newChunks: mergeStats.newChunks,
    updatedChunks: mergeStats.updatedChunks,
    unchangedChunks: mergeStats.unchangedChunks,
    processingTimeMs: endTime - startTime
  };

  // Create result
  const result: IngestionResult = {
    chunks: finalChunks,
    stats,
    gitInfo,
    timestamp: new Date().toISOString()
  };

  // Write output
  console.log('💾 Writing output...');
  await writeOutput(config.outputPath, result);
  console.log(`   Saved to ${config.outputPath}\n`);

  // Print summary
  printSummary(result);

  // Analyze embedding readiness
  const embeddingAnalysis = categorizeChunks(finalChunks);
  logEmbeddingStats(embeddingAnalysis.stats);

  // Cleanup
  cleanupTokenizer();

  return result;
}

/**
 * Writes ingestion result to a JSON file
 */
async function writeOutput(
  outputPath: string,
  result: IngestionResult
): Promise<void> {
  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  // Write JSON with pretty printing
  const json = JSON.stringify(result, null, 2);
  await fs.writeFile(outputPath, json, 'utf-8');
}

/**
 * Prints a summary of the ingestion results
 */
function printSummary(result: IngestionResult): void {
  console.log('📊 Ingestion Summary');
  console.log('═══════════════════════════════════════');
  console.log(`Total files:         ${result.stats.totalFiles}`);
  console.log(`Processed files:     ${result.stats.processedFiles}`);
  console.log(`Skipped files:       ${result.stats.skippedFiles}`);
  console.log('');
  console.log(`Total chunks:        ${result.stats.totalChunks}`);
  console.log(`New chunks:          ${result.stats.newChunks}`);
  console.log(`Updated chunks:      ${result.stats.updatedChunks}`);
  console.log(`Unchanged chunks:    ${result.stats.unchangedChunks}`);
  console.log('');

  // Calculate average chunk size
  const totalTokens = result.chunks.reduce((sum, c) => sum + c.token_count, 0);
  const avgTokens = result.chunks.length > 0
    ? Math.round(totalTokens / result.chunks.length)
    : 0;

  console.log(`Average chunk size:  ${avgTokens} tokens`);
  console.log(`Processing time:     ${(result.stats.processingTimeMs / 1000).toFixed(2)}s`);
  console.log('═══════════════════════════════════════\n');

  console.log('✨ Ingestion complete!\n');
}

/**
 * Creates a default pipeline configuration
 */
export function createDefaultConfig(
  contentDir: string,
  outputPath: string = './output/chunks.json'
): PipelineConfig {
  return {
    scan: createDefaultScanConfig(contentDir),
    chunking: createDefaultChunkingConfig(),
    baseUrl: 'https://docs.setu.co',
    outputPath,
    previousOutputPath: outputPath // Use same path for incremental updates
  };
}

/**
 * CLI entry point
 */
async function main() {
  try {
    // Get content directory from command line or use default
    // Default: ../content (assumes running from docs-ingestion/)
    const contentDir = process.argv[2] || path.join(process.cwd(), '..', 'content');
    const outputPath = process.argv[3] || path.join(process.cwd(), 'output', 'chunks.json');

    console.log(`Content directory: ${contentDir}`);
    console.log(`Output path: ${outputPath}\n`);

    // Create configuration
    const config = createDefaultConfig(contentDir, outputPath);

    // Run pipeline
    await runIngestionPipeline(config);

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Pipeline failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for use as a library
export * from './types.js';
export * from './scanner.js';
export * from './parser.js';
export * from './chunker.js';
export * from './metadata.js';
export * from './deduplication.js';
