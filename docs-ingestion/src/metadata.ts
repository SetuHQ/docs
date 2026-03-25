/**
 * Metadata Extraction Module
 *
 * Enriches chunks with metadata required for retrieval:
 * - Git information (commit SHA, repo name)
 * - Public URLs
 * - Content hashing for deduplication
 * - Frontmatter data
 *
 * Design principles:
 * - Deterministic hashing (same content = same hash)
 * - Traceable to source (git commit + file path)
 * - URL generation from file paths
 */

import * as crypto from "crypto";
import simpleGit from "simple-git";
import type { TextChunk } from "./chunker.js";
import { cleanChunkContent } from "./text-cleaner.js";
import type { DocumentChunk, DocumentFrontmatter, GitInfo } from "./types.js";

/**
 * Gets Git repository information
 *
 * @param repoPath - Path to the git repository
 * @returns Git information including commit SHA and remote URL
 */
export async function getGitInfo(repoPath: string): Promise<GitInfo> {
  try {
    const git = simpleGit(repoPath);

    // Check if it's a git repository
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`${repoPath} is not a git repository`);
    }

    // Get current commit SHA
    const log = await git.log({ maxCount: 1 });
    const commitSha = log.latest?.hash || "unknown";

    // Get remote URL
    const remotes = await git.getRemotes(true);
    const originRemote = remotes.find((r) => r.name === "origin");
    const remoteUrl = originRemote?.refs?.fetch || "";

    // Extract repo name from remote URL
    const repoName = extractRepoName(remoteUrl);

    // Get current branch
    const branch = await git.revparse(["--abbrev-ref", "HEAD"]);

    return {
      commitSha,
      remoteUrl,
      repoName,
      branch: branch.trim(),
    };
  } catch (error: any) {
    console.warn("Git info unavailable, using defaults:", error.message);
    return {
      commitSha: "unknown",
      remoteUrl: "",
      repoName: "unknown",
      branch: "unknown",
    };
  }
}

/**
 * Extracts repository name from git remote URL
 *
 * Examples:
 * - https://github.com/SetuHQ/docs.git -> SetuHQ/docs
 * - git@github.com:SetuHQ/docs.git -> SetuHQ/docs
 */
function extractRepoName(remoteUrl: string): string {
  if (!remoteUrl) return "unknown";

  // Remove .git suffix
  let url = remoteUrl.replace(/\.git$/, "");

  // Handle SSH URLs (git@github.com:owner/repo)
  if (url.startsWith("git@")) {
    const match = url.match(/git@[^:]+:(.+)/);
    return match ? match[1] : "unknown";
  }

  // Handle HTTPS URLs (https://github.com/owner/repo)
  if (url.startsWith("http")) {
    const match = url.match(/\/([^\/]+\/[^\/]+)$/);
    return match ? match[1] : "unknown";
  }

  return "unknown";
}

/**
 * Generates a public URL from a file path
 *
 * Converts file paths to docs.setu.co URLs based on conventions:
 * - content/payments/umap/overview.mdx -> https://docs.setu.co/payments/umap/overview
 * - content/data/account-aggregator/quickstart.mdx -> https://docs.setu.co/data/account-aggregator/quickstart
 *
 * @param filePath - Relative file path
 * @param baseUrl - Base URL (e.g., https://docs.setu.co)
 * @returns Public URL
 */
export function generatePublicUrl(filePath: string, baseUrl: string): string {
  // Remove 'content/' prefix if present
  let urlPath = filePath.replace(/^content\//, "");

  // Remove file extension
  urlPath = urlPath.replace(/\.(md|mdx)$/, "");

  // Ensure baseUrl doesn't end with /
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");

  return `${cleanBaseUrl}/${urlPath}`;
}

/**
 * Computes SHA256 hash of content
 *
 * Used for deduplication and change detection.
 * Same content will always produce the same hash.
 *
 * @param content - Text content to hash
 * @returns Hex-encoded SHA256 hash
 */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Extracts the product name from a doc_path.
 *
 * Content paths:  "payments/umap/overview.mdx"           → "umap"
 *                 "data/account-aggregator/v1/intro.mdx"  → "account-aggregator"
 * API-ref paths:  "api-reference/data/account-aggregator.get-token.md" → "account-aggregator"
 *                 "api-reference/data/bav/penny-drop.md"               → "bav"
 * Fallback:       "README.md"                             → "general"
 */
export function extractProduct(docPath: string): string {
  const segments = docPath.split("/").filter(Boolean);

  // API-reference paths: api-reference/{category}/{product-or-file}
  if (segments[0] === "api-reference" && segments.length >= 3) {
    // If there's a subdirectory under the category, that's the product
    // e.g. api-reference/data/bav/penny-drop.md → "bav"
    if (segments.length >= 4) {
      return segments[2];
    }
    // Otherwise product is the filename prefix before the first dot
    // e.g. api-reference/data/account-aggregator.get-token.md → "account-aggregator"
    const filename = segments[2];
    const dotIndex = filename.indexOf(".");
    if (dotIndex > 0) {
      return filename.substring(0, dotIndex);
    }
    return filename.replace(/\.(md|mdx)$/, "");
  }

  // Content paths: {category}/{product}/...
  if (segments.length >= 2) {
    return segments[1];
  }

  return "general";
}

/**
 * Extracts the top-level category from a doc_path.
 *
 * "payments/umap/overview.mdx"                         → "payments"
 * "data/account-aggregator/v1/intro.mdx"               → "data"
 * "api-reference/payments/umap.create-link.md"          → "payments"
 * "dev-tools/bridge/quickstart.mdx"                     → "dev-tools"
 * "README.md"                                           → "general"
 */
export function extractCategory(docPath: string): string {
  const segments = docPath.split("/").filter(Boolean);

  // API-reference paths: api-reference/{category}/...
  if (segments[0] === "api-reference" && segments.length >= 2) {
    return segments[1];
  }

  // Content paths: {category}/...
  const knownCategories = ["payments", "data", "dev-tools"];
  if (segments.length >= 1 && knownCategories.includes(segments[0])) {
    return segments[0];
  }

  return "general";
}

/**
 * Creates a DocumentChunk from a TextChunk with metadata
 *
 * @param textChunk - Chunk from the chunker
 * @param filePath - Relative file path
 * @param frontmatter - Document frontmatter
 * @param gitInfo - Git repository information
 * @param baseUrl - Base URL for public links
 * @returns Complete DocumentChunk with all metadata
 */
export function enrichChunk(
  textChunk: TextChunk,
  filePath: string,
  frontmatter: DocumentFrontmatter,
  gitInfo: GitInfo,
  baseUrl: string,
): DocumentChunk {
  // Clean chunk content (remove duplicates, normalize whitespace)
  const cleanedContent = cleanChunkContent(textChunk.content);

  // Generate page context for better retrieval
  const pageContext = generatePageContext(frontmatter);

  // Note: We keep the original token count from the chunker
  // The text cleaner may reduce actual tokens, but we maintain
  // consistency with the chunking algorithm's measurements

  // Flag oversized chunks for embedding pipeline awareness
  const isOversized = textChunk.tokenCount > 1200;

  return {
    content: cleanedContent,
    doc_path: filePath,
    section: textChunk.sectionPath,
    section_path: textChunk.sectionPathArray,
    page_context: pageContext,
    url: generatePublicUrl(filePath, baseUrl),
    content_hash: hashContent(cleanedContent),
    source_repo: gitInfo.repoName,
    commit_sha: gitInfo.commitSha,
    token_count: textChunk.tokenCount,
    is_oversized: isOversized,
    metadata: {
      product: extractProduct(filePath),
      category: extractCategory(filePath),
      page_title: frontmatter.page_title,
      sidebar_title: frontmatter.sidebar_title,
      order: frontmatter.order,
      ...frontmatter,
    },
  };
}

/**
 * Generates page context string from frontmatter
 *
 * Combines page_title and sidebar_title to provide context for retrieval.
 * Helps the LLM understand which page/product a chunk belongs to.
 *
 * @param frontmatter - Document frontmatter
 * @returns Page context string
 */
function generatePageContext(frontmatter: DocumentFrontmatter): string {
  const parts: string[] = [];

  if (frontmatter.page_title) {
    parts.push(frontmatter.page_title);
  }

  if (
    frontmatter.sidebar_title &&
    frontmatter.sidebar_title !== frontmatter.page_title
  ) {
    parts.push(frontmatter.sidebar_title);
  }

  return parts.length > 0 ? parts.join(" | ") : "Documentation";
}

/**
 * Validates a DocumentChunk has all required fields
 */
export function validateChunk(chunk: DocumentChunk): void {
  const requiredFields = [
    "content",
    "doc_path",
    "section",
    "url",
    "content_hash",
    "source_repo",
    "commit_sha",
  ];

  for (const field of requiredFields) {
    if (
      !(field in chunk) ||
      chunk[field as keyof DocumentChunk] === undefined
    ) {
      throw new Error(`Chunk is missing required field: ${field}`);
    }
  }

  if (chunk.content.trim().length === 0) {
    throw new Error("Chunk content cannot be empty");
  }

  if (chunk.content_hash.length !== 64) {
    throw new Error("Invalid content_hash (should be SHA256)");
  }
}

/**
 * Compares two chunks to determine if content has changed
 *
 * @param chunk1 - First chunk
 * @param chunk2 - Second chunk
 * @returns true if chunks have the same content
 */
export function chunksAreEqual(
  chunk1: DocumentChunk,
  chunk2: DocumentChunk,
): boolean {
  return (
    chunk1.content_hash === chunk2.content_hash &&
    chunk1.doc_path === chunk2.doc_path &&
    chunk1.section === chunk2.section
  );
}

/**
 * Creates a chunk identifier for deduplication
 *
 * Uses doc_path + section as a stable identifier
 */
export function getChunkId(chunk: DocumentChunk): string {
  return `${chunk.doc_path}::${chunk.section}`;
}
