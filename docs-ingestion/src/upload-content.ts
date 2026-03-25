/**
 * Content Upload CLI
 *
 * Uploads document chunks to S3 for retrieval layer
 * Run after ingestion, before embedding sync
 */

import dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import { uploadChunksToS3 } from "./services/content/uploader.js";
import type { DocumentChunk } from "./types.js";

// Load environment variables from .env.local (priority) and .env
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

async function main() {
  try {
    // Load config from environment
    const bucketName = process.env.CONTENT_BUCKET_NAME;
    const awsRegion = process.env.AWS_REGION;
    if (!awsRegion) {
      throw new Error("AWS_REGION environment variable is required");
    }
    const outputPath =
      process.env.OUTPUT_PATH ||
      path.join(process.cwd(), "output", "chunks.json");

    // Validate required config
    if (!bucketName) {
      throw new Error("CONTENT_BUCKET_NAME environment variable is required");
    }

    console.log("Content Upload Configuration:");
    console.log(`  S3 Bucket:        ${bucketName}`);
    console.log(`  AWS Region:       ${awsRegion}`);
    console.log(`  Chunks file:      ${outputPath}\n`);

    // Load chunks from output
    console.log("📥 Loading chunks from ingestion output...");
    const content = await fs.readFile(outputPath, "utf-8");
    const data = JSON.parse(content);
    const chunks: DocumentChunk[] = data.chunks;
    console.log(`   Loaded ${chunks.length} chunks\n`);

    // Upload to S3
    console.log("🚀 Starting content upload to S3\n");
    const startTime = Date.now();

    const result = await uploadChunksToS3(chunks, bucketName, awsRegion);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Print summary
    console.log("📊 Content Upload Summary");
    console.log("═══════════════════════════════════════");
    console.log(`Total chunks:     ${result.total}`);
    console.log(`Uploaded (new):   ${result.uploaded}`);
    console.log(`Skipped (exists): ${result.skipped}`);
    console.log(`Failed:           ${result.failed}`);
    console.log(`Duration:         ${duration}s`);
    console.log("═══════════════════════════════════════\n");

    if (result.uploaded === 0 && result.skipped > 0) {
      console.log("✅ All content already exists in S3 - no uploads needed\n");
    } else if (result.uploaded > 0) {
      console.log(
        `✅ Successfully uploaded ${result.uploaded} new chunks to S3\n`,
      );
    }

    console.log("✨ Content upload complete!\n");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Content upload failed:", error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
