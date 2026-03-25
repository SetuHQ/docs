/**
 * Production Embedding Pipeline
 *
 * Orchestrates the full pipeline end-to-end:
 *   1. normalize-mdx        → .docs-normalized/
 *   2. normalize-api-specs   → .api-reference-normalized/
 *   3. ingestion             → chunks.json
 *   4. validation            → fail-fast on bad data
 *   5. namespace check        → log existing vector count
 *   6. backup                 → export current Pinecone state
 *   7. embedding + S3 upload  → real mode
 *
 * Usage:
 *   npm run embed-all
 *
 * Required env vars (real mode):
 *   PINECONE_API_KEY, AWS_REGION, CONTENT_BUCKET_NAME
 *
 * Optional:
 *   PINECONE_INDEX, BEDROCK_MODEL_ID, BATCH_SIZE, EMBEDDING_CONCURRENCY
 */

import { execSync } from "child_process";
import dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import { EmbeddingSync } from "./sync.js";
import type { DocumentChunk, EmbeddingConfig } from "./types.js";
import { VectorDB } from "./vector-db.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

// ── Constants ──────────────────────────────────────────────────────
const MIN_CHUNK_COUNT = 4000;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/; // SHA-256 hex
const REQUIRED_FIELDS: (keyof DocumentChunk)[] = [
  "content",
  "doc_path",
  "section",
  "url",
  "content_hash",
  "source_repo",
  "commit_sha",
  "token_count",
];

// ── Helpers ────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} environment variable is required`);
  return value;
}

function runStep(label: string, cmd: string, cwd: string): void {
  console.log(`\n── ${label} ──`);
  try {
    execSync(cmd, { cwd, stdio: "inherit" });
  } catch {
    fail(`${label} failed`);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Production Embedding Pipeline ===\n");

  const ingestionDir = path.resolve(process.cwd(), "..", "docs-ingestion");
  const chunksPath = path.join(ingestionDir, "output", "chunks.json");

  // ────────────────────────────────────────────────────────────────
  // Step 1: Normalize MDX (skip if no content/ directory)
  // ────────────────────────────────────────────────────────────────
  const contentDir = path.resolve(process.cwd(), "..", "content");
  try {
    await fs.access(contentDir);
    runStep("Normalize MDX", "yarn normalize-mdx", ingestionDir);
  } catch {
    console.log("\nNo content/ directory — skipping MDX normalization");
  }

  // ────────────────────────────────────────────────────────────────
  // Step 2: Normalize API specs
  // ────────────────────────────────────────────────────────────────
  runStep("Normalize API specs", "yarn normalize-api-specs", ingestionDir);

  // ────────────────────────────────────────────────────────────────
  // Step 3: Run ingestion
  // ────────────────────────────────────────────────────────────────
  runStep("Run ingestion", "node dist/index.js", ingestionDir);

  // ────────────────────────────────────────────────────────────────
  // Step 4: Validate chunks
  // ────────────────────────────────────────────────────────────────
  console.log("\n── Validating chunks ──");

  let raw: string;
  try {
    raw = await fs.readFile(chunksPath, "utf-8");
  } catch {
    fail(`chunks.json not found at ${chunksPath}`);
  }

  const data = JSON.parse(raw!);
  const chunks: DocumentChunk[] = data.chunks;

  // 4a – minimum chunk count
  if (chunks.length < MIN_CHUNK_COUNT) {
    fail(`Chunk count ${chunks.length} < minimum ${MIN_CHUNK_COUNT}`);
  }
  console.log(`  [PASS] Chunk count: ${chunks.length} >= ${MIN_CHUNK_COUNT}`);

  // 4b – required fields
  const fieldErrors: string[] = [];
  for (const chunk of chunks) {
    for (const field of REQUIRED_FIELDS) {
      if (chunk[field] === undefined || chunk[field] === null) {
        fieldErrors.push(`${chunk.doc_path}: missing ${field}`);
      }
    }
  }
  if (fieldErrors.length > 0) {
    for (const e of fieldErrors.slice(0, 10)) console.error(`  ${e}`);
    fail(`${fieldErrors.length} chunks have missing required fields`);
  }
  console.log("  [PASS] All chunks have required fields");

  // 4c – content_hash format (SHA-256 hex)
  const badHashes = chunks.filter((c) => !CONTENT_HASH_RE.test(c.content_hash));
  if (badHashes.length > 0) {
    for (const c of badHashes.slice(0, 5)) {
      console.error(
        `  ${c.doc_path}: malformed content_hash "${c.content_hash}"`,
      );
    }
    fail(`${badHashes.length} chunks have missing or malformed content_hash`);
  }
  console.log("  [PASS] All content_hash values are valid SHA-256 hex");

  // ────────────────────────────────────────────────────────────────
  // Step 5: Pinecone namespace safeguard
  // ────────────────────────────────────────────────────────────────
  console.log("\n── Pinecone namespace check ──");

  const pineconeApiKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX;
  if (!pineconeIndex) {
    fail("PINECONE_INDEX environment variable is required");
  }

  if (!pineconeApiKey) {
    fail("PINECONE_API_KEY environment variable is required");
  }

  const vectorDB = new VectorDB(pineconeApiKey!, pineconeIndex);
  await vectorDB.connect();

  const stats = await vectorDB.getStats();
  console.log(
    `  Index "${pineconeIndex}": ${stats.totalVectorCount} existing vectors`,
  );

  if (stats.totalVectorCount > 0) {
    console.log(
      "  [OK] Namespace has vectors — sync is idempotent, proceeding with upsert",
    );
  } else {
    console.log("  [OK] Namespace empty — first run");
  }

  // ────────────────────────────────────────────────────────────────
  // Step 6: Backup existing vectors
  // ────────────────────────────────────────────────────────────────
  let backupPath = "";

  if (stats.totalVectorCount > 0) {
    console.log("\n── Backing up existing vectors ──");
    const backupDir = path.join(process.cwd(), "backup");
    await fs.mkdir(backupDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backupDir, `pinecone-backup-${ts}.json`);

    try {
      console.log("  Listing vector IDs...");
      const ids = await vectorDB.listAllIds();
      console.log(`  Found ${ids.length} vector IDs`);

      console.log("  Fetching metadata...");
      const backupRecords: Array<{
        id: string;
        metadata: Record<string, any>;
      }> = [];
      const BATCH = 100;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const fetched = await vectorDB.fetchVectorsWithMetadata(batch);
        backupRecords.push(...fetched);

        if ((i + BATCH) % 500 === 0 || i + BATCH >= ids.length) {
          console.log(
            `  Backed up ${Math.min(i + BATCH, ids.length)}/${ids.length}...`,
          );
        }
      }

      const backup = {
        timestamp: new Date().toISOString(),
        index: pineconeIndex,
        total_vectors: backupRecords.length,
        vectors: backupRecords,
      };

      await fs.writeFile(backupPath, JSON.stringify(backup, null, 2), "utf-8");
      console.log(`  Saved backup to ${backupPath}`);
      console.log(`  Backup contains ${backupRecords.length} vectors`);
    } catch (error) {
      // Graceful degradation — save stats-only backup
      console.warn(`  Warning: full backup failed: ${error}`);
      console.warn(
        `  Saving stats-only backup (${stats.totalVectorCount} vectors)`,
      );

      const statsBackup = {
        timestamp: new Date().toISOString(),
        index: pineconeIndex,
        total_vectors: stats.totalVectorCount,
        note: "Full vector export failed — stats-only backup",
      };
      await fs.writeFile(
        backupPath,
        JSON.stringify(statsBackup, null, 2),
        "utf-8",
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Step 7: Run real embedding + S3 upload
  // ────────────────────────────────────────────────────────────────
  console.log("\n── Running embedding sync (REAL MODE) ──");

  const config: EmbeddingConfig = {
    ingestionOutputPath: chunksPath,
    stateFilePath: path.join(process.cwd(), "state", "indexed-hashes.json"),
    awsRegion: requireEnv("AWS_REGION"),
    bedrockModelId: requireEnv("BEDROCK_MODEL_ID"),
    pineconeApiKey: pineconeApiKey!,
    pineconeIndex: pineconeIndex!,
    batchSize: parseInt(requireEnv("BATCH_SIZE"), 10),
    s3ContentBucket: process.env.CONTENT_BUCKET_NAME || undefined,
    dryRun: false,
    embeddingConcurrency: parseInt(requireEnv("EMBEDDING_CONCURRENCY"), 10),
  };

  try {
    const sync = new EmbeddingSync(config);
    const syncStats = await sync.sync();

    console.log("\n=== Production embedding PASSED ===");
    console.log(`  Vectors inserted:  ${syncStats.vectors_inserted}`);
    console.log(`  Vectors updated:   ${syncStats.vectors_updated}`);
    console.log(`  Vectors deleted:   ${syncStats.vectors_deleted}`);
    console.log(`  S3 uploaded:       ${syncStats.s3_uploaded}`);
    console.log(`  S3 skipped:        ${syncStats.s3_skipped}`);
    console.log(`  Bedrock API calls: ${syncStats.embedding_api_calls}`);
    console.log(
      '\nNext: run "yarn verify-embed" to confirm everything landed correctly.\n',
    );
  } catch (error) {
    console.error("\n❌ Embedding failed mid-way!\n");
    printRestoreInstructions(backupPath, pineconeIndex);
    process.exit(1);
  }
}

function printRestoreInstructions(backupPath: string, indexName: string): void {
  console.error("── Restore Instructions ──");
  console.error("");
  if (backupPath) {
    console.error(`1. A backup was saved before this run:`);
    console.error(`     ${backupPath}`);
    console.error(
      "   It contains vector IDs + metadata from the previous state.",
    );
  } else {
    console.error(
      "1. No backup was created (namespace was empty before this run).",
    );
  }
  console.error("");
  console.error("2. Newly inserted vectors can be identified by comparing");
  console.error("   state/indexed-hashes.json with the backup file.");
  console.error("");
  console.error("3. To re-run safely after fixing the issue:");
  console.error("     FORCE_EMBED=true npm run embed-all");
  console.error(
    "   The pipeline is idempotent — existing vectors are skipped.",
  );
  console.error("");
  console.error(`4. To manually inspect the index:`);
  console.error(`     Pinecone index: ${indexName}`);
  console.error("");
  console.error(
    "5. Do NOT manually delete vectors unless you understand the impact.",
  );
  console.error("");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
