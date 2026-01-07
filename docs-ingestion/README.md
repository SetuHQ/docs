# Documentation Ingestion Pipeline

A production-ready pipeline for converting a documentation repository into structured, semantically coherent chunks optimized for embedding and retrieval by a documentation copilot.

## Overview

This pipeline transforms markdown/MDX documentation into chunked, enriched data ready for vector embedding. It's designed to run in CI/CD, providing deterministic, incremental updates whenever documentation changes.

### Key Features

- **Structural Parsing**: MDX-aware parser that preserves code blocks and heading hierarchy
- **Intelligent Chunking**: Token-based splitting (500-700 tokens) with semantic boundaries
- **Incremental Updates**: Only re-processes changed files using content hashing
- **Rich Metadata**: Each chunk includes URLs, section paths, git info, and frontmatter
- **Production Ready**: Deterministic, safe to re-run, comprehensive error handling

### What This Pipeline Does NOT Do

- ❌ No LLM calls (purely deterministic processing)
- ❌ No embedding generation (that's a separate downstream step)
- ❌ No plain text processing (respects markdown structure)
- ❌ No character-based chunking (uses tokens and semantic boundaries)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Documentation Repository                  │
│                    (content/*.mdx files)                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Scanner    │  Discover .md/.mdx files
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Parser     │  Parse frontmatter + MDX AST
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Chunker    │  Split into 500-700 token chunks
                  └──────┬───────┘  (respecting boundaries)
                         │
                         ▼
                  ┌──────────────┐
                  │   Metadata   │  Enrich with URLs, hashes, git info
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ Deduplication│  Incremental update handling
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Output     │  JSON array of chunks
                  └──────────────┘
```

## Installation

```bash
cd docs-ingestion
npm install
npm run build
```

### Dependencies

- `gray-matter`: YAML frontmatter parsing
- `mdast-util-from-markdown`: Markdown AST parsing
- `mdast-util-mdx`: MDX/JSX component support
- `js-tiktoken`: Token counting (OpenAI tokenizer)
- `simple-git`: Git repository introspection

## Usage

### Basic Usage

```bash
# Run from docs repository root
npm run ingest

# Or specify custom paths
npm run ingest /path/to/content /path/to/output.json
```

### Programmatic Usage

```typescript
import { runIngestionPipeline, createDefaultConfig } from '@setu/docs-ingestion';

const config = createDefaultConfig(
  './content',              // Content directory
  './output/chunks.json'    // Output path
);

// Customize configuration
config.baseUrl = 'https://docs.setu.co';
config.chunking.targetChunkSize = 600;

// Run pipeline
const result = await runIngestionPipeline(config);

console.log(`Generated ${result.stats.totalChunks} chunks`);
```

## Module Deep Dive

### 1. Scanner Module (`scanner.ts`)

**Purpose**: Recursively discover all documentation files

**Logic**:
- Walks directory tree using async fs operations
- Filters by extension (`.md`, `.mdx`)
- Excludes directories (`.git`, `node_modules`, etc.)
- Returns sorted list of relative paths

**Why**:
- Fast traversal with configurable filtering
- Deterministic output (sorted)
- Portable paths (relative, not absolute)

### 2. Parser Module (`parser.ts`)

**Purpose**: Parse MDX into structured AST

**Logic**:
- Extracts YAML frontmatter using `gray-matter`
- Parses markdown/MDX using unified/remark
- Handles JSX components (extracts text content)
- Builds heading hierarchy tree

**Why**:
- Structural parsing preserves semantic meaning
- Heading hierarchy enables smart chunking
- JSX handling for MDX compatibility

**Example**:

```markdown
## Overview

### What is UPI Setu?

UPI Setu is a comprehensive...

```javascript
const example = "code";
```
```

Becomes:

```typescript
{
  heading: "Overview",
  level: 2,
  children: [
    {
      heading: "What is UPI Setu?",
      level: 3,
      content: "UPI Setu is a comprehensive...\n\n```javascript\nconst example = \"code\";\n```"
    }
  ]
}
```

### 3. Chunker Module (`chunker.ts`)

**Purpose**: Split content into semantically coherent chunks

**Logic**:
1. Start with section-level chunks (based on headings)
2. If section > 700 tokens, split at paragraph boundaries
3. If paragraph contains code block, keep it intact (never split)
4. Add 100-150 token overlap between chunks
5. Each chunk stays in 500-700 token range

**Why**:
- Token-based splitting (not characters) for accurate LLM consumption
- Heading boundaries maintain semantic coherence
- Code block preservation prevents broken examples
- Overlap provides context continuity

**Algorithm Visualization**:

```
Section (1200 tokens)
├── Paragraph 1 (300 tokens)    ─┐
├── Paragraph 2 (400 tokens)    ─┤─ Chunk 1 (700 tokens)
├── Paragraph 3 (200 tokens)    ─┘ (+ overlap from previous)
├── Code Block (250 tokens)     ─┐
└── Paragraph 4 (250 tokens)    ─┤─ Chunk 2 (625 tokens)
                                 ┘ (includes 125 token overlap)
```

### 4. Metadata Module (`metadata.ts`)

**Purpose**: Enrich chunks with metadata

**Logic**:
- Computes SHA256 hash of content (for deduplication)
- Generates public URLs from file paths
- Extracts git commit SHA and repo info
- Attaches frontmatter metadata

**Why**:
- `content_hash`: Enables incremental updates (detect changes)
- `url`: Links chunks to live documentation
- `commit_sha`: Traceability to exact source version
- `section`: Hierarchical context for better retrieval

**Metadata Format**:

```typescript
{
  content: "UPI Setu is a comprehensive...",
  doc_path: "content/payments/umap/overview.mdx",
  section: "Overview > What is UPI Setu?",
  url: "https://docs.setu.co/payments/umap/overview",
  content_hash: "a3f5d8e9c2b1f7a6d4e8...",
  source_repo: "SetuHQ/docs",
  commit_sha: "1b05cf8a7d2e3f4b5c6d...",
  token_count: 142,
  metadata: {
    page_title: "UPI Setu - Overview",
    sidebar_title: "Overview",
    order: 0
  }
}
```

### 5. Deduplication Module (`deduplication.ts`)

**Purpose**: Enable efficient incremental updates

**Logic**:
1. Load previous ingestion output
2. Compare git commit SHAs
3. For each chunk, compare `content_hash`
4. Skip processing if hash unchanged
5. Merge new + unchanged chunks

**Why**:
- Efficiency: Only re-process changed files
- Safety: Re-runs are idempotent
- Cost: Reduces embedding API calls downstream

**Incremental Update Flow**:

```
Previous Run: 486 chunks

Current Run:
├── 480 chunks unchanged ✓ (reuse from previous)
├── 4 chunks updated ↻ (content_hash changed)
└── 2 chunks new ➕ (new files)

Output: 486 chunks (merged)
```

## Chunking Strategy Rationale

### Why 500-700 Tokens?

- **Retrieval**: Embeddings work best on focused, coherent text
- **Context**: Large enough to include surrounding context
- **Cost**: Smaller chunks = more embeddings but higher precision

### Why Overlap?

- **Context**: Prevents losing information at boundaries
- **Recall**: Helps retrieve relevant chunks when query spans boundaries

### Why Respect Boundaries?

- **Code Blocks**: Splitting code mid-function breaks examples
- **Headings**: Sections are natural semantic units
- **Paragraphs**: Sentence-level splitting as last resort

## Output Format

The pipeline generates a JSON file with this structure:

```typescript
{
  chunks: DocumentChunk[],      // Array of enriched chunks
  stats: IngestionStats,         // Processing statistics
  gitInfo: GitInfo,              // Repository information
  timestamp: string              // ISO timestamp
}
```

See [`examples/example-output.json`](./examples/example-output.json) for a real example.

## Configuration

### Pipeline Config

```typescript
{
  scan: {
    rootDir: '/path/to/content',
    includeExtensions: ['.md', '.mdx'],
    excludeDirs: ['.git', 'node_modules', 'dist'],
    excludePatterns: [/\.DS_Store/, /^\./)
  },
  chunking: {
    targetChunkSize: 600,    // Target size in tokens
    minChunkSize: 500,       // Minimum size
    maxChunkSize: 700,       // Maximum size
    overlapSize: 125,        // Target overlap
    minOverlapSize: 100,     // Minimum overlap
    maxOverlapSize: 150      // Maximum overlap
  },
  baseUrl: 'https://docs.setu.co',
  outputPath: './output/chunks.json',
  previousOutputPath: './output/chunks.json'  // For incremental
}
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Ingest Documentation

on:
  push:
    branches: [main]
    paths:
      - 'content/**'

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Full git history

      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          cd docs-ingestion
          npm ci

      - name: Run ingestion
        run: |
          cd docs-ingestion
          npm run ingest ../content ./output/chunks.json

      - name: Upload chunks artifact
        uses: actions/upload-artifact@v3
        with:
          name: documentation-chunks
          path: docs-ingestion/output/chunks.json
```

## Testing

```bash
# Run tests
npm test

# Test on a single file
npm run dev -- ./content/payments/umap/overview.mdx
```

## Troubleshooting

### Issue: Code blocks are split

**Solution**: Check that code block regex in `chunker.ts` matches your syntax. Currently supports:

```
```language
code here
```
```

### Issue: Chunks too large/small

**Solution**: Adjust `ChunkingConfig`:

```typescript
config.chunking.targetChunkSize = 500;  // Smaller chunks
config.chunking.maxChunkSize = 600;
```

### Issue: Incremental updates not working

**Solution**: Ensure `previousOutputPath` points to the correct file and has write permissions.

### Issue: TypeScript errors about `console` or `process`

**Solution**: Install type definitions:

```bash
npm install --save-dev @types/node
```

## Performance

On a repository with ~120 MDX files:

- **First run**: ~12 seconds (all files)
- **Incremental run** (2 files changed): ~2 seconds
- **Memory usage**: ~150MB peak
- **Output size**: ~2MB JSON (486 chunks)

## Design Decisions

### Why Token-Based Chunking?

LLMs process text as tokens, not characters. Token-based chunking ensures:
- Accurate size estimation
- Predictable embedding costs
- Consistent retrieval performance

### Why Not Use LLMs for Summarization?

- **Determinism**: Same input must produce same output (CI/CD requirement)
- **Cost**: Running LLMs on every doc change is expensive
- **Speed**: Structural parsing is instant
- **Reliability**: No API dependencies or rate limits

### Why Content Hashing?

SHA256 hashing enables:
- Exact deduplication
- Change detection
- Cache invalidation
- Incremental updates

### Why Preserve Code Blocks?

Code examples are critical for technical docs. Splitting them:
- Breaks syntax highlighting
- Loses context
- Confuses embeddings
- Frustrates users

## Future Enhancements

Potential improvements (not implemented):

1. **Multi-language support**: Tokenizers for non-English docs
2. **Image OCR**: Extract text from diagrams
3. **Link validation**: Check broken links during ingestion
4. **Custom components**: Better handling of complex MDX components
5. **Parallel processing**: Multi-threaded file processing

## License

MIT

## Contributing

1. Keep modules focused and single-purpose
2. Add comprehensive comments explaining WHY, not just WHAT
3. Maintain deterministic behavior (no randomness)
4. Update tests for any algorithm changes

---

Built with ❤️ by the Setu team for powering intelligent documentation experiences.
