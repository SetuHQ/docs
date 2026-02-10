/**
 * Core types for the documentation ingestion pipeline
 */

/**
 * Represents a parsed markdown/mdx file
 */
export interface ParsedDocument {
  /** Relative path from repository root */
  filePath: string;
  /** YAML frontmatter metadata */
  frontmatter: DocumentFrontmatter;
  /** Parsed markdown AST */
  ast: any; // mdast Root node
  /** Raw content without frontmatter */
  content: string;
}

/**
 * Frontmatter metadata from MDX files
 */
export interface DocumentFrontmatter {
  sidebar_title?: string;
  page_title?: string;
  order?: number;
  visible_in_sidebar?: boolean;
  [key: string]: any;
}

/**
 * Represents a section in the document hierarchy
 */
export interface DocumentSection {
  /** Section heading text */
  heading: string;
  /** Heading level (1-6) */
  level: number;
  /** Content under this heading */
  content: string;
  /** Token count for this section */
  tokenCount: number;
  /** Start line number in original document */
  startLine: number;
  /** End line number in original document */
  endLine: number;
  /** Child sections */
  children: DocumentSection[];
}

/**
 * A chunk of documentation content
 * This is the final output format consumed by the copilot
 */
export interface DocumentChunk {
  /** The actual text content of the chunk */
  content: string;
  /** Relative path from repository root */
  doc_path: string;
  /** Full section path (e.g., "Overview > What is UPI Setu?") */
  section: string;
  /** Hierarchical section path as array (e.g., ["Overview", "What is UPI Setu?"]) */
  section_path: string[];
  /** Page context combining page title and sidebar title for better retrieval */
  page_context: string;
  /** Public URL where this content lives */
  url: string;
  /** SHA256 hash of content for deduplication */
  content_hash: string;
  /** Source repository identifier */
  source_repo: string;
  /** Git commit SHA when this was ingested */
  commit_sha: string;
  /** Token count for this chunk */
  token_count: number;
  /** Flag indicating if chunk exceeds recommended size (>1200 tokens) */
  is_oversized: boolean;
  /** Frontmatter metadata */
  metadata: {
    product?: string;
    category?: string;
    page_title?: string;
    sidebar_title?: string;
    order?: number;
    [key: string]: any;
  };
}

/**
 * Configuration for the chunking algorithm
 */
export interface ChunkingConfig {
  /** Target chunk size in tokens (default: 600) */
  targetChunkSize: number;
  /** Minimum chunk size in tokens (default: 500) */
  minChunkSize: number;
  /** Maximum chunk size in tokens (default: 700) */
  maxChunkSize: number;
  /** Overlap between chunks in tokens (default: 125) */
  overlapSize: number;
  /** Minimum overlap in tokens (default: 100) */
  minOverlapSize: number;
  /** Maximum overlap in tokens (default: 150) */
  maxOverlapSize: number;
}

/**
 * Configuration for file scanning
 */
export interface ScanConfig {
  /** Root directory to scan */
  rootDir: string;
  /** File extensions to include */
  includeExtensions: string[];
  /** Directories to exclude */
  excludeDirs: string[];
  /** File patterns to exclude */
  excludePatterns: RegExp[];
}

/**
 * Git repository information
 */
export interface GitInfo {
  /** Current commit SHA */
  commitSha: string;
  /** Repository remote URL */
  remoteUrl: string;
  /** Repository name */
  repoName: string;
  /** Current branch */
  branch: string;
}

/**
 * Pipeline configuration
 */
export interface PipelineConfig {
  /** Scanning configuration */
  scan: ScanConfig;
  /** Chunking configuration */
  chunking: ChunkingConfig;
  /** Base URL for generating public URLs */
  baseUrl: string;
  /** Path to previous ingestion output for incremental updates */
  previousOutputPath?: string;
  /** Path to save current ingestion output */
  outputPath: string;
}

/**
 * Ingestion statistics
 */
export interface IngestionStats {
  /** Total files scanned */
  totalFiles: number;
  /** Total files processed */
  processedFiles: number;
  /** Total files skipped (unchanged) */
  skippedFiles: number;
  /** Total chunks generated */
  totalChunks: number;
  /** New chunks added */
  newChunks: number;
  /** Chunks updated */
  updatedChunks: number;
  /** Chunks unchanged */
  unchangedChunks: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Result of the ingestion pipeline
 */
export interface IngestionResult {
  /** All generated chunks */
  chunks: DocumentChunk[];
  /** Ingestion statistics */
  stats: IngestionStats;
  /** Git information */
  gitInfo: GitInfo;
  /** Timestamp of ingestion */
  timestamp: string;
}
