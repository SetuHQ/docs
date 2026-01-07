# Example: Input → Output Transformation

This document shows how the pipeline transforms a markdown file into chunked output.

## Input File

**File**: `example-input.mdx` (Account Aggregator Quickstart)

**Structure**:
- Frontmatter with metadata
- Multiple heading levels (##, ###)
- Paragraphs and lists
- Multiple code blocks (bash, javascript)
- JSX components (`<NextPage>`)

## Processing Steps

### Step 1: Scanner

**Input**: Repository directory
**Output**: List of files

```
Discovered files:
- content/data/account-aggregator/quickstart.mdx
- content/data/account-aggregator/overview.mdx
- ...
```

### Step 2: Parser

**Input**: Raw MDX file
**Output**: Structured document

```typescript
{
  filePath: "content/data/account-aggregator/quickstart.mdx",
  frontmatter: {
    sidebar_title: "Quickstart",
    page_title: "Account Aggregator - Quickstart Guide",
    order: 1,
    visible_in_sidebar: true
  },
  sections: [
    {
      heading: "Getting Started",
      level: 2,
      content: "...",
      children: [
        {
          heading: "Prerequisites",
          level: 3,
          content: "Before integrating...",
          children: []
        },
        {
          heading: "Installation",
          level: 3,
          content: "Install the Setu AA SDK...\n\n```bash\nnpm install...\n```",
          children: []
        },
        ...
      ]
    },
    ...
  ]
}
```

### Step 3: Chunker

**Input**: Sections with hierarchy
**Output**: Token-sized chunks with overlap

**Chunk 1** (542 tokens):
```
Section: "Getting Started > Prerequisites"
Content: "Before integrating with the Account Aggregator framework..."
Token count: 542
```

**Chunk 2** (687 tokens):
```
Section: "Getting Started > Installation"
Content: "Install the Setu AA SDK using npm:

```bash
npm install @setu/account-aggregator
```

Or using yarn:

```bash
yarn add @setu/account-aggregator
```
"
Token count: 687
Overlap: Last 125 tokens from Chunk 1
```

**Chunk 3** (623 tokens):
```
Section: "Getting Started > Authentication"
Content: "Initialize the SDK with your credentials:

```javascript
const { SetuAA } = require('@setu/account-aggregator');
...
```

**Important**: Never commit your credentials..."
Token count: 623
Overlap: Last 125 tokens from Chunk 2
```

### Step 4: Metadata Enrichment

**Input**: Text chunks
**Output**: Enriched document chunks

```json
{
  "content": "Before integrating with the Account Aggregator framework, ensure you have:\n\n- A registered FIU (Financial Information User) license from RBI\n- API credentials from Setu\n- A valid webhook endpoint for receiving consent notifications",
  "doc_path": "content/data/account-aggregator/quickstart.mdx",
  "section": "Getting Started > Prerequisites",
  "url": "https://docs.setu.co/data/account-aggregator/quickstart",
  "content_hash": "e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7",
  "source_repo": "SetuHQ/docs",
  "commit_sha": "1b05cf8a7d2e3f4b5c6d7e8f9a0b1c2d3e4f5a6b",
  "token_count": 542,
  "metadata": {
    "page_title": "Account Aggregator - Quickstart Guide",
    "sidebar_title": "Quickstart",
    "order": 1,
    "visible_in_sidebar": true
  }
}
```

## Key Observations

### Code Block Preservation

Notice how each code block stays intact within a chunk:

**Input**:
```bash
npm install @setu/account-aggregator
```

**Output**: Preserved in Chunk 2 without splitting

### Heading Hierarchy in Section Paths

- "Getting Started > Prerequisites"
- "Getting Started > Installation"
- "Creating a Consent Request > Step 1: Define Data Requirements"

This creates a breadcrumb trail showing context.

### Overlap Between Chunks

**Chunk 2 ends with**:
```
"Or using yarn:

```bash
yarn add @setu/account-aggregator
```"
```

**Chunk 3 starts with** (overlap included):
```
"```bash
yarn add @setu/account-aggregator
```

Initialize the SDK with your credentials..."
```

This overlap ensures context continuity.

### JSX Component Handling

The `<NextPage>` component is processed:

**Input**:
```jsx
<NextPage
  info={{
    description: "Learn about consent object structure",
    slug: "/data/account-aggregator/consent-object",
    title: "Consent Object"
  }}
/>
```

**Output**: Text content extracted
```
"Learn about consent object structure"
```

## Statistics

For this single file:

- **Total sections**: 12
- **Total chunks**: 8
- **Average chunk size**: 598 tokens
- **Minimum chunk**: 487 tokens
- **Maximum chunk**: 693 tokens
- **Code blocks**: 9 (all preserved intact)

## Usage in Copilot

When a user asks: *"How do I authenticate with the Account Aggregator SDK?"*

**Retrieval**:
1. Embed user query
2. Find similar chunks via vector search
3. Return Chunk 3 (Authentication section)

**Response**:
```
To authenticate with the Account Aggregator SDK, initialize the client with your credentials:

```javascript
const { SetuAA } = require('@setu/account-aggregator');

const client = new SetuAA({
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  mode: 'sandbox'
});
```

**Important**: Never commit your credentials. Use environment variables instead.

[Read more](https://docs.setu.co/data/account-aggregator/quickstart)
```

## Benefits

1. **Precise Retrieval**: Chunks are focused on specific topics
2. **Complete Code Examples**: No broken code snippets
3. **Contextual Paths**: Section hierarchy provides context
4. **Source Links**: Direct links to full documentation
5. **Traceable**: Content hash links to exact version
