/**
 * S3 Content Upload
 *
 * Uploads chunk content to S3 keyed by content_hash.
 * Idempotent: lists existing objects and only uploads missing ones.
 * Same pattern as docs-ingestion/src/services/content/uploader.ts.
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3';
import type { DocumentChunk } from './types.js';

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

  constructor(bucketName: string, awsRegion: string, concurrency: number = 10) {
    this.bucketName = bucketName;
    this.concurrency = concurrency;
    this.s3Client = new S3Client({ region: awsRegion });
  }

  /**
   * Upload all chunks to S3 with idempotency.
   *
   * Uploads ALL chunks (not just embeddable) — S3 stores content
   * for the retrieval layer, independent of embedding token limits.
   */
  async uploadChunks(chunks: DocumentChunk[]): Promise<ContentUploadResult> {
    console.log(`📦 Preparing to upload ${chunks.length} chunks to S3...`);

    // List existing objects
    console.log('🔍 Checking existing objects in S3...');
    const existingHashes = await this.listExistingContentHashes();
    console.log(`   Found ${existingHashes.size} existing objects\n`);

    // Determine what to upload
    const toUpload: DocumentChunk[] = [];
    let skipped = 0;

    for (const chunk of chunks) {
      if (existingHashes.has(chunk.content_hash)) {
        skipped++;
      } else {
        toUpload.push(chunk);
      }
    }

    console.log(`   To upload (new): ${toUpload.length}`);
    console.log(`   To skip (exists): ${skipped}\n`);

    // Upload in batches
    let uploaded = 0;
    let failed = 0;

    if (toUpload.length > 0) {
      console.log('⬆️  Uploading new content to S3...');

      for (let i = 0; i < toUpload.length; i += this.concurrency) {
        const batch = toUpload.slice(i, i + this.concurrency);
        const results = await Promise.allSettled(
          batch.map(chunk => this.uploadChunk(chunk))
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            uploaded++;
          } else {
            failed++;
          }
        }

        const progress = Math.min(i + this.concurrency, toUpload.length);
        if (progress % 100 === 0 || progress === toUpload.length) {
          console.log(`   Progress: ${progress}/${toUpload.length} chunks...`);
        }
      }
    }

    if (failed > 0) {
      throw new Error(`${failed} S3 uploads failed`);
    }

    return { total: chunks.length, uploaded, skipped, failed };
  }

  /**
   * List all existing content hashes in S3 bucket (paginated).
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

      const response = await this.s3Client.send(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            hashes.add(obj.Key.replace(/\.txt$/, ''));
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return hashes;
  }

  /**
   * Upload a single chunk. Key format: {content_hash}.txt
   */
  private async uploadChunk(chunk: DocumentChunk): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: `${chunk.content_hash}.txt`,
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
