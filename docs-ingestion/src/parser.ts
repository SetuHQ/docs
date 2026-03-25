/**
 * Markdown Parser Module
 *
 * Parses MDX files into structured AST (Abstract Syntax Tree).
 * Handles:
 * - YAML frontmatter extraction
 * - MDX/JSX component parsing
 * - Heading hierarchy extraction
 * - Code block preservation and deduplication
 *
 * Design principles:
 * - Structural parsing (not plain text)
 * - Preserve semantic meaning
 * - Handle MDX-specific syntax (JSX components)
 * - Deduplicate code blocks within sections
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import * as crypto from 'crypto';
import type { ParsedDocument, DocumentSection } from './types.js';
import { retryAsync } from './utils.js';

/**
 * Context for tracking seen code blocks to prevent duplication
 */
interface CodeBlockContext {
  seenCodeHashes: Set<string>;
}

/**
 * Parses a markdown/mdx file into a structured document
 *
 * @param filePath - Absolute path to the file
 * @param relativePath - Relative path from repository root
 * @returns Parsed document with frontmatter and AST
 */
export async function parseMarkdownFile(
  filePath: string,
  relativePath: string
): Promise<ParsedDocument> {
  // Read file content
  const rawContent = await retryAsync(() => fs.readFile(filePath, 'utf-8'));

  // Parse frontmatter
  const { data: frontmatter, content } = matter(rawContent);

  // Parse markdown/mdx to AST
  let ast;
  try {
    ast = fromMarkdown(content, {
      extensions: [mdxjs()],
      mdastExtensions: [mdxFromMarkdown()]
    });
  } catch (error) {
    throw new Error(
      `Failed to parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    filePath: relativePath,
    frontmatter,
    ast,
    content
  };
}

/**
 * Parses a plain Markdown file (no MDX/JSX extensions).
 *
 * Used for API spec normalized files which contain JSON code blocks
 * with curly braces that would be misinterpreted by the MDX parser.
 */
export async function parseMarkdownFileAsPlainMd(
  filePath: string,
  relativePath: string
): Promise<ParsedDocument> {
  const rawContent = await retryAsync(() => fs.readFile(filePath, 'utf-8'));
  const { data: frontmatter, content } = matter(rawContent);

  let ast;
  try {
    // Parse as standard Markdown — no MDX extensions
    ast = fromMarkdown(content);
  } catch (error) {
    throw new Error(
      `Failed to parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    filePath: relativePath,
    frontmatter,
    ast,
    content
  };
}

/**
 * Extracts document sections based on heading hierarchy
 *
 * This creates a tree structure where each heading becomes a section
 * containing its content and child sections.
 *
 * @param ast - Markdown AST
 * @returns Array of top-level sections
 */
export function extractSections(ast: any): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const stack: Array<{ section: DocumentSection; level: number }> = [];
  let currentContent: any[] = [];
  let currentStartLine = 1;

  // Create context for code block deduplication per file
  const codeBlockContext: CodeBlockContext = {
    seenCodeHashes: new Set()
  };

  /**
   * Finalizes the current section and adds it to the tree
   */
  function finalizeCurrentSection(
    heading: string,
    level: number,
    endLine: number
  ): DocumentSection {
    const content = nodesToText(currentContent, codeBlockContext);

    const section: DocumentSection = {
      heading,
      level,
      content,
      tokenCount: 0, // Will be calculated by chunker
      startLine: currentStartLine,
      endLine,
      children: []
    };

    currentContent = [];
    currentStartLine = endLine + 1;

    return section;
  }

  /**
   * Adds a section to the hierarchy
   */
  function addSection(section: DocumentSection) {
    // Find the correct parent in the stack
    while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      // Top-level section
      sections.push(section);
    } else {
      // Child section
      stack[stack.length - 1].section.children.push(section);
    }

    stack.push({ section, level: section.level });
  }

  // Visit all nodes in the AST
  let lineNumber = 1;

  visit(ast, (node: any) => {
    if (node.type === 'heading') {
      // Finalize previous section if we have content
      if (currentContent.length > 0 && stack.length > 0) {
        // Content belongs to the last section
        const lastSection = stack[stack.length - 1].section;
        const additionalContent = nodesToText(currentContent, codeBlockContext);
        if (additionalContent.trim()) {
          lastSection.content += '\n\n' + additionalContent;
        }
        lastSection.endLine = lineNumber - 1;
        currentContent = [];
      }

      // Create new section
      const headingText = toString(node);
      const section = {
        heading: headingText,
        level: node.depth,
        content: '',
        tokenCount: 0,
        startLine: lineNumber,
        endLine: lineNumber,
        children: []
      };

      addSection(section);
      currentStartLine = lineNumber + 1;
    } else {
      // Accumulate content
      currentContent.push(node);
    }

    // Update line number (rough estimate)
    if (node.position?.end?.line) {
      lineNumber = node.position.end.line;
    }
  });

  // Finalize any remaining content
  if (currentContent.length > 0 && stack.length > 0) {
    const lastSection = stack[stack.length - 1].section;
    const additionalContent = nodesToText(currentContent, codeBlockContext);
    if (additionalContent.trim()) {
      lastSection.content += '\n\n' + additionalContent;
    }
    lastSection.endLine = lineNumber;
  }

  return sections;
}

/**
 * Computes a hash of code block content for deduplication
 */
function hashCodeBlock(code: string, lang: string): string {
  return crypto
    .createHash('md5')
    .update(`${lang}:${code.trim()}`, 'utf-8')
    .digest('hex')
    .substring(0, 8);
}

/**
 * Converts an array of AST nodes to plain text
 *
 * Preserves code blocks, removes JSX components (but keeps their content),
 * maintains readability, and deduplicates code blocks.
 */
function nodesToText(nodes: any[], context: CodeBlockContext): string {
  if (nodes.length === 0) return '';

  const textParts: string[] = [];

  for (const node of nodes) {
    if (node.type === 'code') {
      // Handle code blocks with deduplication
      const lang = node.lang || '';
      const code = node.value || '';
      const codeHash = hashCodeBlock(code, lang);

      // Skip if we've already seen this exact code block
      if (context.seenCodeHashes.has(codeHash)) {
        continue;
      }

      context.seenCodeHashes.add(codeHash);
      textParts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
    } else if (node.type === 'inlineCode') {
      // Handle inline code (backticks) - no deduplication needed for short inline code
      textParts.push(`\`${node.value}\``);
    } else if (node.type === 'paragraph' || node.type === 'text') {
      const text = toString(node);
      if (text.trim()) {
        textParts.push(text);
      }
    } else if (node.type === 'list') {
      const text = toString(node);
      if (text.trim()) {
        textParts.push(text);
      }
    } else if (node.type === 'blockquote') {
      const text = toString(node);
      if (text.trim()) {
        textParts.push(text);
      }
    } else if (node.type === 'thematicBreak') {
      textParts.push('---');
    } else if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      // JSX components - extract text content recursively but avoid code duplication
      // Check if this JSX component contains code blocks
      const hasCodeBlock = nodeContainsCode(node);

      if (hasCodeBlock) {
        // Process children with code block awareness
        if (node.children && node.children.length > 0) {
          const childText = nodesToText(node.children, context);
          if (childText.trim()) {
            textParts.push(childText);
          }
        }
      } else {
        // No code blocks, safe to extract text normally
        const componentText = toString(node);
        if (componentText.trim()) {
          textParts.push(componentText);
        }
      }
    } else {
      // Fallback for other node types
      const text = toString(node);
      if (text.trim()) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('\n\n').trim();
}

/**
 * Checks if a node or its children contain code blocks
 */
function nodeContainsCode(node: any): boolean {
  if (node.type === 'code' || node.type === 'inlineCode') {
    return true;
  }

  if (node.children && Array.isArray(node.children)) {
    return node.children.some((child: any) => nodeContainsCode(child));
  }

  return false;
}

/**
 * Flattens a hierarchical section tree into a flat array
 * Useful for processing sections sequentially
 *
 * @param sections - Hierarchical sections
 * @returns Flat array of sections with full path and path array
 */
export function flattenSections(
  sections: DocumentSection[],
  parentPath: string = '',
  parentPathArray: string[] = []
): Array<{ section: DocumentSection; path: string; pathArray: string[] }> {
  const flattened: Array<{ section: DocumentSection; path: string; pathArray: string[] }> = [];

  for (const section of sections) {
    const sectionPath = parentPath
      ? `${parentPath} > ${section.heading}`
      : section.heading;

    const sectionPathArray = [...parentPathArray, section.heading];

    flattened.push({
      section,
      path: sectionPath,
      pathArray: sectionPathArray
    });

    if (section.children.length > 0) {
      flattened.push(...flattenSections(section.children, sectionPath, sectionPathArray));
    }
  }

  return flattened;
}

/**
 * Checks if a node is a code block
 * Code blocks should never be split across chunks
 */
export function isCodeBlock(node: any): boolean {
  return node.type === 'code';
}

/**
 * Extracts all code blocks from an AST
 * Useful for validation and special handling
 */
export function extractCodeBlocks(ast: any): Array<{ lang: string; code: string }> {
  const codeBlocks: Array<{ lang: string; code: string }> = [];

  visit(ast, 'code', (node: any) => {
    codeBlocks.push({
      lang: node.lang || 'text',
      code: node.value
    });
  });

  return codeBlocks;
}
