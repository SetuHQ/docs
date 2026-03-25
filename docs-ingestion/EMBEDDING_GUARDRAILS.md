# Embedding Guardrails Documentation

## Overview

This document describes the **embedding-time guardrails** added to the ingestion pipeline. These guardrails do NOT modify the ingestion process - they only provide filtering logic and metadata for the downstream embedding pipeline.

---

## Implementation

### 1. Helper Function: `shouldEmbed()`

**File**: `src/embedding-helpers.ts`

```typescript
export function shouldEmbed(chunk: DocumentChunk): boolean {
  const tokenCount = chunk.token_count;

  // Too small - insufficient semantic content
  if (tokenCount < 80) {
    return false;
  }

  // Too large - will dominate vector search
  if (tokenCount > 1500) {
    return false;
  }

  return true;
}
```

**Usage in Embedding Pipeline**:

```typescript
import { shouldEmbed } from './embedding-helpers.js';

// Filter chunks before embedding
const chunksToEmbed = allChunks.filter(shouldEmbed);

// Generate embeddings only for valid chunks
for (const chunk of chunksToEmbed) {
  const embedding = await generateEmbedding(chunk.content);
  await upsertToVectorDB(chunk, embedding);
}
```

---

### 2. Metadata Flag: `is_oversized`

**Added to**: `src/types.ts` (DocumentChunk interface)

```typescript
export interface DocumentChunk {
  // ... existing fields
  token_count: number;
  is_oversized: boolean;  // NEW: true if > 1200 tokens
  // ... other fields
}
```

**Set in**: `src/metadata.ts` (enrichChunk function)

```typescript
const isOversized = textChunk.tokenCount > 1200;

return {
  // ... other fields
  token_count: textChunk.tokenCount,
  is_oversized: isOversized,
  // ... metadata
};
```

---

### 3. Structured Logging

**Added to**: `src/index.ts` (main pipeline)

```typescript
import { categorizeChunks, logEmbeddingStats } from './embedding-helpers.js';

// After ingestion completes
const embeddingAnalysis = categorizeChunks(finalChunks);
logEmbeddingStats(embeddingAnalysis.stats);
```

**Output**:

```
📊 Embedding Readiness Report
═══════════════════════════════════════
Total chunks:              2158
Embeddable chunks:         2028 (94.0%)

Skipped chunks:
  - Too small (<80 tok):   71 (3.3%)
  - Too large (>1500 tok): 59 (2.7%)

Oversized (>1200 tok):     76 (3.5%)
  ↳ These chunks are embeddable but may need special handling
═══════════════════════════════════════
```

---

## Example: Before and After

### Before (No Guardrails)

```json
{
  "content": "UPI Setu is a comprehensive...",
  "doc_path": "payments/umap/overview.mdx",
  "section": "Overview > What is UPI Setu?",
  "section_path": ["Overview", "What is UPI Setu?"],
  "page_context": "UPI Setu - Overview | Overview",
  "url": "https://docs.setu.co/payments/umap/overview",
  "content_hash": "e3469962088...",
  "source_repo": "SetuHQ/docs",
  "commit_sha": "1b05cf8c...",
  "token_count": 365,
  "metadata": {
    "page_title": "UPI Setu - Overview",
    "sidebar_title": "Overview"
  }
}
```

### After (With Guardrails)

```json
{
  "content": "UPI Setu is a comprehensive...",
  "doc_path": "payments/umap/overview.mdx",
  "section": "Overview > What is UPI Setu?",
  "section_path": ["Overview", "What is UPI Setu?"],
  "page_context": "UPI Setu - Overview | Overview",
  "url": "https://docs.setu.co/payments/umap/overview",
  "content_hash": "e3469962088...",
  "source_repo": "SetuHQ/docs",
  "commit_sha": "1b05cf8c...",
  "token_count": 365,
  "is_oversized": false,
  "metadata": {
    "page_title": "UPI Setu - Overview",
    "sidebar_title": "Overview"
  }
}
```

**Changes**:
- ✅ Added `is_oversized: false` (not oversized)
- ✅ All existing fields preserved
- ✅ No content modification

**Example of Oversized Chunk**:

```json
{
  "content": "...[14,026 tokens of FI data types]...",
  "doc_path": "data/account-aggregator/v1/fi-data-types.mdx",
  "section": "FI data types",
  "token_count": 14026,
  "is_oversized": true,
  "...": "..."
}
```

**Embedding Pipeline Decision**:

```typescript
// Chunk with 365 tokens
shouldEmbed(chunk) // true - will be embedded

// Chunk with 14,026 tokens
shouldEmbed(chunk) // false - skipped (too large)
```

---

## Statistics from Current Run

```
Total chunks:              2,158
Embeddable:                2,028 (94.0%)

Skipped (too small):       71 (3.3%)
  ↳ Micro-chunks with insufficient content
  ↳ Examples: "Sample Response" (3 tokens), API endpoints

Skipped (too large):       59 (2.7%)
  ↳ Reference documentation, data type listings
  ↳ Examples: FI data types (14,026 tokens), API specs

Oversized (>1200 tokens):  76 (3.5%)
  ↳ Embeddable but may dominate vector search
  ↳ Consider chunking further or using long-context models
```

---

## Why This Logic Belongs at Embedding Time

### ❌ Why NOT in Ingestion Pipeline

1. **Completeness**: All content should be ingested and stored
   - Source of truth for documentation
   - May be useful for non-embedding use cases (full-text search, exports, audits)

2. **Flexibility**: Embedding thresholds may change
   - Different embedding models have different optimal sizes
   - A/B testing may require adjusting thresholds
   - Future models may handle larger contexts

3. **Separation of Concerns**:
   - Ingestion: Parse → Chunk → Store
   - Embedding: Filter → Embed → Index
   - Clean architecture with clear boundaries

### ✅ Why AT Embedding Time

1. **Embedding Model Constraints**:
   - Models have token limits (e.g., OpenAI: 8191 tokens)
   - Very small chunks waste API calls and storage
   - Very large chunks dominate similarity search

2. **Retrieval Quality**:
   - Micro-chunks (< 80 tokens) add noise to search results
   - Oversized chunks (> 1500 tokens) always rank high, hurting precision
   - Optimal chunk size depends on embedding model

3. **Cost Optimization**:
   - Skip embedding API calls for unusable chunks
   - Reduce vector database storage for low-value chunks
   - Focus embedding budget on high-quality content

4. **Operational Flexibility**:
   - Can change thresholds without re-ingesting
   - Can re-embed with different filters
   - Can A/B test different chunking strategies

---

## Usage in Embedding Pipeline

### Example: OpenAI Embeddings

```typescript
import { shouldEmbed } from '@setu/docs-ingestion/embedding-helpers';
import OpenAI from 'openai';

const openai = new OpenAI();

async function embedChunks(chunks: DocumentChunk[]) {
  const results = {
    embedded: 0,
    skipped: 0,
    errors: 0
  };

  for (const chunk of chunks) {
    // Apply guardrail
    if (!shouldEmbed(chunk)) {
      console.log(`Skipping chunk: ${chunk.section} (${chunk.token_count} tokens)`);
      results.skipped++;
      continue;
    }

    try {
      // Generate embedding
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: chunk.content
      });

      // Store in vector DB
      await vectorDB.upsert({
        id: chunk.content_hash,
        values: response.data[0].embedding,
        metadata: {
          doc_path: chunk.doc_path,
          section_path: chunk.section_path,
          page_context: chunk.page_context,
          url: chunk.url,
          is_oversized: chunk.is_oversized
        }
      });

      results.embedded++;

      // Special handling for oversized chunks
      if (chunk.is_oversized) {
        console.warn(`Embedded oversized chunk: ${chunk.section} (${chunk.token_count} tokens)`);
      }
    } catch (error) {
      console.error(`Error embedding chunk ${chunk.content_hash}:`, error);
      results.errors++;
    }
  }

  return results;
}
```

### Example: Pinecone Upsert

```typescript
import { shouldEmbed, categorizeChunks } from '@setu/docs-ingestion/embedding-helpers';
import { Pinecone } from '@pinecone-database/pinecone';

async function upsertToPinecone(chunks: DocumentChunk[]) {
  const pinecone = new Pinecone();
  const index = pinecone.index('docs-index');

  // Analyze chunks first
  const analysis = categorizeChunks(chunks);
  console.log(`Will embed ${analysis.embeddable.length} chunks`);
  console.log(`Will skip ${analysis.tooSmall.length} too small`);
  console.log(`Will skip ${analysis.tooLarge.length} too large`);

  // Process only embeddable chunks
  const vectors = [];
  for (const chunk of analysis.embeddable) {
    const embedding = await generateEmbedding(chunk.content);

    vectors.push({
      id: chunk.content_hash,
      values: embedding,
      metadata: {
        doc_path: chunk.doc_path,
        section: chunk.section,
        section_path: chunk.section_path,
        page_context: chunk.page_context,
        url: chunk.url,
        token_count: chunk.token_count,
        is_oversized: chunk.is_oversized
      }
    });
  }

  // Batch upsert
  await index.upsert(vectors);

  return {
    embedded: vectors.length,
    skipped: chunks.length - vectors.length
  };
}
```

---

## Validation

### Check `is_oversized` Field

```bash
jq '.chunks[0] | {token_count, is_oversized}' output/chunks.json
# Output: {"token_count": 263, "is_oversized": false}

jq '.chunks[] | select(.is_oversized == true) | {section: .section[0:50], token_count}' output/chunks.json | head -10
# Shows oversized chunks
```

### Verify `shouldEmbed()` Logic

```bash
# Count embeddable chunks
jq '[.chunks[] | select(.token_count >= 80 and .token_count <= 1500)] | length' output/chunks.json
# Output: 2028

# Count too small
jq '[.chunks[] | select(.token_count < 80)] | length' output/chunks.json
# Output: 71

# Count too large
jq '[.chunks[] | select(.token_count > 1500)] | length' output/chunks.json
# Output: 59
```

---

## Summary

✅ **Added**:
- `shouldEmbed(chunk)` helper function
- `is_oversized` metadata flag
- Embedding readiness logging
- Clear separation of ingestion vs embedding concerns

✅ **Preserved**:
- All existing fields unchanged
- No content modification
- No chunking logic altered
- Complete ingestion output intact

✅ **Ready For**:
- OpenAI embeddings
- Pinecone/Weaviate/pgvector upsert
- A/B testing different thresholds
- Future embedding model changes
