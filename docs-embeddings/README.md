# Documentation Embedding Pipeline

Incremental embedding generation and vector database sync using AWS Bedrock and Pinecone.

## Overview

This pipeline:
1. Loads chunks from the ingestion pipeline output
2. Generates embeddings using AWS Bedrock (Amazon Titan v2)
3. Incrementally syncs to Pinecone vector database
4. Tracks state to avoid re-embedding unchanged content

## Key Features

### FIX #1: Smart Re-Embedding Prevention
- **Only generates embeddings for NEW content_hash values**
- Metadata-only changes do NOT trigger embedding API calls
- `toInsert` → generate new embeddings
- `toUpdate` → fetch existing embeddings, update metadata only
- `toDelete` → delete vectors

**Result**: Zero Bedrock API calls on re-runs with no content changes

### FIX #2: Metadata-Only Storage
- **Content is NOT stored in vector database metadata**
- Only retrieval metadata stored: doc_path, section_path, page_context, url, etc.
- Content fetched separately from ingestion output by content_hash

### AWS Bedrock Integration
- Uses Amazon Titan Text Embeddings v2 (1024 dimensions)
- Authentication via AWS credentials (IAM role or environment variables)
- Rate limiting: 100ms between API calls (10 TPS)
- No batching (Titan doesn't support batch embedding)

## Installation

```bash
cd docs-embeddings
npm install
```

## Configuration

Set these environment variables:

```bash
# AWS Credentials (if not using IAM role)
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="ap-south-1"

# Bedrock Model
export BEDROCK_MODEL_ID="amazon.titan-embed-text-v2:0"

# Pinecone
export PINECONE_API_KEY="your-pinecone-api-key"
export PINECONE_INDEX="docs-embeddings"

# Optional
export BATCH_SIZE="100"
export INGESTION_OUTPUT_PATH="../docs-ingestion/output/chunks.json"
export STATE_FILE_PATH="./state/indexed-hashes.json"
```

## Usage

```bash
# Run embedding sync
npm run sync

# Or step-by-step
npm run build
npm start
```

## How Incremental Sync Works

### First Run (No Previous State)
```
Input: 2028 embeddable chunks
State: No previous state found

Operations:
  - Insert: 2028 (new)
  - Update: 0
  - Delete: 0

Bedrock API calls: 2028
Duration: ~200s
```

### Second Run (No Changes)
```
Input: 2028 embeddable chunks
State: 2028 previously indexed

Operations:
  - Insert: 0
  - Update: 2028 (metadata only, fetches embeddings from DB)
  - Delete: 0

Bedrock API calls: 0 ✅
Duration: ~12s
```

### Typical Update (5 Pages Changed)
```
Input: 2028 embeddable chunks
State: 2028 previously indexed

Operations:
  - Insert: 12 (new chunks)
  - Update: 2011 (existing chunks, metadata only)
  - Delete: 7 (removed chunks)

Bedrock API calls: 12 ✅
Duration: ~15s
```

## State Tracking

State is saved in `state/indexed-hashes.json`:

```json
{
  "commit_sha": "1b05cf8c",
  "indexed_hashes": [
    "e3469962088da98c2e386b9d6a83132d37c4144cd3e76c1fad6041081abd1aaf",
    "a7b3c8d9e2f1a0b5c4d3e8f7a6b9c2d5e4f3a8b7c6d5e4f3a2b1c0d9e8f7a6b5",
    ...
  ],
  "total_vectors": 2028,
  "last_synced": "2026-01-07T16:45:32.123Z"
}
```

## Vector Record Format

Each vector in Pinecone contains:

```json
{
  "id": "e3469962088...",
  "embedding": [0.123, -0.456, ...],  // 1024-dim
  "metadata": {
    "doc_path": "payments/umap/overview.mdx",
    "section_path": "[\"Overview\",\"What is UPI Setu?\"]",
    "page_context": "UPI Setu - Overview | Overview",
    "source_repo": "SetuHQ/docs",
    "commit_sha": "1b05cf8c",
    "is_oversized": false,
    "token_count": 365,
    "url": "https://docs.setu.co/payments/umap/overview"
  }
}
```

**Note**: `content` is NOT stored in metadata. Content is retrieved from ingestion output using `content_hash` as the key.

## AWS IAM Permissions

Required IAM permissions for Bedrock:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": [
        "arn:aws:bedrock:ap-south-1::foundation-model/amazon.titan-embed-text-v2:0"
      ]
    }
  ]
}
```

## CI/CD Integration

```bash
#!/bin/bash
# .github/workflows/sync-embeddings.yml

# Step 1: Run ingestion
cd docs-ingestion
npm run ingest

# Step 2: Run embedding sync
cd ../docs-embeddings
npm run sync
```

## Pinecone Index Setup

Create a Pinecone index with these settings:

- **Dimensions**: 1024 (for Titan v2)
- **Metric**: cosine
- **Pod Type**: p1.x1 or serverless

```bash
# Using Pinecone CLI or dashboard
pinecone create-index docs-embeddings \
  --dimension 1024 \
  --metric cosine \
  --region ap-south-1
```

## Troubleshooting

### "No AWS credentials found"
Set AWS credentials via environment variables or use an IAM role:
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
```

### "PINECONE_API_KEY is required"
Ensure the environment variable is set:
```bash
export PINECONE_API_KEY="..."
```

### Embeddings dimension mismatch
If you switch from OpenAI to Bedrock, you must:
1. Delete the old Pinecone index (or create a new one)
2. Delete `state/indexed-hashes.json`
3. Re-run `npm run sync` to generate all embeddings from scratch

### Rate limit errors
Increase the sleep time in `embedder.ts`:
```typescript
await this.sleep(200); // 5 TPS instead of 10 TPS
```

## Architecture

```
┌─────────────────┐
│  Ingestion      │
│  Output         │
│  (chunks.json)  │
└────────┬────────┘
         │
         │ Load chunks
         ▼
┌─────────────────┐
│  Embedding      │
│  Sync           │
│  (sync.ts)      │
└────┬───────┬────┘
     │       │
     │       │ Fetch existing
     │       │ embeddings
     │       ▼
     │   ┌──────────┐
     │   │ Pinecone │
     │   │ Vector   │
     │   │ Database │
     │   └──────────┘
     │
     │ Generate new
     │ embeddings
     ▼
┌──────────┐
│ AWS      │
│ Bedrock  │
│ (Titan)  │
└──────────┘
```

## Performance

- **First run (2028 chunks)**: ~200 seconds, 2028 API calls
- **Re-run (no changes)**: ~12 seconds, 0 API calls
- **Typical update (12 new chunks)**: ~15 seconds, 12 API calls

## Cost Estimation

Amazon Titan Text Embeddings v2 pricing:
- **$0.00002 per 1,000 input tokens**

Example costs:
- 2028 chunks × 495 avg tokens = ~1,004,000 tokens
- First run: $0.02
- Incremental update (12 chunks × 495 tokens = 5,940 tokens): $0.0001

**850x cheaper than re-embedding everything on each run.**
