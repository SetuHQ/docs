/**
 * API Spec Normalization Script
 *
 * Converts OpenAPI 3.x / Swagger 2.0 JSON specs in `api-references/`
 * into deterministic Markdown files under `.api-reference-normalized/`.
 *
 * Each output file is token-counted and split if over 6000 tokens to
 * keep chunks RAG-friendly.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tiktoken, encodingForModel } from 'js-tiktoken';

// ============================================================================
// 1. TYPES
// ============================================================================

export type SpecFormat = 'openapi3' | 'swagger2';

export interface PropertyInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface RenderedSchema {
  properties: PropertyInfo[];
  example: unknown | undefined;
}

export interface ParameterInfo {
  name: string;
  in: string; // "header" | "path" | "query" | "cookie"
  required: boolean;
  type: string;
  description: string;
}

export interface RequestBodyInfo {
  description: string;
  required: boolean;
  properties: PropertyInfo[];
  example: unknown | undefined;
}

export interface ResponseHeaderInfo {
  name: string;
  description: string;
  type: string;
}

export interface ResponseInfo {
  statusCode: string;
  description: string;
  properties: PropertyInfo[];
  example: unknown | undefined;
  headers: ResponseHeaderInfo[];
}

export interface EndpointInfo {
  method: string;
  path: string;
  summary: string;
  description: string;
  operationId: string;
  tags: string[];
  parameters: ParameterInfo[];
  requestBody: RequestBodyInfo | null;
  responses: ResponseInfo[];
  deprecated: boolean;
}

export interface SecuritySchemeInfo {
  name: string;
  type: string;
  scheme?: string;
  in?: string;
  description?: string;
}

export interface ParsedSpec {
  title: string;
  description: string;
  version: string;
  baseUrl: string;
  endpoints: EndpointInfo[];
  securitySchemes: SecuritySchemeInfo[];
  format: SpecFormat;
}

export interface NormalizationResult {
  outputPath: string;
  markdown: string;
  tokenCount: number;
}

// ============================================================================
// 2. DETERMINISTIC JSON SERIALIZATION
// ============================================================================

/**
 * JSON.stringify with sorted keys at every level.
 * Guarantees the same object always serialises to the same string,
 * regardless of the insertion order of its properties.
 */
export function stableJsonStringify(value: unknown, indent: number = 2): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = (val as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return val;
  }, indent);
}

// ============================================================================
// 3. SAFE JSON PARSING
// ============================================================================

export function safeParseJSON(raw: string, filePath: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    let cleaned = raw;
    // Fix trailing commas
    cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // Fix single-quoted string values (e.g. 'value' instead of "value")
    cleaned = cleaned.replace(
      /:\s*'((?:[^'\\]|\\.)*)'/g,
      (_, content) => `: "${content.replace(/"/g, '\\"')}"`
    );
    // Fix unescaped newlines inside JSON string values
    cleaned = fixNewlinesInStrings(cleaned);
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`Failed to parse JSON in ${filePath}: ${e}`);
    }
  }
}

function fixNewlinesInStrings(json: string): string {
  // Walk char-by-char, track whether we're inside a string,
  // and replace raw newlines inside strings with \\n
  const result: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) {
      result.push(ch);
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result.push(ch);
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result.push(ch);
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      result.push('\\n');
      // skip \r\n pair
      if (ch === '\r' && json[i + 1] === '\n') i++;
      continue;
    }
    result.push(ch);
  }
  return result.join('');
}

// ============================================================================
// 3. SPEC TYPE DETECTION
// ============================================================================

export function detectSpecFormat(spec: any): SpecFormat {
  if (spec.openapi && typeof spec.openapi === 'string') {
    return 'openapi3';
  }
  if (spec.swagger && typeof spec.swagger === 'string') {
    return 'swagger2';
  }
  // Heuristic: if it has "components" it's likely OAS3, if "definitions" it's Swagger
  if (spec.components?.schemas) return 'openapi3';
  if (spec.definitions) return 'swagger2';
  // Default to openapi3
  return 'openapi3';
}

// ============================================================================
// 4. $REF RESOLUTION
// ============================================================================

const MAX_REF_DEPTH = 20;

export function resolveRef(refPath: string, rootSpec: any, visited: Set<string> = new Set(), depth: number = 0): any {
  if (depth > MAX_REF_DEPTH) return { _unresolved: refPath };
  if (visited.has(refPath)) return { _unresolved: `circular:${refPath}` };

  if (!refPath.startsWith('#/')) return { _unresolved: refPath };

  visited.add(refPath);
  const parts = refPath.slice(2).split('/');
  let current = rootSpec;

  for (const part of parts) {
    const decodedPart = decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (current == null || typeof current !== 'object') {
      return { _unresolved: refPath };
    }
    current = current[decodedPart];
  }

  if (current == null) return { _unresolved: refPath };

  // Recursively resolve any $refs in the resolved value
  return deepResolveRefs(current, rootSpec, new Set(visited), depth + 1);
}

export function deepResolveRefs(obj: any, rootSpec: any, visited: Set<string> = new Set(), depth: number = 0): any {
  if (depth > MAX_REF_DEPTH) return obj;
  if (obj == null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => deepResolveRefs(item, rootSpec, new Set(visited), depth));
  }

  if (obj.$ref && typeof obj.$ref === 'string') {
    return resolveRef(obj.$ref, rootSpec, new Set(visited), depth);
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = deepResolveRefs(value, rootSpec, new Set(visited), depth + 1);
  }
  return result;
}

// ============================================================================
// 5. SCHEMA → MARKDOWN RENDERING
// ============================================================================

export function inferTypeString(schema: any): string {
  if (!schema || typeof schema !== 'object') return 'any';

  if (schema.enum) {
    return `enum (${schema.enum.join(', ')})`;
  }
  if (schema.type === 'array') {
    if (schema.items) {
      const itemType = inferTypeString(schema.items);
      return `array of ${itemType}`;
    }
    return 'array';
  }
  if (schema.type === 'string' && schema.format) {
    return `string (${schema.format})`;
  }
  if (schema.type === 'integer' && schema.format) {
    return `integer (${schema.format})`;
  }
  if (schema.type === 'number' && schema.format) {
    return `number (${schema.format})`;
  }
  if (schema.type) {
    return schema.type;
  }
  if (schema.allOf || schema.anyOf || schema.oneOf) {
    return 'object';
  }
  return 'any';
}

export function renderSchemaToProperties(
  schema: any,
  required: string[] = [],
  prefix: string = '',
  depth: number = 0
): PropertyInfo[] {
  if (!schema || typeof schema !== 'object') return [];
  if (depth > 2) return [];

  // Handle allOf: merge schemas
  if (schema.allOf && Array.isArray(schema.allOf)) {
    let merged: any = {};
    let mergedRequired: string[] = [...required];
    for (const sub of schema.allOf) {
      // Skip example-only sub-schemas
      if (sub.example && !sub.type && !sub.properties && !sub.$ref && !sub.allOf) {
        continue;
      }
      if (sub.properties) {
        merged.properties = { ...merged.properties, ...sub.properties };
      }
      if (sub.type) merged.type = sub.type;
      if (sub.required) mergedRequired = [...mergedRequired, ...sub.required];
      // Merge anything else
      if (!sub.properties && !sub.type && !sub.required && !sub.example) {
        merged = { ...merged, ...sub };
      }
    }
    merged.required = mergedRequired;
    if (merged.properties) {
      return renderSchemaToProperties(merged, mergedRequired, prefix, depth);
    }
  }

  // Handle anyOf / oneOf: list variants
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf || schema.oneOf;
    const result: PropertyInfo[] = [];
    for (let i = 0; i < variants.length; i++) {
      const variantProps = renderSchemaToProperties(variants[i], required, prefix, depth);
      result.push(...variantProps);
    }
    return result;
  }

  // Standard object with properties
  if (schema.properties && typeof schema.properties === 'object') {
    const reqSet = new Set(schema.required || required);
    const result: PropertyInfo[] = [];

    for (const [propName, propSchema] of Object.entries(schema.properties).sort(([a], [b]) => a.localeCompare(b))) {
      const ps = propSchema as any;
      const fullName = prefix ? `${prefix}.${propName}` : propName;
      const isRequired = reqSet.has(propName);

      result.push({
        name: fullName,
        type: inferTypeString(ps),
        required: isRequired,
        description: ps.description || '',
      });

      // Recurse into nested objects (up to 2 levels)
      if (ps.type === 'object' && ps.properties && depth < 2) {
        const nested = renderSchemaToProperties(ps, ps.required || [], fullName, depth + 1);
        result.push(...nested);
      }
      // Recurse into array item objects
      if (ps.type === 'array' && ps.items?.type === 'object' && ps.items?.properties && depth < 2) {
        const nested = renderSchemaToProperties(ps.items, ps.items.required || [], `${fullName}[]`, depth + 1);
        result.push(...nested);
      }
    }

    return result;
  }

  return [];
}

export function renderPropertiesToMarkdown(properties: PropertyInfo[]): string {
  if (properties.length === 0) return '';
  const lines = properties.map(p => {
    const reqStr = p.required ? '**required**' : 'optional';
    const desc = p.description ? ` — ${p.description}` : '';
    return `- \`${p.name}\` (${p.type}, ${reqStr})${desc}`;
  });
  return lines.join('\n');
}

// ============================================================================
// 6. EXAMPLE EXTRACTION
// ============================================================================

export function extractExample(schema: any): unknown | undefined {
  if (!schema || typeof schema !== 'object') return undefined;

  // Direct example
  if (schema.example !== undefined) return schema.example;

  // allOf example
  if (schema.allOf && Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (sub.example !== undefined) return sub.example;
    }
  }

  return undefined;
}

// ============================================================================
// 7. UNIFIED SPEC PARSER
// ============================================================================

const STANDARD_RESPONSE_HEADERS = new Set([
  'date', 'content-length', 'content-type', 'server',
  'connection', 'keep-alive', 'transfer-encoding',
  'accept-ranges', 'vary', 'etag', 'last-modified',
  'expires', 'age',
]);

function isSemanticHeader(name: string): boolean {
  return !STANDARD_RESPONSE_HEADERS.has(name.toLowerCase());
}

export function cleanDescription(desc: string | undefined): string {
  if (!desc) return '';
  // Strip HTML tags
  return desc.replace(/<[^>]+>/g, '').trim();
}

function parseParameterType(param: any): string {
  if (param.schema) {
    return inferTypeString(param.schema);
  }
  if (param.type) {
    return param.type;
  }
  return 'string';
}

function parseResponseHeaders(headers: any): ResponseHeaderInfo[] {
  if (!headers || typeof headers !== 'object') return [];

  return Object.entries(headers)
    .filter(([name]) => isSemanticHeader(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]: [string, any]) => ({
      name,
      description: spec.description || '',
      type: spec.schema?.type || spec.type || 'string',
    }));
}

function getResponseSchema(responseObj: any, format: SpecFormat): any {
  if (format === 'swagger2') {
    return responseObj.schema || null;
  }
  // OAS3
  const content = responseObj.content;
  if (!content) return null;
  const jsonContent = content['application/json'] || content['*/*'] || Object.values(content)[0] as any;
  return jsonContent?.schema || null;
}

function getResponseExample(responseObj: any, format: SpecFormat): unknown | undefined {
  if (format === 'swagger2') {
    if (responseObj.examples?.['application/json']) {
      return responseObj.examples['application/json'];
    }
    return extractExample(responseObj.schema);
  }
  // OAS3
  const content = responseObj.content;
  if (!content) return undefined;
  const jsonContent = content['application/json'] || content['*/*'] || Object.values(content)[0] as any;
  if (!jsonContent) return undefined;

  // Check for examples (plural) first
  if (jsonContent.examples) {
    const firstExample = Object.values(jsonContent.examples)[0] as any;
    if (firstExample?.value !== undefined) return firstExample.value;
  }
  // Then direct example
  if (jsonContent.example !== undefined) return jsonContent.example;
  // Then schema-level example
  return extractExample(jsonContent.schema);
}

export function parseEndpoints(resolved: any, format: SpecFormat): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  const paths = resolved.paths || {};

  for (const [pathStr, pathObj] of Object.entries(paths)) {
    if (!pathObj || typeof pathObj !== 'object') continue;
    const pathItem = pathObj as Record<string, any>;
    const pathLevelParams: any[] = pathItem.parameters || [];

    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    for (const method of methods) {
      const op = pathItem[method];
      if (!op) continue;

      // Merge path-level and operation-level parameters
      const opParams: any[] = [...pathLevelParams, ...(op.parameters || [])];
      // Deduplicate by name+in
      const paramMap = new Map<string, any>();
      for (const p of opParams) {
        const key = `${p.name}:${p.in}`;
        paramMap.set(key, p);
      }

      const parameters: ParameterInfo[] = [];
      let requestBody: RequestBodyInfo | null = null;

      for (const param of paramMap.values()) {
        if (format === 'swagger2' && param.in === 'body') {
          // Convert Swagger 2 body param to requestBody
          const schema = param.schema || {};
          requestBody = {
            description: param.description || '',
            required: param.required || false,
            properties: renderSchemaToProperties(schema, schema.required || []),
            example: extractExample(schema),
          };
        } else {
          parameters.push({
            name: param.name || '',
            in: param.in || '',
            required: !!param.required,
            type: parseParameterType(param),
            description: param.description || '',
          });
        }
      }

      // OAS3 requestBody
      if (!requestBody && op.requestBody) {
        const rb = op.requestBody;
        const content = rb.content;
        let schema: any = null;
        if (content) {
          const jsonContent = content['application/json'] || content['*/*'] || Object.values(content)[0] as any;
          schema = jsonContent?.schema || null;
        }
        requestBody = {
          description: rb.description || '',
          required: !!rb.required,
          properties: schema ? renderSchemaToProperties(schema, schema.required || []) : [],
          example: schema ? extractExample(schema) : undefined,
        };
        // Also check content-level example
        if (!requestBody.example && content) {
          const jsonContent = content['application/json'] || content['*/*'] || Object.values(content)[0] as any;
          if (jsonContent?.example !== undefined) {
            requestBody.example = jsonContent.example;
          }
        }
      }

      // Parse responses
      const responses: ResponseInfo[] = [];
      if (op.responses) {
        for (const [statusCode, respObj] of Object.entries(op.responses)) {
          const resp = respObj as any;
          const respSchema = getResponseSchema(resp, format);
          const respExample = getResponseExample(resp, format);

          responses.push({
            statusCode,
            description: resp.description || '',
            properties: respSchema ? renderSchemaToProperties(respSchema, respSchema.required || []) : [],
            example: respExample,
            headers: parseResponseHeaders(resp.headers),
          });
        }
      }

      // Sort responses by status code
      responses.sort((a, b) => a.statusCode.localeCompare(b.statusCode));

      endpoints.push({
        method: method.toUpperCase(),
        path: pathStr,
        summary: op.summary || '',
        description: op.description || '',
        operationId: op.operationId || '',
        tags: [...(op.tags || [])].sort(),
        parameters,
        requestBody,
        responses,
        deprecated: !!op.deprecated,
      });
    }
  }

  // Sort endpoints deterministically by path + method.
  // Object.entries(paths) follows JSON property order, which can vary
  // if spec files are regenerated by different tools.
  endpoints.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.method.localeCompare(b.method);
  });

  return endpoints;
}

export function parseSecuritySchemes(resolved: any, format: SpecFormat): SecuritySchemeInfo[] {
  let schemes: Record<string, any>;

  if (format === 'swagger2') {
    schemes = resolved.securityDefinitions || {};
  } else {
    schemes = resolved.components?.securitySchemes || {};
  }

  return Object.entries(schemes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]: [string, any]) => ({
      name,
      type: spec.type || '',
      scheme: spec.scheme,
      in: spec.in,
      description: spec.description,
    }));
}

export function parseSpec(raw: any, format: SpecFormat): ParsedSpec {
  // Deep resolve all $refs first
  const resolved = deepResolveRefs(raw, raw);

  let baseUrl = '';
  if (format === 'swagger2') {
    const scheme = resolved.schemes?.[0] || 'https';
    const host = resolved.host || '';
    const basePath = resolved.basePath || '';
    baseUrl = host ? `${scheme}://${host}${basePath}` : '';
  } else {
    baseUrl = resolved.servers?.[0]?.url || '';
  }

  return {
    title: resolved.info?.title || 'Untitled API',
    description: cleanDescription(resolved.info?.description),
    version: resolved.info?.version || '',
    baseUrl,
    endpoints: parseEndpoints(resolved, format),
    securitySchemes: parseSecuritySchemes(resolved, format),
    format,
  };
}

// ============================================================================
// 8. MARKDOWN TEMPLATE RENDERING
// ============================================================================

function renderAuthSection(schemes: SecuritySchemeInfo[]): string {
  if (schemes.length === 0) return '';

  const lines = ['### Authentication'];
  for (const s of schemes) {
    if (s.scheme) {
      lines.push(`- **${s.name}**: ${s.type} (${s.scheme})`);
    } else if (s.in) {
      lines.push(`- **${s.name}**: ${s.type} (in ${s.in})`);
    } else {
      lines.push(`- **${s.name}**: ${s.type}`);
    }
    if (s.description) {
      lines.push(`  ${s.description}`);
    }
  }
  return lines.join('\n');
}

export function renderSpecHeader(spec: ParsedSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title}`);
  lines.push('');
  if (spec.description) {
    lines.push(spec.description);
    lines.push('');
  }
  if (spec.version) {
    lines.push(`**Version:** ${spec.version}`);
    lines.push('');
  }
  if (spec.baseUrl) {
    lines.push(`**Base URL:** \`${spec.baseUrl}\``);
    lines.push('');
  }

  const auth = renderAuthSection(spec.securitySchemes);
  if (auth) {
    lines.push(auth);
    lines.push('');
  }

  return lines.join('\n');
}

function renderParametersSection(params: ParameterInfo[]): string {
  if (params.length === 0) return '';

  const grouped: Record<string, ParameterInfo[]> = {};
  for (const p of params) {
    const loc = p.in || 'other';
    if (!grouped[loc]) grouped[loc] = [];
    grouped[loc].push(p);
  }

  const lines: string[] = ['### Parameters'];
  const order = ['path', 'header', 'query', 'cookie', 'other'];
  for (const loc of order) {
    const group = grouped[loc];
    if (!group || group.length === 0) continue;
    // Sort parameters within each group for deterministic output
    group.sort((a, b) => a.name.localeCompare(b.name));
    for (const p of group) {
      const reqStr = p.required ? '**required**' : 'optional';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`- \`${p.name}\` (${loc}, ${p.type}, ${reqStr})${desc}`);
    }
  }
  return lines.join('\n');
}

function renderRequestBodySection(rb: RequestBodyInfo): string {
  const lines: string[] = ['### Request Body'];
  if (rb.description) {
    lines.push(rb.description);
  }

  const propsMd = renderPropertiesToMarkdown(rb.properties);
  if (propsMd) {
    lines.push('');
    lines.push(propsMd);
  }

  if (rb.example !== undefined) {
    lines.push('');
    lines.push('**Example:**');
    lines.push('```json');
    lines.push(stableJsonStringify(rb.example));
    lines.push('```');
  }

  return lines.join('\n');
}

function renderResponseSection(resp: ResponseInfo): string {
  const desc = resp.description ? ` — ${resp.description}` : '';
  const lines: string[] = [`### Response ${resp.statusCode}${desc}`];

  // Semantic response headers
  if (resp.headers.length > 0) {
    lines.push('');
    lines.push('**Headers:**');
    for (const h of resp.headers) {
      const hDesc = h.description ? ` — ${h.description}` : '';
      lines.push(`- \`${h.name}\` (${h.type})${hDesc}`);
    }
  }

  const propsMd = renderPropertiesToMarkdown(resp.properties);
  if (propsMd) {
    lines.push('');
    lines.push(propsMd);
  }

  if (resp.example !== undefined) {
    lines.push('');
    lines.push('**Example:**');
    lines.push('```json');
    lines.push(stableJsonStringify(resp.example));
    lines.push('```');
  }

  return lines.join('\n');
}

export function renderEndpointToMarkdown(endpoint: EndpointInfo): string {
  const depStr = endpoint.deprecated ? ' (DEPRECATED)' : '';
  const lines: string[] = [];
  lines.push(`## ${endpoint.method} ${endpoint.path}${depStr}`);
  lines.push('');

  if (endpoint.summary) {
    lines.push(endpoint.summary);
    lines.push('');
  }
  if (endpoint.description && endpoint.description !== endpoint.summary) {
    lines.push(endpoint.description);
    lines.push('');
  }
  if (endpoint.tags.length > 0) {
    lines.push(`**Tags:** ${endpoint.tags.join(', ')}`);
    lines.push('');
  }

  const paramsMd = renderParametersSection(endpoint.parameters);
  if (paramsMd) {
    lines.push(paramsMd);
    lines.push('');
  }

  if (endpoint.requestBody) {
    lines.push(renderRequestBodySection(endpoint.requestBody));
    lines.push('');
  }

  for (const resp of endpoint.responses) {
    lines.push(renderResponseSection(resp));
    lines.push('');
  }

  return lines.join('\n');
}

function renderRAGMetadata(product: string, category: string, format: SpecFormat): string {
  return [
    '---',
    '## RAG Metadata',
    '- source_type: api-spec',
    `- product: ${product}`,
    `- category: ${category}`,
    `- spec_version: ${format}`,
    '',
  ].join('\n');
}

// ============================================================================
// 9. TOKEN COUNTING + SPLITTING
// ============================================================================

const TOKEN_LIMIT = 6000;

let tokenizer: Tiktoken | null = null;

function getTokenizer(): Tiktoken {
  if (!tokenizer) {
    tokenizer = encodingForModel('gpt-4o');
  }
  return tokenizer;
}

export function countTokens(text: string): number {
  return getTokenizer().encode(text).length;
}

export function endpointToSlug(endpoint: EndpointInfo): string {
  if (endpoint.operationId) {
    return endpoint.operationId
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }
  // Fallback: method-path
  return `${endpoint.method.toLowerCase()}-${endpoint.path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
}

export function buildOutputFiles(
  spec: ParsedSpec,
  category: string,
  product: string,
): NormalizationResult[] {
  const header = renderSpecHeader(spec);
  const metadata = renderRAGMetadata(product, category, spec.format);

  // Pass 1: try single file
  const endpointSections = spec.endpoints.map(ep => renderEndpointToMarkdown(ep));
  const singleFile = header + '\n' + endpointSections.join('\n') + '\n' + metadata;
  const singleTokenCount = countTokens(singleFile);

  if (singleTokenCount <= TOKEN_LIMIT) {
    return [{
      outputPath: `${category}/${product}.md`,
      markdown: singleFile,
      tokenCount: singleTokenCount,
    }];
  }

  // Pass 2: split into per-endpoint files
  const results: NormalizationResult[] = [];
  for (let i = 0; i < spec.endpoints.length; i++) {
    const ep = spec.endpoints[i];
    const slug = endpointToSlug(ep);
    const epMarkdown = header + '\n' + renderEndpointToMarkdown(ep) + '\n' + metadata;
    const epTokenCount = countTokens(epMarkdown);
    results.push({
      outputPath: `${category}/${product}.${slug}.md`,
      markdown: epMarkdown,
      tokenCount: epTokenCount,
    });
  }
  return results;
}

// ============================================================================
// 10. FILE DISCOVERY
// ============================================================================

interface DiscoveredSpec {
  filePath: string;
  category: string;
  product: string;
}

export async function discoverSpecFiles(dir: string): Promise<DiscoveredSpec[]> {
  const results: DiscoveredSpec[] = [];

  async function walk(currentDir: string, relativePath: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        // category = first segment (data | payments)
        const segments = relPath.split('/');
        const category = segments[0];
        // product = rest without extension
        const productSegments = segments.slice(1);
        const lastSeg = productSegments[productSegments.length - 1];
        productSegments[productSegments.length - 1] = lastSeg.replace(/\.json$/, '');
        const product = productSegments.join('/');

        results.push({ filePath: fullPath, category, product });
      }
    }
  }

  await walk(dir, '');
  results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return results;
}

// ============================================================================
// 11. CLI ENTRY POINT
// ============================================================================

async function processSpecFile(
  spec: DiscoveredSpec,
  outputDir: string,
): Promise<NormalizationResult[]> {
  const raw = await fs.readFile(spec.filePath, 'utf-8');
  const parsed = safeParseJSON(raw, spec.filePath);
  const format = detectSpecFormat(parsed);
  const parsedSpec = parseSpec(parsed, format);
  const results = buildOutputFiles(parsedSpec, spec.category, spec.product);

  for (const result of results) {
    const outPath = path.join(outputDir, result.outputPath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, result.markdown, 'utf-8');
  }

  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputDir = args[0] || path.resolve(process.cwd(), '../api-references');
  const outputDir = args[1] || path.resolve(process.cwd(), '../.api-reference-normalized');

  console.log(`Input directory: ${inputDir}`);
  console.log(`Output directory: ${outputDir}`);

  // Clean output directory to remove stale files from previous runs.
  // Without this, removed/renamed specs leave phantom files that get ingested.
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const specFiles = await discoverSpecFiles(inputDir);
  console.log(`Found ${specFiles.length} spec files`);

  let totalFiles = 0;
  let totalOutputs = 0;
  let errors = 0;

  for (const spec of specFiles) {
    try {
      const results = await processSpecFile(spec, outputDir);
      totalFiles++;
      totalOutputs += results.length;
      const tokenCounts = results.map(r => r.tokenCount);
      const maxTokens = Math.max(...tokenCounts);
      console.log(
        `  ${spec.category}/${spec.product}: ${results.length} file(s), max ${maxTokens} tokens`
      );
    } catch (error) {
      console.error(`  ERROR processing ${spec.filePath}:`, error);
      errors++;
    }
  }

  console.log(`\nNormalization complete!`);
  console.log(`  Specs processed: ${totalFiles}`);
  console.log(`  Output files: ${totalOutputs}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Output: ${outputDir}`);
}

// Only run if called directly
const isMainModule = process.argv[1]?.includes('normalize-api-specs');
if (isMainModule) {
  main().catch(console.error);
}
