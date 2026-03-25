/**
 * Embedding Pipeline CLI
 */

import dotenv from 'dotenv';
import * as path from 'path';
import { EmbeddingSync } from './sync.js';
import type { EmbeddingConfig } from './types.js';

// Load environment variables from .env.local (priority) and .env
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

async function main() {
  try {
    const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

    // Load config from environment
    const config: EmbeddingConfig = {
      ingestionOutputPath: process.env.INGESTION_OUTPUT_PATH ||
        path.join(process.cwd(), '..', 'docs-ingestion', 'output', 'chunks.json'),
      stateFilePath: process.env.STATE_FILE_PATH ||
        path.join(process.cwd(), 'state', 'indexed-hashes.json'),
      awsRegion: process.env.AWS_REGION || 'ap-south-1',
      bedrockModelId: process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0',
      pineconeApiKey: process.env.PINECONE_API_KEY || '',
      pineconeIndex: process.env.PINECONE_INDEX || 'docs-embeddings',
      batchSize: parseInt(process.env.BATCH_SIZE || '25', 10),
      s3ContentBucket: process.env.CONTENT_BUCKET_NAME || undefined,
      dryRun,
      embeddingConcurrency: parseInt(process.env.EMBEDDING_CONCURRENCY || '3', 10),
    };

    // Validate (Pinecone key not required in dry-run)
    if (!dryRun && !config.pineconeApiKey) {
      throw new Error('PINECONE_API_KEY environment variable is required');
    }

    console.log('Configuration:');
    console.log(`  Ingestion output: ${config.ingestionOutputPath}`);
    console.log(`  State file: ${config.stateFilePath}`);
    console.log(`  AWS region: ${config.awsRegion}`);
    console.log(`  Bedrock model: ${config.bedrockModelId}`);
    console.log(`  Pinecone index: ${config.pineconeIndex}`);
    console.log(`  Batch size: ${config.batchSize}`);
    console.log(`  S3 bucket: ${config.s3ContentBucket || '(not configured)'}`);
    console.log(`  Embedding concurrency: ${config.embeddingConcurrency}`);
    console.log(`  Dry run: ${dryRun}\n`);

    // Run sync
    const sync = new EmbeddingSync(config);
    await sync.sync();

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Embedding sync failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
