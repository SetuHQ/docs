/**
 * Text Cleaning Module
 *
 * Post-processes chunk content to remove quality issues:
 * 1. Intra-chunk text duplication (consecutive identical paragraphs)
 * 2. Excessive whitespace normalization
 *
 * Design principles:
 * - Preserve code blocks intact
 * - Remove only consecutive duplicates (not all occurrences)
 * - Maintain original text order
 */

/**
 * Deduplicates sentences within a single paragraph
 *
 * Removes duplicate sentences while preserving order and newlines.
 * Works at the sentence level to catch duplicates that span multiple lines.
 *
 * @param paragraph - Paragraph text
 * @returns Deduplicated paragraph
 */
function deduplicateSentencesInParagraph(paragraph: string): string {
  // First, collapse the paragraph into a single line to handle wrapped text
  const singleLine = paragraph.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Split on sentence boundaries (. ! ? followed by space and capital letter, or end of string)
  const sentences = singleLine.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])$/);

  const seenSentences = new Set<string>();
  const deduplicated: string[] = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // Normalize for comparison (lowercase, collapse whitespace)
    const normalized = trimmed.replace(/\s+/g, ' ').toLowerCase();

    // Skip if we've seen this sentence before
    if (seenSentences.has(normalized)) {
      continue;
    }

    deduplicated.push(trimmed);
    seenSentences.add(normalized);
  }

  // Rejoin with space (sentences are already separated by periods)
  return deduplicated.join(' ');
}

/**
 * Removes duplicate text blocks within a chunk (both consecutive and non-consecutive)
 *
 * Strategy:
 * 1. Split content into blocks (paragraphs and code blocks)
 * 2. Identify and preserve code blocks (never deduplicate)
 * 3. Remove ALL duplicate non-code blocks (keep first occurrence)
 * 4. Also deduplicate sentences within each paragraph
 * 5. Normalize whitespace
 *
 * This catches duplicates caused by MDX + markdown emitting similar text,
 * even when they're not consecutive.
 *
 * @param content - Raw chunk content
 * @returns Deduplicated content
 */
export function deduplicateChunkContent(content: string): string {
  if (!content || content.trim().length === 0) {
    return content;
  }

  // Extract code blocks first to protect them
  const codeBlocks: Array<{ placeholder: string; content: string }> = [];
  let codeBlockIndex = 0;

  // Replace code blocks with placeholders
  let protectedContent = content.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `__CODE_BLOCK_${codeBlockIndex}__`;
    codeBlocks.push({ placeholder, content: match });
    codeBlockIndex++;
    return placeholder;
  });

  // Split into paragraphs (double newline separated)
  const paragraphs = protectedContent.split(/\n\n+/);

  // Track all seen paragraphs (normalized) to catch non-consecutive duplicates
  const seenParagraphs = new Set<string>();
  const deduplicated: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Normalize for comparison (collapse whitespace, lowercase)
    const normalized = trimmed
      .replace(/\s+/g, ' ')
      .toLowerCase();

    // Skip if we've seen this paragraph anywhere before
    if (seenParagraphs.has(normalized)) {
      continue;
    }

    // Deduplicate sentences within this paragraph
    const deduplicatedParagraph = deduplicateSentencesInParagraph(trimmed);

    // Keep first occurrence
    deduplicated.push(deduplicatedParagraph);
    seenParagraphs.add(normalized);
  }

  // Rejoin with double newlines
  let result = deduplicated.join('\n\n');

  // Restore code blocks
  for (const { placeholder, content: codeContent } of codeBlocks) {
    result = result.replace(placeholder, codeContent);
  }

  return result.trim();
}

/**
 * Normalizes whitespace in chunk content
 *
 * - Removes leading/trailing whitespace
 * - Collapses multiple blank lines to double newline
 * - Preserves code block formatting
 *
 * @param content - Raw content
 * @returns Normalized content
 */
export function normalizeWhitespace(content: string): string {
  if (!content) return content;

  // Extract code blocks to protect them
  const codeBlocks: Array<{ placeholder: string; content: string }> = [];
  let codeBlockIndex = 0;

  let protectedContent = content.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `__CODE_BLOCK_${codeBlockIndex}__`;
    codeBlocks.push({ placeholder, content: match });
    codeBlockIndex++;
    return placeholder;
  });

  // Normalize whitespace outside code blocks
  protectedContent = protectedContent
    .replace(/[ \t]+$/gm, '') // Remove trailing spaces
    .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
    .trim();

  // Restore code blocks
  for (const { placeholder, content: codeContent } of codeBlocks) {
    protectedContent = protectedContent.replace(placeholder, codeContent);
  }

  return protectedContent;
}

/**
 * Full cleanup pipeline for a chunk
 *
 * Applies all cleaning operations in order:
 * 1. Deduplicate consecutive identical paragraphs
 * 2. Normalize whitespace
 *
 * @param content - Raw chunk content
 * @returns Cleaned content
 */
export function cleanChunkContent(content: string): string {
  let cleaned = content;

  // Step 1: Remove consecutive duplicates
  cleaned = deduplicateChunkContent(cleaned);

  // Step 2: Normalize whitespace
  cleaned = normalizeWhitespace(cleaned);

  return cleaned;
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions/i, label: 'ignore-instructions' },
  { pattern: /(disregard|forget|overlook)\s+(all\s+)?(previous|prior|earlier)\s+(instructions|guidance|rules)/i, label: 'ignore-instructions' },
  { pattern: /you\s+are\s+now/i, label: 'role-override' },
  { pattern: /(you'?re|you\s+will)\s+(now\s+)?(operating|acting|functioning)\s+as/i, label: 'role-override' },
  { pattern: /(pretend|act|behave)\s+(you\s+are|as\s+(if|though))/i, label: 'role-override' },
  { pattern: /system\s*prompt/i, label: 'system-prompt-reference' },
  { pattern: /(core|original|underlying)\s+(instructions|directive|rules)/i, label: 'system-prompt-reference' },
  { pattern: /<\|im_start\|>/i, label: 'chat-template-injection' },
  { pattern: /<\|(system|user|assistant)\|>/i, label: 'chat-template-injection' },
  { pattern: /\[INST\]/i, label: 'instruction-template-injection' },
  { pattern: /Human:\s*.{0,500}?\s*Assistant:/is, label: 'conversation-injection' },
];

export function detectPromptInjection(content: string): string[] {
  return INJECTION_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => label);
}
