/**
 * Token Limit Compliance Check
 *
 * Validates every generated Markdown file in .api-reference-normalized/
 * is within the token budget. Exits with code 1 if any file exceeds
 * the limit, making it suitable for CI gating.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { encodingForModel } from 'js-tiktoken';

const TOKEN_HARD_LIMIT = 6600; // 6000 target + 10% tolerance for per-endpoint overhead
const NORMALIZED_DIR = path.resolve(process.cwd(), '../.api-reference-normalized');

async function discoverFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }
  await walk(dir);
  return files.sort();
}

async function main(): Promise<void> {
  console.log('Checking token limits for API spec normalized output...');
  console.log(`Directory: ${NORMALIZED_DIR}`);
  console.log(`Hard limit: ${TOKEN_HARD_LIMIT} tokens\n`);

  let files: string[];
  try {
    files = await discoverFiles(NORMALIZED_DIR);
  } catch (err) {
    console.error(`ERROR: Cannot read directory ${NORMALIZED_DIR}`);
    console.error('Run "npm run normalize-api-specs" first.');
    process.exit(1);
  }

  if (files.length === 0) {
    console.error('ERROR: No .md files found in normalized output.');
    process.exit(1);
  }

  console.log(`Found ${files.length} files\n`);

  const tokenizer = encodingForModel('gpt-4o');
  const violations: string[] = [];
  let maxTokens = 0;
  let maxFile = '';

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf-8');
    const tokens = tokenizer.encode(content).length;
    const rel = path.relative(NORMALIZED_DIR, filePath);

    if (tokens > maxTokens) {
      maxTokens = tokens;
      maxFile = rel;
    }

    if (tokens > TOKEN_HARD_LIMIT) {
      violations.push(`  ${rel}: ${tokens} tokens (limit: ${TOKEN_HARD_LIMIT})`);
    }
  }

  console.log(`Largest file: ${maxFile} (${maxTokens} tokens)`);
  console.log(`Files checked: ${files.length}\n`);

  if (violations.length > 0) {
    console.error('FAIL: The following files exceed the token limit:\n');
    for (const v of violations) {
      console.error(v);
    }
    process.exit(1);
  }

  console.log('PASS: All files are within token limits.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
