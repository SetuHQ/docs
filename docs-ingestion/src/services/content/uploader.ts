/**
 * S3 Content Upload Pipeline
 *
 * Uploads document chunk content to S3 for retrieval layer
 * - Idempotent: skips existing objects
 * - Batched: parallel uploads with concurrency control
 * - Deterministic: always produces same S3 state from same input
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { DocumentChunk } from '../../types.js';

export interface ContentUploadResult {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

export class ContentUploader {
  private s3Client: S3Client;
  private bucketName: string;
  private concurrency: number;

  constructor(
    bucketName: string,
    awsRegion: string,
    concurrency: number = 10
  ) {
    this.bucketName = bucketName;
    this.concurrency = concurrency;
    this.s3Client = new S3Client({ region: awsRegion });
  }

  /**
   * Upload chunks to S3 with idempotency
   *
   * Strategy:
   * 1. List all existing objects in bucket (paginated)
   * 2. Build a Set of existing content_hashes
   * 3. Upload only missing content_hashes
   * 4. Use controlled concurrency to avoid rate limits
   */
  async uploadChunks(chunks: DocumentChunk[]): Promise<ContentUploadResult> {
    console.log(`📦 Preparing to upload ${chunks.length} chunks to S3...`);

    // Step 1: Get existing objects from S3
    console.log('🔍 Checking existing objects in S3...');
    const existingHashes = await this.listExistingContentHashes();
    console.log(`   Found ${existingHashes.size} existing objects\n`);

    // Step 2: Determine what to upload
    const toUpload: DocumentChunk[] = [];
    const toSkip: DocumentChunk[] = [];

    for (const chunk of chunks) {
      if (existingHashes.has(chunk.content_hash)) {
        toSkip.push(chunk);
      } else {
        toUpload.push(chunk);
      }
    }

    console.log('📊 Upload plan:');
    console.log(`   Total chunks:    ${chunks.length}`);
    console.log(`   To upload (new): ${toUpload.length}`);
    console.log(`   To skip (exists):${toSkip.length}\n`);

    // Step 3: Upload in batches with concurrency control
    let uploaded = 0;
    let failed = 0;

    if (toUpload.length > 0) {
      console.log('⬆️  Uploading new content to S3...');

      const results = await this.uploadBatched(toUpload);
      uploaded = results.uploaded;
      failed = results.failed;

      console.log(`   Uploaded: ${uploaded}`);
      console.log(`   Failed:   ${failed}\n`);
    }

    // Step 4: Hard fail if any uploads failed
    if (failed > 0) {
      throw new Error(`❌ ${failed} uploads failed. Please fix errors and retry.`);
    }

    return {
      total: chunks.length,
      uploaded,
      skipped: toSkip.length,
      failed
    };
  }

  /**
   * List all existing content hashes in S3 bucket
   *
   * Uses pagination to handle large buckets
   */
  private async listExistingContentHashes(): Promise<Set<string>> {
    const hashes = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        ContinuationToken: continuationToken,
        MaxKeys: 1000
      });

      try {
        const response = await this.s3Client.send(command);

        if (response.Contents) {
          for (const obj of response.Contents) {
            if (obj.Key) {
              // Extract content_hash from key (remove .txt extension)
              const hash = obj.Key.replace(/\.txt$/, '');
              hashes.add(hash);
            }
          }
        }

        continuationToken = response.NextContinuationToken;
      } catch (error: any) {
        if (error.name === 'NoSuchBucket') {
          throw new Error(
            `❌ S3 bucket '${this.bucketName}' does not exist. ` +
            `Please create it first or check your CONTENT_BUCKET_NAME configuration.`
          );
        }
        throw error;
      }
    } while (continuationToken);

    return hashes;
  }

  /**
   * Upload chunks with controlled concurrency
   *
   * Uses a simple batching approach to limit concurrent uploads
   */
  private async uploadBatched(chunks: DocumentChunk[]): Promise<{ uploaded: number; failed: number }> {
    let uploaded = 0;
    let failed = 0;
    const errors: Array<{ hash: string; error: string }> = [];

    // Process in batches
    for (let i = 0; i < chunks.length; i += this.concurrency) {
      const batch = chunks.slice(i, i + this.concurrency);

      // Upload batch in parallel
      const promises = batch.map(chunk => this.uploadChunk(chunk));
      const results = await Promise.allSettled(promises);

      // Count results
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          uploaded++;
        } else {
          failed++;
          errors.push({
            hash: batch[j].content_hash,
            error: result.reason?.message || String(result.reason)
          });
        }
      }

      // Progress indicator
      const progress = Math.min(i + this.concurrency, chunks.length);
      if (progress % 100 === 0 || progress === chunks.length) {
        console.log(`   Progress: ${progress}/${chunks.length} chunks...`);
      }
    }

    // Log errors if any
    if (errors.length > 0) {
      console.error('\n❌ Upload errors:');
      for (const err of errors.slice(0, 10)) {
        console.error(`   ${err.hash}: ${err.error}`);
      }
      if (errors.length > 10) {
        console.error(`   ... and ${errors.length - 10} more errors`);
      }
      console.error('');
    }

    return { uploaded, failed };
  }

  /**
   * Upload a single chunk to S3
   *
   * Key format: <content_hash>.txt
   * Body: raw UTF-8 content
   */
  private async uploadChunk(chunk: DocumentChunk): Promise<void> {
    const key = `${chunk.content_hash}.txt`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: chunk.content,
      ContentType: 'text/plain; charset=utf-8',
      Metadata: {
        'doc-path': chunk.doc_path,
        'source-repo': chunk.source_repo,
        'commit-sha': chunk.commit_sha
      }
    });

    await this.s3Client.send(command);
  }
}

/**
 * Convenience function for uploading chunks
 */
export async function uploadChunksToS3(
  chunks: DocumentChunk[],
  bucketName: string,
  awsRegion: string
): Promise<ContentUploadResult> {
  const uploader = new ContentUploader(bucketName, awsRegion);
  return await uploader.uploadChunks(chunks);
}
