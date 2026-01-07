/**
 * File Scanner Module
 *
 * Recursively traverses the documentation directory and discovers
 * all markdown/mdx files while respecting exclusion rules.
 *
 * Design principles:
 * - Fast traversal using async file system operations
 * - Configurable include/exclude patterns
 * - Returns relative paths for portability
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ScanConfig } from './types.js';

/**
 * Scans a directory tree for documentation files
 *
 * @param config - Scanning configuration
 * @returns Array of relative file paths
 *
 * Example:
 * ```ts
 * const files = await scanDocumentationFiles({
 *   rootDir: '/path/to/docs/content',
 *   includeExtensions: ['.md', '.mdx'],
 *   excludeDirs: ['.git', 'node_modules'],
 *   excludePatterns: [/\.DS_Store/]
 * });
 * // Returns: ['payments/umap/overview.mdx', 'data/aa/quickstart.mdx', ...]
 * ```
 */
export async function scanDocumentationFiles(
  config: ScanConfig
): Promise<string[]> {
  const foundFiles: string[] = [];

  /**
   * Recursively walk directory tree
   */
  async function walk(dir: string): Promise<void> {
    let entries;

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      console.warn(`Warning: Cannot read directory ${dir}:`, error);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(config.rootDir, fullPath);

      // Skip excluded directories
      if (entry.isDirectory()) {
        if (shouldExcludeDirectory(entry.name, config.excludeDirs)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      // Skip excluded files
      if (shouldExcludeFile(relativePath, config.excludePatterns)) {
        continue;
      }

      // Include only files with specified extensions
      if (hasValidExtension(entry.name, config.includeExtensions)) {
        foundFiles.push(relativePath);
      }
    }
  }

  await walk(config.rootDir);

  // Sort for deterministic output
  return foundFiles.sort();
}

/**
 * Checks if a directory should be excluded
 */
function shouldExcludeDirectory(
  dirName: string,
  excludeDirs: string[]
): boolean {
  return excludeDirs.includes(dirName);
}

/**
 * Checks if a file should be excluded based on patterns
 */
function shouldExcludeFile(
  relativePath: string,
  excludePatterns: RegExp[]
): boolean {
  return excludePatterns.some(pattern => pattern.test(relativePath));
}

/**
 * Checks if a file has a valid extension
 */
function hasValidExtension(
  fileName: string,
  validExtensions: string[]
): boolean {
  const ext = path.extname(fileName);
  return validExtensions.includes(ext);
}

/**
 * Creates a default scan configuration
 */
export function createDefaultScanConfig(rootDir: string): ScanConfig {
  return {
    rootDir,
    includeExtensions: ['.md', '.mdx'],
    excludeDirs: [
      '.git',
      'node_modules',
      'dist',
      'build',
      '.next',
      'coverage',
      '.cache'
    ],
    excludePatterns: [
      /\.DS_Store$/,
      /Thumbs\.db$/,
      /\.gitkeep$/,
      /^\./ // Hidden files
    ]
  };
}

/**
 * Validates that a scan configuration is correct
 */
export function validateScanConfig(config: ScanConfig): void {
  if (!config.rootDir) {
    throw new Error('rootDir is required');
  }

  if (!config.includeExtensions || config.includeExtensions.length === 0) {
    throw new Error('includeExtensions must contain at least one extension');
  }

  // Validate extensions start with a dot
  for (const ext of config.includeExtensions) {
    if (!ext.startsWith('.')) {
      throw new Error(`Extension must start with a dot: ${ext}`);
    }
  }
}

/**
 * Gets file statistics for a given path
 */
export async function getFileStats(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    throw new Error(`Cannot access file ${filePath}: ${error}`);
  }
}
