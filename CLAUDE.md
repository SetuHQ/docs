# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Monorepo for [Setu docs](https://docs.setu.co) containing documentation content (MDX), API reference specs (OpenAPI), and two TypeScript pipelines that convert them into vector embeddings for a RAG-powered documentation copilot.

## Build & Test Commands

### docs-ingestion (primary pipeline)

```bash
cd docs-ingestion
npm ci                          # Install dependencies
npm run build                   # TypeScript compilation
npm test                        # Jest tests (ESM mode, requires --experimental-vm-modules)
npm run ingest                  # Build + run full ingestion pipeline
npm run normalize-api-specs     # Normalize OpenAPI specs → .api-reference-normalized/
npm run normalize-mdx           # Normalize MDX → .docs-normalized/
npm run check-token-limits      # Validate token limits on normalized output
npm run smoke-test-ingestion    # End-to-end smoke test
npm run dev                     # Run via tsx without build step
npm run upload-content          # Upload chunks to S3
```

Running a single test file:
```bash
cd docs-ingestion
node --experimental-vm-modules node_modules/jest/bin/jest.js src/normalize-mdx.test.ts
```

### docs-embeddings

```bash
cd docs-embeddings
npm ci && npm run build
npm run sync                    # Build + run incremental embedding sync
npm run dry-run                 # Validate without external API calls
npm run embed-all               # Full re-embedding
npm run verify-embed            # Verification script
```

## Architecture

### Data Flow

```
content/*.mdx + api-references/*.json
        │                    │
        ▼                    ▼
  normalize-mdx      normalize-api-specs
        │                    │
        ▼                    ▼
  .docs-normalized/   .api-reference-normalized/
        └────────┬───────────┘
                 ▼
     docs-ingestion pipeline
     (scan → parse → chunk → metadata → deduplicate)
                 │
                 ▼
         output/chunks.json
                 │
                 ▼
     docs-embeddings pipeline
     (filter → embed via Bedrock → upsert Pinecone + upload S3)
```

### Three-Layer RAG Architecture

1. **Pinecone** — embeddings + metadata references (NO content stored)
2. **S3** — actual chunk content keyed by `content_hash`
3. **Claude** — retrieval + answer generation

### docs-ingestion/src/ Key Modules

- `index.ts` — Pipeline orchestrator, handles both MDX and API spec ingestion
- `scanner.ts` — Recursive `.md`/`.mdx` file discovery
- `parser.ts` — MDX frontmatter extraction + markdown AST parsing
- `chunker.ts` — Token-based splitting (500-700 tokens) respecting semantic boundaries; never splits code blocks
- `metadata.ts` — Enriches chunks with SHA256 hashes, URLs, git info, product/category
- `deduplication.ts` — Incremental updates via content hash comparison
- `text-cleaner.ts` — Deduplicates paragraphs/sentences, normalizes whitespace
- `embedding-helpers.ts` — Filters chunks by embeddability (80-1500 tokens)
- `normalize-mdx.ts` — Strips JSX/HTML from MDX, produces clean markdown
- `normalize-api-specs.ts` — Converts OpenAPI 3.x/Swagger 2.0 specs to markdown with RAG metadata
- `types.ts` — Core interfaces: `DocumentChunk`, `PipelineConfig`, `ChunkingConfig`

### docs-embeddings/src/ Key Modules

- `sync.ts` — Incremental sync: only embeds NEW content_hash values, fetches existing embeddings for metadata-only updates
- `embedder.ts` — AWS Bedrock client (Amazon Titan Text Embeddings v2, 1024-dim)
- `vector-db.ts` — Pinecone client (upsert, fetch, delete, list)
- `content-uploader.ts` — S3 upload by content_hash

## Content Structure

- Content lives in `content/{category}/{product}/` — categories: `payments`, `data`, `dev-tools`
- API specs in `api-references/{category}/` (JSON/YAML OpenAPI files)
- `endpoints.json` — Product catalog (categories, products, versions, visibility)
- `menuItems.json` — Auto-generated sidebar structure (**do not edit manually**)
- `redirects.json` — URL redirect mappings

### Versioning

Default version content lives in product root folder. Older versions go in versioned subfolders (e.g., `account-aggregator/v1/`). Versions configured in `endpoints.json` via `versions` and `default_version` fields.

### MDX Frontmatter

Every MDX file requires:
```yaml
---
sidebar_title: Page Title
page_title: Full Page Title — Setu Docs
order: 0
visible_in_sidebar: true
---
```

### Assets

Stored in S3 bucket `docs-mdx-assets`. URL format: `https://docs-assets.setu.co/latest/{path}`. Path mirrors content folder structure.

## Key Constants

| Constant | Value | Location |
|---|---|---|
| Target chunk size | 600 tokens | chunker.ts |
| Min/Max chunk | 500/700 tokens | chunker.ts |
| Hard max chunk | 900 tokens | chunker.ts |
| Min embeddable | 80 tokens | embedding-helpers.ts |
| Max embeddable | 1500 tokens | embedding-helpers.ts |
| Overlap | 100-150 tokens | chunker.ts |
| Embedding dimensions | 1024 | embedder.ts (Titan v2) |

## CI Pipeline

`.github/workflows/docs-ingestion-ci.yml` runs on PRs to main/staging:
1. Build & test (TypeScript compile + Jest)
2. API spec normalization (determinism check — runs twice and diffs output)
3. Token limit compliance check
4. Ingestion smoke test
5. Embedding dry-run (validates without external API calls)

## Design Constraints

- **Deterministic**: Ingestion pipeline produces identical output for identical input (no randomness, no LLM calls)
- **Incremental**: Both pipelines use content hashing to skip unchanged content
- **Code blocks are never split** by the chunker
- **Content separation**: Pinecone stores only embeddings + metadata; actual content lives in S3
- Both pipelines are ES Modules (`"type": "module"` in package.json)
- Generated directories `.docs-normalized/` and `.api-reference-normalized/` are gitignored build artifacts
