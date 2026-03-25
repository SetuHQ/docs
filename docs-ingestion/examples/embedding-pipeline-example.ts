/**
 * Example: Using Embedding Guardrails in Your Embedding Pipeline
 *
 * This example shows how to use the shouldEmbed() function and
 * is_oversized flag when generating embeddings.
 */

import type { DocumentChunk } from '../src/types.js';
import { shouldEmbed, categorizeChunks } from '../src/embedding-helpers.js';

/**
 * Example 1: Filter chunks before embedding
 */
async function basicEmbeddingPipeline(chunks: DocumentChunk[]) {
  console.log(`Total chunks: ${chunks.length}`);

  // Filter to embeddable chunks only
  const embeddableChunks = chunks.filter(shouldEmbed);

  console.log(`Will embed: ${embeddableChunks.length} chunks`);
  console.log(`Will skip: ${chunks.length - embeddableChunks.length} chunks`);

  // Generate embeddings
  for (const chunk of embeddableChunks) {
    const embedding = await generateEmbedding(chunk.content);
    await storeEmbedding(chunk, embedding);
  }
}

/**
 * Example 2: Detailed analysis before embedding
 */
async function analyzedEmbeddingPipeline(chunks: DocumentChunk[]) {
  // Get detailed categorization
  const analysis = categorizeChunks(chunks);

  console.log('Embedding Analysis:');
  console.log(`  Total: ${analysis.stats.total}`);
  console.log(`  Embeddable: ${analysis.stats.embeddable}`);
  console.log(`  Too small: ${analysis.stats.tooSmall}`);
  console.log(`  Too large: ${analysis.stats.tooLarge}`);
  console.log(`  Oversized: ${analysis.stats.oversized}`);

  // Log skipped chunks for review
  for (const chunk of analysis.tooSmall) {
    console.log(`Skipping (too small): ${chunk.section} (${chunk.token_count} tokens)`);
  }

  for (const chunk of analysis.tooLarge) {
    console.log(`Skipping (too large): ${chunk.section} (${chunk.token_count} tokens)`);
  }

  // Embed only valid chunks
  for (const chunk of analysis.embeddable) {
    const embedding = await generateEmbedding(chunk.content);
    await storeEmbedding(chunk, embedding);
  }
}

/**
 * Example 3: Special handling for oversized chunks
 */
async function smartEmbeddingPipeline(chunks: DocumentChunk[]) {
  const results = {
    embedded: 0,
    skipped: 0,
    oversizedHandled: 0
  };

  for (const chunk of chunks) {
    // Check if embeddable
    if (!shouldEmbed(chunk)) {
      results.skipped++;
      continue;
    }

    // Generate embedding
    const embedding = await generateEmbedding(chunk.content);

    // Store with metadata
    await storeEmbedding(chunk, embedding);
    results.embedded++;

    // Special handling for oversized chunks
    if (chunk.is_oversized) {
      console.warn(`Oversized chunk embedded: ${chunk.section} (${chunk.token_count} tokens)`);

      // Option 1: Generate multiple embeddings by splitting
      // await generateMultipleEmbeddings(chunk);

      // Option 2: Flag in vector DB for special retrieval
      // await flagAsOversized(chunk.content_hash);

      // Option 3: Just log for monitoring
      results.oversizedHandled++;
    }
  }

  console.log('Embedding Results:');
  console.log(`  Embedded: ${results.embedded}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log(`  Oversized handled: ${results.oversizedHandled}`);

  return results;
}

/**
 * Example 4: OpenAI Embeddings Integration
 */
import OpenAI from 'openai';

async function embedWithOpenAI(chunks: DocumentChunk[]) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const embeddableChunks = chunks.filter(shouldEmbed);
  const embeddings = [];

  for (const chunk of embeddableChunks) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: chunk.content,
        encoding_format: 'float'
      });

      embeddings.push({
        id: chunk.content_hash,
        embedding: response.data[0].embedding,
        metadata: {
          doc_path: chunk.doc_path,
          section_path: chunk.section_path,
          page_context: chunk.page_context,
          url: chunk.url,
          token_count: chunk.token_count,
          is_oversized: chunk.is_oversized
        }
      });

      // Log progress
      if (embeddings.length % 100 === 0) {
        console.log(`Embedded ${embeddings.length}/${embeddableChunks.length} chunks`);
      }
    } catch (error) {
      console.error(`Error embedding chunk ${chunk.content_hash}:`, error);
    }
  }

  return embeddings;
}

/**
 * Example 5: Pinecone Vector DB Integration
 */
import { Pinecone } from '@pinecone-database/pinecone';

async function upsertToPinecone(chunks: DocumentChunk[]) {
  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!
  });

  const index = pinecone.index('docs-embeddings');

  // Analyze chunks
  const analysis = categorizeChunks(chunks);
  console.log(`Upserting ${analysis.embeddable.length} chunks to Pinecone`);

  // Batch process
  const batchSize = 100;
  for (let i = 0; i < analysis.embeddable.length; i += batchSize) {
    const batch = analysis.embeddable.slice(i, i + batchSize);
    const vectors = [];

    for (const chunk of batch) {
      const embedding = await generateEmbedding(chunk.content);

      vectors.push({
        id: chunk.content_hash,
        values: embedding,
        metadata: {
          doc_path: chunk.doc_path,
          section: chunk.section,
          section_path: JSON.stringify(chunk.section_path),
          page_context: chunk.page_context,
          url: chunk.url,
          token_count: chunk.token_count,
          is_oversized: chunk.is_oversized
        }
      });
    }

    await index.upsert(vectors);
    console.log(`Upserted batch ${Math.floor(i / batchSize) + 1}`);
  }
}

/**
 * Placeholder functions (implement based on your setup)
 */
async function generateEmbedding(text: string): Promise<number[]> {
  // Implement with your embedding model
  return [];
}

async function storeEmbedding(chunk: DocumentChunk, embedding: number[]): Promise<void> {
  // Implement with your vector database
}

/**
 * Example: Load chunks and process
 */
async function main() {
  // Load chunks from ingestion output
  const chunksData = await import('../output/chunks.json');
  const chunks = chunksData.chunks as DocumentChunk[];

  // Choose your approach
  await basicEmbeddingPipeline(chunks);
  // OR
  // await analyzedEmbeddingPipeline(chunks);
  // OR
  // await smartEmbeddingPipeline(chunks);
  // OR
  // await embedWithOpenAI(chunks);
  // OR
  // await upsertToPinecone(chunks);
}

// Export for use in other modules
export {
  basicEmbeddingPipeline,
  analyzedEmbeddingPipeline,
  smartEmbeddingPipeline,
  embedWithOpenAI,
  upsertToPinecone
};
