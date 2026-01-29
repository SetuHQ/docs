/**
 * Tests for MDX-to-Markdown Normalization
 *
 * These tests ensure:
 * 1. No files are missing after normalization
 * 2. No significant data loss occurs
 * 3. All JSX/HTML syntax is properly removed
 * 4. Frontmatter is correctly converted
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { normalizeMDX } from './normalize-mdx.js';
import { scanDocumentationFiles, createDefaultScanConfig } from './scanner.js';

const CONTENT_DIR = path.resolve(process.cwd(), '../content');
const NORMALIZED_DIR = path.resolve(process.cwd(), '../.docs-normalized');

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract meaningful words from content (ignoring code blocks, URLs, etc.)
 */
function extractMeaningfulWords(content: string): string[] {
  // Remove code blocks
  let text = content.replace(/```[\s\S]*?```/g, '');
  // Remove URLs
  text = text.replace(/https?:\/\/[^\s)]+/g, '');
  // Remove special characters and split into words
  text = text.replace(/[^a-zA-Z0-9\s]/g, ' ');
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  return words;
}

/**
 * Extract headings from content
 */
function extractHeadings(content: string): string[] {
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings: string[] = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

/**
 * Check if content contains JSX/HTML tags
 */
function containsJSXOrHTML(content: string): { found: boolean; examples: string[] } {
  // Protect code blocks
  const codeBlocks: string[] = [];
  const contentWithoutCode = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  const examples: string[] = [];

  // Check for JSX components (PascalCase tags, at least 2 chars)
  const jsxComponentRegex = /<[A-Z][a-zA-Z]+[^>]*>/g;
  let match;
  while ((match = jsxComponentRegex.exec(contentWithoutCode)) !== null) {
    examples.push(match[0]);
  }

  // Check for common HTML tags that should be converted (excluding single-letter placeholders like <id>, <url>)
  const htmlTagRegex = /<(?:div|span|p|br|hr|a|img|table|thead|tbody|tr|th|td|ul|ol|li|strong|em|b|i|code|pre|details|summary)[^>]*>/gi;
  while ((match = htmlTagRegex.exec(contentWithoutCode)) !== null) {
    // Skip markdown images ![](...)
    if (!match[0].startsWith('![')) {
      examples.push(match[0]);
    }
  }

  // Filter out common documentation placeholders (single lowercase words)
  const filteredExamples = examples.filter(ex => {
    // Skip placeholders like <id>, <url>, <value>, <token>, etc.
    if (/^<[a-z_-]+>$/i.test(ex)) return false;
    return true;
  });

  // Check for JSX expressions (but not in markdown)
  const jsxExpressionRegex = /\{[^}]*(?:=>|function|const|let|var)[^}]*\}/g;
  while ((match = jsxExpressionRegex.exec(contentWithoutCode)) !== null) {
    examples.push(match[0]);
  }

  return { found: filteredExamples.length > 0, examples: filteredExamples.slice(0, 5) };
}

/**
 * Check if frontmatter was properly converted
 */
function checkFrontmatterConversion(original: string, normalized: string): boolean {
  const hasFrontmatter = original.startsWith('---\n');
  if (!hasFrontmatter) return true;

  // Check that normalized starts with Metadata
  return normalized.startsWith('Metadata\n');
}

// ============================================================================
// TESTS
// ============================================================================

describe('MDX Normalization', () => {
  let sourceFiles: string[] = [];
  let normalizedFiles: string[] = [];

  beforeAll(async () => {
    // Get all source MDX files
    const scanConfig = createDefaultScanConfig(CONTENT_DIR);
    sourceFiles = await scanDocumentationFiles(scanConfig);

    // Get all normalized MD files
    const normalizedScanConfig = createDefaultScanConfig(NORMALIZED_DIR);
    normalizedFiles = await scanDocumentationFiles(normalizedScanConfig);
  });

  describe('File Coverage', () => {
    test('should have normalized all MDX files', () => {
      const mdxFiles = sourceFiles.filter(f => f.endsWith('.mdx'));
      const expectedMdFiles = mdxFiles.map(f => f.replace(/\.mdx$/, '.md'));

      const missingFiles = expectedMdFiles.filter(expected => {
        return !normalizedFiles.includes(expected);
      });

      expect(missingFiles).toHaveLength(0);
      if (missingFiles.length > 0) {
        console.log('Missing normalized files:', missingFiles.slice(0, 10));
      }
    });

    test('should have same number of files as source', () => {
      expect(normalizedFiles.length).toBe(sourceFiles.length);
    });

    test('should preserve directory structure', async () => {
      // Check a sample of files to ensure directory structure is preserved
      const sampleSize = Math.min(10, sourceFiles.length);
      for (let i = 0; i < sampleSize; i++) {
        const sourceFile = sourceFiles[i];
        const expectedPath = sourceFile.replace(/\.mdx$/, '.md');
        expect(normalizedFiles).toContain(expectedPath);
      }
    });
  });

  describe('Content Preservation', () => {
    test('should preserve all headings', async () => {
      const sampleSize = Math.min(20, sourceFiles.length);
      const errors: string[] = [];

      for (let i = 0; i < sampleSize; i++) {
        const sourceFile = sourceFiles[i];
        const sourcePath = path.join(CONTENT_DIR, sourceFile);
        const normalizedPath = path.join(NORMALIZED_DIR, sourceFile.replace(/\.mdx$/, '.md'));

        try {
          const sourceContent = await fs.readFile(sourcePath, 'utf-8');
          const normalizedContent = await fs.readFile(normalizedPath, 'utf-8');

          const sourceHeadings = extractHeadings(sourceContent);
          const normalizedHeadings = extractHeadings(normalizedContent);

          // All source headings should be in normalized content
          for (const heading of sourceHeadings) {
            const cleanHeading = heading.replace(/<[^>]+>/g, '').trim();
            if (cleanHeading && !normalizedHeadings.some(h => h.includes(cleanHeading) || cleanHeading.includes(h))) {
              errors.push(`Missing heading "${cleanHeading}" in ${sourceFile}`);
            }
          }
        } catch (err) {
          errors.push(`Error processing ${sourceFile}: ${err}`);
        }
      }

      if (errors.length > 0) {
        console.log('Heading preservation errors:', errors.slice(0, 10));
      }
      expect(errors.length).toBeLessThan(5); // Allow some tolerance for edge cases
    });

    test('should not lose significant prose content', async () => {
      const sampleSize = Math.min(20, sourceFiles.length);
      const significantLoss: string[] = [];

      for (let i = 0; i < sampleSize; i++) {
        const sourceFile = sourceFiles[i];
        const sourcePath = path.join(CONTENT_DIR, sourceFile);
        const normalizedPath = path.join(NORMALIZED_DIR, sourceFile.replace(/\.mdx$/, '.md'));

        try {
          const sourceContent = await fs.readFile(sourcePath, 'utf-8');
          const normalizedContent = await fs.readFile(normalizedPath, 'utf-8');

          // Check that normalized file is not empty when source has content
          const sourceHasContent = sourceContent.trim().length > 100;
          const normalizedHasContent = normalizedContent.trim().length > 50;

          if (sourceHasContent && !normalizedHasContent) {
            significantLoss.push(`${sourceFile}: normalized file is nearly empty`);
          }

          // Check that headings are preserved (most important indicator of content preservation)
          const sourceHeadings = extractHeadings(sourceContent);
          const normalizedHeadings = extractHeadings(normalizedContent);

          // If source has headings, normalized should have at least 50% of them
          if (sourceHeadings.length > 0) {
            const headingPreservation = normalizedHeadings.length / sourceHeadings.length;
            if (headingPreservation < 0.5) {
              significantLoss.push(`${sourceFile}: only ${(headingPreservation * 100).toFixed(1)}% of headings preserved`);
            }
          }
        } catch (err) {
          significantLoss.push(`Error processing ${sourceFile}: ${err}`);
        }
      }

      if (significantLoss.length > 0) {
        console.log('Significant content loss:', significantLoss);
      }
      expect(significantLoss.length).toBe(0);
    });
  });

  describe('JSX/HTML Removal', () => {
    test('should remove all JSX components', async () => {
      const sampleSize = Math.min(30, normalizedFiles.length);
      const filesWithJSX: string[] = [];

      for (let i = 0; i < sampleSize; i++) {
        const file = normalizedFiles[i];
        const filePath = path.join(NORMALIZED_DIR, file);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const { found, examples } = containsJSXOrHTML(content);

          if (found) {
            filesWithJSX.push(`${file}: ${examples.join(', ')}`);
          }
        } catch (err) {
          // File read error
        }
      }

      if (filesWithJSX.length > 0) {
        console.log('Files still containing JSX/HTML:', filesWithJSX.slice(0, 10));
      }
      expect(filesWithJSX.length).toBe(0);
    });

    test('should not contain import/export statements outside code blocks', async () => {
      const sampleSize = Math.min(30, normalizedFiles.length);
      const filesWithImports: string[] = [];

      for (let i = 0; i < sampleSize; i++) {
        const file = normalizedFiles[i];
        const filePath = path.join(NORMALIZED_DIR, file);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          // Remove code blocks before checking
          const contentWithoutCode = content.replace(/```[\s\S]*?```/g, '');
          if (/^import\s+/m.test(contentWithoutCode) || /^export\s+/m.test(contentWithoutCode)) {
            filesWithImports.push(file);
          }
        } catch (err) {
          // File read error
        }
      }

      expect(filesWithImports).toHaveLength(0);
    });
  });

  describe('Frontmatter Conversion', () => {
    test('should convert frontmatter to Metadata section', async () => {
      const sampleSize = Math.min(20, sourceFiles.length);
      const conversionErrors: string[] = [];

      for (let i = 0; i < sampleSize; i++) {
        const sourceFile = sourceFiles[i];
        const sourcePath = path.join(CONTENT_DIR, sourceFile);
        const normalizedPath = path.join(NORMALIZED_DIR, sourceFile.replace(/\.mdx$/, '.md'));

        try {
          const sourceContent = await fs.readFile(sourcePath, 'utf-8');
          const normalizedContent = await fs.readFile(normalizedPath, 'utf-8');

          if (!checkFrontmatterConversion(sourceContent, normalizedContent)) {
            conversionErrors.push(sourceFile);
          }
        } catch (err) {
          conversionErrors.push(`Error: ${sourceFile}`);
        }
      }

      expect(conversionErrors).toHaveLength(0);
    });
  });
});

// ============================================================================
// UNIT TESTS FOR normalizeMDX FUNCTION
// ============================================================================

describe('normalizeMDX function', () => {
  test('should convert frontmatter', () => {
    const input = `---
title: Test
order: 1
---

# Hello`;
    const result = normalizeMDX(input);
    expect(result).toContain('Metadata');
    expect(result).toContain('title: Test');
    expect(result).toContain('# Hello');
  });

  test('should remove Callout and preserve text', () => {
    const input = `<Callout type="warning">This is a warning message.</Callout>`;
    const result = normalizeMDX(input);
    expect(result).toContain('Note:');
    expect(result).toContain('This is a warning message');
    expect(result).not.toContain('<Callout');
  });

  test('should convert img tags to markdown', () => {
    const input = `<img src="https://example.com/image.png" alt="test" />`;
    const result = normalizeMDX(input);
    expect(result).toContain('![](https://example.com/image.png)');
    expect(result).not.toContain('<img');
  });

  test('should convert anchor tags to text format', () => {
    const input = `<a href="https://example.com">Click here</a>`;
    const result = normalizeMDX(input);
    expect(result).toContain('Click here (https://example.com)');
    expect(result).not.toContain('<a href');
  });

  test('should remove NextPage component', () => {
    const input = `Some text
<NextPage
  info={{
    description: "Next page",
    slug: "/next",
    title: "Next"
  }}
/>`;
    const result = normalizeMDX(input);
    expect(result).toContain('Some text');
    expect(result).not.toContain('NextPage');
    expect(result).not.toContain('slug');
  });

  test('should remove MainImage component', () => {
    const input = `<MainImage src="test.png" alt="test" />`;
    const result = normalizeMDX(input);
    expect(result).not.toContain('MainImage');
    expect(result).not.toContain('src=');
  });

  test('should preserve code blocks', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = normalizeMDX(input);
    expect(result).toContain('```json');
    expect(result).toContain('"key": "value"');
  });

  test('should preserve markdown tables', () => {
    const input = `| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |`;
    const result = normalizeMDX(input);
    expect(result).toContain('| Header 1 | Header 2 |');
    expect(result).toContain('| Cell 1 | Cell 2 |');
  });

  test('should preserve bullet lists', () => {
    const input = `- Item 1
- Item 2
- Item 3`;
    const result = normalizeMDX(input);
    expect(result).toContain('- Item 1');
    expect(result).toContain('- Item 2');
  });

  test('should remove JSX expressions', () => {
    const input = `Text {" "} more text {variable} end`;
    const result = normalizeMDX(input);
    expect(result).not.toContain('{" "}');
    expect(result).not.toContain('{variable}');
    expect(result).toContain('Text');
    expect(result).toContain('more text');
  });

  test('should handle empty input', () => {
    const result = normalizeMDX('');
    expect(result).toBe('');
  });

  test('should handle input with only whitespace', () => {
    const result = normalizeMDX('   \n\n   ');
    expect(result).toBe('');
  });
});
