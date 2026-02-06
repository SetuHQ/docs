/**
 * Post-Embed Verification
 *
 * Run after `npm run embed-all` to confirm:
 *   1. Pinecone vector count matches expected embeddable chunks
 *   2. Content bodies exist in S3 (spot-check sample)
 *   3. API-spec chunks have required metadata in Pinecone
 *
 * Usage:
 *   npm run verify-embed
 *
 * Required env vars:
 *   PINECONE_API_KEY
 *
 * Optional:
 *   PINECONE_INDEX, CONTENT_BUCKET_NAME, AWS_REGION, INGESTION_OUTPUT_PATH
 */

import dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { VectorDB } from './vector-db.js';
import type { DocumentChunk } from './types.js';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const API_SPEC_META_FIELDS = ['source_type', 'product', 'category', 'spec_version'];

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('=== Post-Embed Verification ===\n');

  // ── Load chunks.json ─────────────────────────────────────────
  const chunksPath = process.env.INGESTION_OUTPUT_PATH ||
    path.join(process.cwd(), '..', 'docs-ingestion', 'output', 'chunks.json');

  let raw: string;
  try {
    raw = await fs.readFile(chunksPath, 'utf-8');
  } catch {
    fail(`Cannot read chunks.json at ${chunksPath}`);
  }

  const data = JSON.parse(raw!);
  const chunks: DocumentChunk[] = data.chunks;
  console.log(`Loaded ${chunks.length} chunks from ${chunksPath}`);

  // Same thresholds as sync.ts filterChunks
  const embeddable = chunks.filter(c => c.token_count >= 80 && c.token_count <= 1500);
  console.log(`Embeddable chunks: ${embeddable.length}\n`);

  // ── Connect to Pinecone ──────────────────────────────────────
  const pineconeApiKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX || 'docs-embeddings';

  if (!pineconeApiKey) {
    fail('PINECONE_API_KEY environment variable is required');
  }

  const vectorDB = new VectorDB(pineconeApiKey!, pineconeIndex);
  await vectorDB.connect();

  // ── Check 1: Pinecone vector count ───────────────────────────
  console.log('── Check 1: Pinecone vector count ──');

  const stats = await vectorDB.getStats();
  console.log(`  Pinecone vectors:     ${stats.totalVectorCount}`);
  console.log(`  Expected (embeddable): ${embeddable.length}`);

  if (stats.totalVectorCount < embeddable.length * 0.9) {
    fail(
      `Vector count ${stats.totalVectorCount} is less than 90% ` +
      `of expected ${embeddable.length}`
    );
  }
  console.log('  [PASS] Vector count within expected range\n');

  // ── Check 2: S3 content existence (spot check) ──────────────
  console.log('── Check 2: S3 content existence ──');

  const bucketName = process.env.CONTENT_BUCKET_NAME;
  if (!bucketName) {
    console.log('  CONTENT_BUCKET_NAME not set — skipping S3 check\n');
  } else {
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

    // Deterministic sample: pick every Nth chunk instead of random
    const sampleSize = Math.min(50, chunks.length);
    const step = Math.max(1, Math.floor(chunks.length / sampleSize));
    const sample: DocumentChunk[] = [];
    for (let i = 0; i < chunks.length && sample.length < sampleSize; i += step) {
      sample.push(chunks[i]);
    }

    let found = 0;
    let missing = 0;

    for (const chunk of sample) {
      try {
        await s3.send(new HeadObjectCommand({
          Bucket: bucketName,
          Key: `${chunk.content_hash}.txt`
        }));
        found++;
      } catch {
        missing++;
        if (missing <= 5) {
          console.error(`  Missing: ${chunk.content_hash} (${chunk.doc_path})`);
        }
      }
    }

    console.log(`  Checked ${sample.length} chunks: ${found} found, ${missing} missing`);

    if (missing > sampleSize * 0.1) {
      fail(`${missing}/${sample.length} sampled chunks missing from S3`);
    }
    console.log('  [PASS] S3 content exists for sampled chunks\n');
  }

  // ── Check 3: API-spec chunk metadata ─────────────────────────
  console.log('── Check 3: API-spec chunk metadata ──');

  const apiSpecChunks = chunks.filter(c => c.doc_path.startsWith('api-reference/'));
  console.log(`  API-spec chunks in chunks.json: ${apiSpecChunks.length}`);

  if (apiSpecChunks.length === 0) {
    console.log('  No API-spec chunks found — skipping\n');
  } else {
    const metaErrors: string[] = [];
    for (const chunk of apiSpecChunks) {
      for (const field of API_SPEC_META_FIELDS) {
        if (!chunk.metadata[field]) {
          metaErrors.push(`${chunk.doc_path}: missing metadata.${field}`);
        }
      }
    }

    if (metaErrors.length > 0) {
      for (const e of metaErrors.slice(0, 10)) console.error(`  ${e}`);
      fail(`${metaErrors.length} API-spec chunks have missing metadata`);
    }
    console.log(`  [PASS] All ${apiSpecChunks.length} API-spec chunks have required metadata\n`);
  }

  // ── Check 4: Pinecone metadata spot check (API-spec vectors) ─
  console.log('── Check 4: Pinecone metadata spot check ──');

  const apiEmbeddable = apiSpecChunks.filter(
    c => c.token_count >= 80 && c.token_count <= 1500
  );

  if (apiEmbeddable.length === 0) {
    console.log('  No embeddable API-spec chunks — skipping\n');
  } else {
    const spotIds = apiEmbeddable.slice(0, 10).map(c => c.content_hash);
    const fetched = await vectorDB.fetchVectorsWithMetadata(spotIds);

    let metaOk = 0;
    for (const record of fetched) {
      if (record.metadata.source_type && record.metadata.product) {
        metaOk++;
      }
    }

    console.log(`  Checked ${fetched.length} API-spec vectors in Pinecone`);
    console.log(`  With source_type + product: ${metaOk}/${fetched.length}`);

    if (fetched.length > 0 && metaOk < fetched.length * 0.9) {
      fail('API-spec metadata not properly stored in Pinecone');
    }
    console.log('  [PASS] Pinecone vectors have API-spec metadata\n');
  }

  console.log('=== All verification checks PASSED ===\n');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
