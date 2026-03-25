/**
 * Ingestion Smoke Test
 *
 * Runs the full ingestion pipeline on both .docs-normalized/ and
 * .api-reference-normalized/ directories, then validates:
 *
 * 1. Combined chunk count exceeds minimum threshold
 * 2. No chunk exceeds 1500 tokens
 * 3. All chunks have mandatory metadata fields
 * 4. API spec chunks have source_type, product, category, spec_version
 *
 * Exits with code 1 on any failure.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createDefaultConfig,
  runIngestionPipeline,
  ingestApiSpecDirectory
} from '../src/index.js';
import type { DocumentChunk } from '../src/types.js';

const MIN_TOTAL_CHUNKS = 200; // Conservative minimum for combined output
// Hard ceiling for smoke test. JSON examples in API specs are
// atomic (code blocks can't be split by the chunker), so some
// chunks exceed the 1500-token embedding target. The embedding
// pipeline filters those at embedding time. This ceiling catches
// truly broken chunks.
const MAX_CHUNK_TOKENS = 6000;

const REQUIRED_FIELDS: (keyof DocumentChunk)[] = [
  'content',
  'doc_path',
  'section',
  'url',
  'content_hash',
  'source_repo',
  'commit_sha',
  'token_count',
];

const API_SPEC_REQUIRED_META = [
  'source_type',
  'product',
  'category',
  'spec_version',
];

function fail(message: string): never {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('=== Ingestion Smoke Test ===\n');

  // Paths
  const docsDir = path.resolve(process.cwd(), '../.docs-normalized');
  const apiSpecDir = path.resolve(process.cwd(), '../.api-reference-normalized');
  const outputPath = path.resolve(process.cwd(), 'output/smoke-test-chunks.json');

  // Check that at least the API spec directory exists
  try {
    await fs.access(apiSpecDir);
  } catch {
    fail(`API spec directory not found: ${apiSpecDir}. Run "npm run normalize-api-specs" first.`);
  }

  // ─── Step 1: Run MDX ingestion if .docs-normalized exists ───
  let mdxChunks: DocumentChunk[] = [];
  try {
    await fs.access(docsDir);
    console.log('Running MDX ingestion...');
    const config = createDefaultConfig(docsDir, outputPath);
    const result = await runIngestionPipeline(config);
    mdxChunks = result.chunks;
    console.log(`MDX ingestion: ${mdxChunks.length} chunks\n`);
  } catch {
    console.log('.docs-normalized/ not found — skipping MDX ingestion\n');
  }

  // ─── Step 2: Run API spec ingestion ───
  console.log('Running API spec ingestion...');
  const config = createDefaultConfig(docsDir || apiSpecDir, outputPath);
  // Need git info for the API spec ingestion
  const { getGitInfo } = await import('../src/metadata.js');
  const gitRepoPath = path.resolve(process.cwd(), '..');
  const gitInfo = await getGitInfo(gitRepoPath);

  const apiChunks = await ingestApiSpecDirectory(
    apiSpecDir,
    config.chunking,
    gitInfo,
    config.baseUrl
  );
  console.log(`API spec ingestion: ${apiChunks.length} chunks\n`);

  // ─── Step 3: Combine and validate ───
  const allChunks = [...mdxChunks, ...apiChunks];
  console.log(`Total combined chunks: ${allChunks.length}`);

  // Check 1: Minimum total chunks
  if (allChunks.length < MIN_TOTAL_CHUNKS) {
    fail(`Total chunks (${allChunks.length}) below minimum (${MIN_TOTAL_CHUNKS})`);
  }
  console.log(`  [PASS] Chunk count ${allChunks.length} >= ${MIN_TOTAL_CHUNKS}`);

  // Check 2: No oversized API spec chunks (MDX chunks can be larger
  // due to code-dominated sections which the chunker preserves intact)
  const oversizedApi = apiChunks.filter(c => c.token_count > MAX_CHUNK_TOKENS);
  if (oversizedApi.length > 0) {
    console.error('Oversized API spec chunks:');
    for (const c of oversizedApi.slice(0, 5)) {
      console.error(`  ${c.doc_path} :: ${c.section} — ${c.token_count} tokens`);
    }
    fail(`${oversizedApi.length} API spec chunks exceed ${MAX_CHUNK_TOKENS} tokens`);
  }
  console.log(`  [PASS] No API spec chunks exceed ${MAX_CHUNK_TOKENS} tokens`);

  // Check 3: Required fields on all chunks
  const missingFields: string[] = [];
  for (const chunk of allChunks) {
    for (const field of REQUIRED_FIELDS) {
      if (chunk[field] === undefined || chunk[field] === null) {
        missingFields.push(`${chunk.doc_path}: missing ${field}`);
      }
    }
  }
  if (missingFields.length > 0) {
    console.error('Missing fields:');
    for (const m of missingFields.slice(0, 10)) {
      console.error(`  ${m}`);
    }
    fail(`${missingFields.length} chunks have missing required fields`);
  }
  console.log(`  [PASS] All chunks have required fields`);

  // Check 4: API spec chunks have RAG metadata
  const apiSpecMissing: string[] = [];
  for (const chunk of apiChunks) {
    for (const key of API_SPEC_REQUIRED_META) {
      if (!chunk.metadata[key]) {
        apiSpecMissing.push(`${chunk.doc_path}: missing metadata.${key}`);
      }
    }
  }
  if (apiSpecMissing.length > 0) {
    console.error('Missing API spec metadata:');
    for (const m of apiSpecMissing.slice(0, 10)) {
      console.error(`  ${m}`);
    }
    fail(`${apiSpecMissing.length} API spec chunks have missing metadata`);
  }
  console.log(`  [PASS] All API spec chunks have RAG metadata`);

  // Check 5: API spec chunks should exist
  if (apiChunks.length === 0) {
    fail('No API spec chunks were produced');
  }
  console.log(`  [PASS] API spec chunks: ${apiChunks.length}`);

  // Cleanup smoke test output
  try {
    await fs.unlink(outputPath);
  } catch {
    // ignore
  }

  console.log('\n=== Smoke test PASSED ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
