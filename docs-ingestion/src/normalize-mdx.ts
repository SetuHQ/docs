/**
 * MDX-to-Markdown Normalization Script
 *
 * Converts MDX files to clean, plain Markdown while preserving all
 * human-readable content and removing all syntax specific to MDX, JSX,
 * HTML, or UI components.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { scanDocumentationFiles, createDefaultScanConfig } from './scanner.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Find matching closing brace/bracket/paren, handling nesting
 */
function findMatchingClose(str: string, startIdx: number, openChar: string, closeChar: string): number {
  let depth = 1;
  let i = startIdx;
  while (i < str.length && depth > 0) {
    if (str[i] === openChar && str[i - 1] !== '\\') depth++;
    else if (str[i] === closeChar && str[i - 1] !== '\\') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

/**
 * Find matching closing tag
 */
function findMatchingCloseTag(str: string, startIdx: number, tagName: string): number {
  const openTag = new RegExp(`<${tagName}(?:\\s|>|/)`, 'g');
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let i = startIdx;

  while (i < str.length && depth > 0) {
    const closeIdx = str.indexOf(closeTag, i);
    if (closeIdx === -1) return -1;

    // Check for nested open tags between current position and close tag
    openTag.lastIndex = i;
    let match;
    while ((match = openTag.exec(str)) !== null && match.index < closeIdx) {
      // Check if self-closing
      const tagEnd = str.indexOf('>', match.index);
      if (tagEnd !== -1 && str[tagEnd - 1] !== '/') {
        depth++;
      }
    }

    depth--;
    if (depth === 0) {
      return closeIdx + closeTag.length;
    }
    i = closeIdx + closeTag.length;
  }

  return -1;
}

// ============================================================================
// NORMALIZATION RULES
// ============================================================================

/**
 * Remove import/export statements
 */
function removeImportsExports(content: string): string {
  content = content.replace(/^import\s+.*?(?:from\s+['"][^'"]*['"])?;?\s*$/gm, '');
  content = content.replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '');
  content = content.replace(/^export\s+(?:default\s+)?(?:const|let|var|function|class)\s+[\s\S]*?(?=\n(?:import|export|#|\n|$))/gm, '');
  content = content.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  content = content.replace(/^export\s+default\s+.*?;?\s*$/gm, '');
  return content;
}

/**
 * Convert YAML frontmatter to Metadata section
 */
function convertFrontmatter(content: string): string {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?/;
  const match = content.match(frontmatterRegex);
  if (match) {
    const frontmatterContent = match[1].trim();
    const metadataSection = `Metadata\n${frontmatterContent}\n\n`;
    content = content.replace(frontmatterRegex, metadataSection);
  }
  return content;
}

/**
 * Extract and preserve code blocks from template literals before other processing
 * This handles {`code`} patterns in CodeBlockWithCopy and other components
 */
function extractCodeFromTemplateLiterals(content: string): string {
  // Handle CodeBlockWithCopy components with template literals
  const codeBlockRegex = /<CodeBlockWithCopy\s+language=["']([^"']+)["']>\s*\{\s*`([\s\S]*?)`\s*\}\s*<\/CodeBlockWithCopy>/g;

  content = content.replace(codeBlockRegex, (_match, language, code) => {
    const cleanCode = code.trim();
    // Mark it with a special placeholder to protect it
    return `\n\`\`\`${language}\n${cleanCode}\n\`\`\`\n`;
  });

  return content;
}

/**
 * Process complex Tabs components by completely removing them
 * and extracting only the meaningful content
 */
function processComplexTabs(content: string): string {
  // Match Tabs with the tabs={[...]} attribute pattern
  // This is a complex structure that's hard to parse - we'll remove it entirely
  // and rely on the code blocks we already extracted

  // First, find <Tabs and find its closing
  let result = content;
  let iterations = 0;
  const maxIterations = 100;

  while (result.includes('<Tabs') && iterations < maxIterations) {
    iterations++;
    const tabsStart = result.indexOf('<Tabs');
    if (tabsStart === -1) break;

    // Find where this Tabs component ends
    // It could be self-closing <Tabs ... /> or have a closing tag </Tabs>
    let searchPos = tabsStart + 5;

    // Check if it's in the tabs={[...]}> format (self-closing effectively with >)
    // or if it has </Tabs>
    const closeTagPos = result.indexOf('</Tabs>', tabsStart);
    const selfClosePos = result.indexOf('/>', tabsStart);

    let endPos: number;

    // Look for the actual end considering the complex structure
    // The pattern is usually <Tabs tabs={[...]} ></Tabs> or <Tabs tabs={[...]}></Tabs>
    if (closeTagPos !== -1) {
      endPos = closeTagPos + '</Tabs>'.length;
    } else if (selfClosePos !== -1 && (closeTagPos === -1 || selfClosePos < closeTagPos)) {
      endPos = selfClosePos + 2;
    } else {
      // Can't find end, remove just the opening tag
      endPos = result.indexOf('>', tabsStart) + 1;
    }

    if (endPos > tabsStart) {
      // Extract the Tabs content for processing
      const tabsContent = result.substring(tabsStart, endPos);

      // Extract any code blocks that might be in template literals
      const extractedCode: string[] = [];
      const templateLiteralRegex = /\{\s*`([\s\S]*?)`\s*\}/g;
      let codeMatch;
      while ((codeMatch = templateLiteralRegex.exec(tabsContent)) !== null) {
        const code = codeMatch[1].trim();
        if (code.length > 10) { // Only include substantial code
          extractedCode.push('```\n' + code + '\n```');
        }
      }

      // Extract label text for section headers
      const labels: string[] = [];
      const labelRegex = /label:\s*["']([^"']+)["']/g;
      let labelMatch;
      while ((labelMatch = labelRegex.exec(tabsContent)) !== null) {
        labels.push(labelMatch[1]);
      }

      // Build replacement content
      let replacement = '';
      if (labels.length > 0 || extractedCode.length > 0) {
        // Add labels as headers and code blocks
        for (let i = 0; i < Math.max(labels.length, extractedCode.length); i++) {
          if (labels[i]) {
            replacement += `\n#### ${labels[i]}\n`;
          }
          if (extractedCode[i]) {
            replacement += `\n${extractedCode[i]}\n`;
          }
        }
      }

      result = result.substring(0, tabsStart) + replacement + result.substring(endPos);
    } else {
      break;
    }
  }

  return result;
}

/**
 * Process Row and Portion wrapper components
 */
function processRowPortion(content: string): string {
  // Remove Row and Portion wrappers but keep inner content
  let result = content;
  let iterations = 0;
  const maxIterations = 100;

  const wrapperTags = ['Row', 'Portion', 'Card', 'Text', 'Badge'];

  for (const tag of wrapperTags) {
    iterations = 0;
    while (result.includes(`<${tag}`) && iterations < maxIterations) {
      iterations++;

      // Find opening tag
      const openTagStart = result.indexOf(`<${tag}`);
      if (openTagStart === -1) break;

      // Find end of opening tag
      const openTagEnd = result.indexOf('>', openTagStart);
      if (openTagEnd === -1) break;

      // Check if self-closing
      if (result[openTagEnd - 1] === '/') {
        result = result.substring(0, openTagStart) + result.substring(openTagEnd + 1);
        continue;
      }

      // Find closing tag
      const closeTag = `</${tag}>`;
      const closeTagPos = result.indexOf(closeTag, openTagEnd);

      if (closeTagPos !== -1) {
        // Extract inner content, add paragraph breaks around it
        const innerContent = result.substring(openTagEnd + 1, closeTagPos);
        result = result.substring(0, openTagStart) + '\n\n' + innerContent + '\n\n' + result.substring(closeTagPos + closeTag.length);
      } else {
        // No closing tag, just remove opening tag
        result = result.substring(0, openTagStart) + result.substring(openTagEnd + 1);
      }
    }
  }

  return result;
}

/**
 * Extract text from Callout components
 */
function processCallouts(content: string): string {
  const calloutRegex = /<Callout\s+type=["'][^"']+["']>\s*([\s\S]*?)\s*<\/Callout>/g;

  content = content.replace(calloutRegex, (_match, innerContent) => {
    // Clean the inner content
    let text = innerContent
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{\s*["']\s*["']\s*\}/g, ' ')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) {
      return `\n**Note:** ${text}\n`;
    }
    return '';
  });

  return content;
}

/**
 * Remove purely presentational components
 */
function removePresentationalComponents(content: string): string {
  const presentationalComponents = [
    'MainImage',
    'NextPage',
    'WasPageHelpful',
    'Image',
    'Video',
    'ApiRequest',
    'ApiResponse'
  ];

  for (const component of presentationalComponents) {
    // Self-closing
    const selfClosingRegex = new RegExp(`<${component}[^>]*/>`, 'g');
    content = content.replace(selfClosingRegex, '');

    // With children - use non-greedy match
    const withChildrenRegex = new RegExp(`<${component}[^>]*>[\\s\\S]*?</${component}>`, 'g');
    content = content.replace(withChildrenRegex, '');
  }

  return content;
}

/**
 * Convert HTML elements to markdown equivalents
 */
function convertHTMLToMarkdown(content: string): string {
  // Convert <hr> to markdown horizontal rule
  content = content.replace(/<hr[^>]*\/?>/gi, '\n---\n');

  // Convert <br> to newlines
  content = content.replace(/<br\s*\/?>/gi, '\n');

  // Convert <img> to markdown image format (handles both self-closing and with closing tag)
  content = content.replace(/<img\s+src=["']([^"']+)["'][^>]*\/?>/gi, '![]($1)');
  // Remove any closing </img> tags that might remain
  content = content.replace(/<\/img>/gi, '');

  // Convert anchor tags to text (URL)
  content = content.replace(/<a\s+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)');

  // Convert <strong> and <b> to markdown bold
  content = content.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');

  // Convert <em> and <i> to markdown italic
  content = content.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // Convert <code> to backticks (but not inside code blocks)
  content = content.replace(/<code>([^<]+)<\/code>/gi, '`$1`');

  // Remove remaining HTML tags but preserve content
  const htmlTags = ['p', 'div', 'span', 'u', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'details', 'summary'];

  // Tags whose closing tag should produce a paragraph break (\n\n)
  const paragraphBreakTags = new Set(['p', 'tr', 'table', 'div', 'blockquote', 'details']);

  for (const tag of htmlTags) {
    const openTagRegex = new RegExp(`<${tag}[^>]*>`, 'gi');
    content = content.replace(openTagRegex, tag === 'li' ? '- ' : '');

    const closeTagRegex = new RegExp(`</${tag}>`, 'gi');
    if (tag === 'li') {
      content = content.replace(closeTagRegex, '\n');
    } else if (paragraphBreakTags.has(tag)) {
      content = content.replace(closeTagRegex, '\n\n');
    } else {
      content = content.replace(closeTagRegex, '');
    }
  }

  return content;
}

/**
 * Remove JSX expressions
 */
function removeJSXExpressions(content: string): string {
  // Remove {" "} spacers
  content = content.replace(/\{\s*["']\s*["']\s*\}/g, ' ');

  // Remove JSX comments
  content = content.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  // Remove simple variable expressions {variable}
  content = content.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, '');

  // Remove complex expressions carefully (not inside code blocks)
  // This is tricky - we need to avoid removing JSON objects in code blocks
  const lines = content.split('\n');
  let inCodeBlock = false;
  const processedLines = lines.map(line => {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) {
      return line;
    }
    // Remove JSX expressions outside code blocks
    return line
      .replace(/\{[^}`]*=>[^}`]*\}/g, '')
      .replace(/\{(?![^}]*["'`:]\s*[{[])[^}`]+\}/g, '');
  });

  return processedLines.join('\n');
}

/**
 * Remove remaining JSX components
 */
function removeRemainingJSXComponents(content: string): string {
  // Remove self-closing JSX components
  content = content.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');

  // Remove React fragments
  content = content.replace(/<>/g, '');
  content = content.replace(/<\/>/g, '');

  // Remove remaining JSX components with content (iterate to handle nesting)
  let prevContent = '';
  let iterations = 0;
  while (prevContent !== content && iterations < 20) {
    prevContent = content;
    iterations++;

    content = content.replace(/<([A-Z][a-zA-Z]*)[^>]*>([\s\S]*?)<\/\1>/g, (_match, _tag, inner) => {
      // Try to preserve text content
      return inner
        .replace(/<[^>]+>/g, ' ')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    });
  }

  return content;
}

/**
 * Remove MDX block directives
 */
function removeBlockDirectives(content: string): string {
  content = content.replace(/^:::.*$/gm, '');
  return content;
}

/**
 * Convert markdown links to plain text
 */
function convertLinks(content: string): string {
  // Protect code blocks first
  const codeBlockPlaceholders: string[] = [];
  content = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlockPlaceholders.push(match);
    return `__CODE_BLOCK_${codeBlockPlaceholders.length - 1}__`;
  });

  // Convert links: [text](url) -> text (url)
  content = content.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Restore code blocks
  content = content.replace(/__CODE_BLOCK_(\d+)__/g, (_match, idx) => {
    return codeBlockPlaceholders[parseInt(idx)];
  });

  return content;
}

/**
 * Clean up whitespace and formatting
 */
function cleanupWhitespace(content: string): string {
  // Remove lines that are only whitespace
  content = content.replace(/^\s+$/gm, '');

  // Collapse multiple blank lines
  content = content.replace(/\n{4,}/g, '\n\n\n');

  // Remove className/class attributes that might have leaked
  content = content.replace(/className=["'][^"']*["']/g, '');
  content = content.replace(/class=["'][^"']*["']/g, '');

  // Clean up lines
  content = content.split('\n').map(line => {
    // Preserve list indentation
    if (/^\s+[-*\d]/.test(line)) {
      return line.trimEnd();
    }
    // Preserve code block indentation
    if (/^\s{4,}/.test(line)) {
      return line.trimEnd();
    }
    return line.trim();
  }).join('\n');

  // Remove any remaining JSX-like artifacts
  content = content.replace(/\),\s*\},/g, '');
  content = content.replace(/\]\s*\}\s*>/g, '');
  content = content.replace(/>\s*\n\s*</g, '\n');

  // Remove Tabs component artifacts (key:, label:, content: patterns)
  content = content.replace(/^\s*\{\s*$/gm, '');
  content = content.replace(/^\s*key:\s*["'][^"']*["'],?\s*$/gm, '');
  content = content.replace(/^\s*label:\s*["'][^"']*["'],?\s*$/gm, '');
  content = content.replace(/^\s*content:\s*\(\s*$/gm, '');

  // Remove orphaned JSX closing tags and fragments
  content = content.replace(/^\s*\/>\s*$/gm, '');
  content = content.replace(/^\s*<\/>\s*$/gm, '');
  content = content.replace(/^\s*\(\s*$/gm, '');
  content = content.replace(/^\s*\)\s*$/gm, '');

  // Final cleanup of orphaned punctuation
  content = content.replace(/^\s*[,;:)}\]]+\s*$/gm, '');

  return content.trim();
}

/**
 * Main normalization function
 */
export function normalizeMDX(content: string): string {
  // Apply transformations in order
  content = removeImportsExports(content);
  content = convertFrontmatter(content);
  content = extractCodeFromTemplateLiterals(content);
  content = processCallouts(content);
  content = removePresentationalComponents(content);
  content = processComplexTabs(content);
  content = processRowPortion(content);
  content = convertHTMLToMarkdown(content);
  content = removeJSXExpressions(content);
  content = removeRemainingJSXComponents(content);
  content = removeBlockDirectives(content);
  content = convertLinks(content);
  content = cleanupWhitespace(content);

  return content;
}

/**
 * Process a single file
 */
async function processFile(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const content = await fs.readFile(inputPath, 'utf-8');
  const normalized = normalizeMDX(content);

  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, normalized, 'utf-8');
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const contentDir = args[0] || path.resolve(process.cwd(), '../content');
  const outputDir = args[1] || path.resolve(process.cwd(), '../.docs-normalized');

  console.log(`Content directory: ${contentDir}`);
  console.log(`Output directory: ${outputDir}`);

  const scanConfig = createDefaultScanConfig(contentDir);
  const files = await scanDocumentationFiles(scanConfig);

  console.log(`Found ${files.length} files to normalize`);

  let processed = 0;
  let errors = 0;

  for (const relativePath of files) {
    const inputPath = path.join(contentDir, relativePath);
    const normalizedPath = relativePath.replace(/\.mdx$/, '.md');
    const outputPath = path.join(outputDir, normalizedPath);

    try {
      await processFile(inputPath, outputPath);
      processed++;

      if (processed % 50 === 0) {
        console.log(`Processed ${processed}/${files.length} files...`);
      }
    } catch (error) {
      console.error(`Error processing ${relativePath}:`, error);
      errors++;
    }
  }

  console.log(`\nNormalization complete!`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Output: ${outputDir}`);
}

// Only run if called directly (not imported)
const isMainModule = process.argv[1]?.includes('normalize-mdx');
if (isMainModule) {
  main().catch(console.error);
}
