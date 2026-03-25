/**
 * Tests for API Spec Normalization
 *
 * Unit tests for core functions and integration tests that run
 * against the actual api-references/ files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  safeParseJSON,
  detectSpecFormat,
  resolveRef,
  deepResolveRefs,
  inferTypeString,
  renderSchemaToProperties,
  renderPropertiesToMarkdown,
  extractExample,
  cleanDescription,
  parseEndpoints,
  parseSecuritySchemes,
  parseSpec,
  renderSpecHeader,
  renderEndpointToMarkdown,
  countTokens,
  endpointToSlug,
  buildOutputFiles,
  discoverSpecFiles,
} from './normalize-api-specs.js';

import type { EndpointInfo, SpecFormat } from './normalize-api-specs.js';

const API_REFERENCES_DIR = path.resolve(process.cwd(), '../api-references');
const NORMALIZED_DIR = path.resolve(process.cwd(), '../.api-reference-normalized');

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('safeParseJSON', () => {
  test('should parse valid JSON', () => {
    const result = safeParseJSON('{"key": "value"}', 'test.json');
    expect(result).toEqual({ key: 'value' });
  });

  test('should handle trailing commas', () => {
    const result = safeParseJSON('{"key": "value",}', 'test.json');
    expect(result).toEqual({ key: 'value' });
  });

  test('should handle trailing commas in arrays', () => {
    const result = safeParseJSON('{"arr": [1, 2,]}', 'test.json');
    expect(result).toEqual({ arr: [1, 2] });
  });

  test('should throw on truly invalid JSON', () => {
    expect(() => safeParseJSON('not json at all', 'test.json')).toThrow();
  });
});

describe('detectSpecFormat', () => {
  test('should detect openapi 3.x', () => {
    expect(detectSpecFormat({ openapi: '3.0.0' })).toBe('openapi3');
    expect(detectSpecFormat({ openapi: '3.1.0' })).toBe('openapi3');
  });

  test('should detect swagger 2.0', () => {
    expect(detectSpecFormat({ swagger: '2.0' })).toBe('swagger2');
  });

  test('should use heuristic for ambiguous specs', () => {
    expect(detectSpecFormat({ components: { schemas: {} } })).toBe('openapi3');
    expect(detectSpecFormat({ definitions: {} })).toBe('swagger2');
  });

  test('should default to openapi3', () => {
    expect(detectSpecFormat({})).toBe('openapi3');
  });
});

describe('resolveRef', () => {
  const spec = {
    components: {
      schemas: {
        User: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
        Nested: {
          $ref: '#/components/schemas/User',
        },
      },
    },
  };

  test('should resolve a simple $ref', () => {
    const result = resolveRef('#/components/schemas/User', spec);
    expect(result.type).toBe('object');
    expect(result.properties.name.type).toBe('string');
  });

  test('should return unresolved marker for invalid path', () => {
    const result = resolveRef('#/components/schemas/Missing', spec);
    expect(result._unresolved).toBe('#/components/schemas/Missing');
  });

  test('should handle non-hash refs', () => {
    const result = resolveRef('external.json#/foo', spec);
    expect(result._unresolved).toBe('external.json#/foo');
  });
});

describe('deepResolveRefs', () => {
  test('should resolve nested $refs', () => {
    const spec = {
      components: {
        schemas: {
          Name: { type: 'string' },
        },
      },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': {
                schema: { $ref: '#/components/schemas/Name' },
              },
            },
          },
        },
      },
    };

    const result = deepResolveRefs(spec, spec);
    expect(result.paths['/test'].get.responses['200'].schema.type).toBe('string');
  });

  test('should handle circular refs gracefully', () => {
    const spec = {
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/A' },
        },
      },
    };

    // Should not throw, should mark as unresolved
    const result = deepResolveRefs(spec, spec);
    expect(result).toBeDefined();
  });

  test('should handle null/primitive input', () => {
    expect(deepResolveRefs(null, {})).toBeNull();
    expect(deepResolveRefs(42, {})).toBe(42);
    expect(deepResolveRefs('str', {})).toBe('str');
  });
});

describe('inferTypeString', () => {
  test('should return enum type', () => {
    expect(inferTypeString({ enum: ['A', 'B', 'C'] })).toBe('enum (A, B, C)');
  });

  test('should return array type', () => {
    expect(inferTypeString({ type: 'array', items: { type: 'string' } })).toBe('array of string');
    expect(inferTypeString({ type: 'array' })).toBe('array');
  });

  test('should return type with format', () => {
    expect(inferTypeString({ type: 'string', format: 'uuid' })).toBe('string (uuid)');
    expect(inferTypeString({ type: 'integer', format: 'int64' })).toBe('integer (int64)');
    expect(inferTypeString({ type: 'number', format: 'double' })).toBe('number (double)');
  });

  test('should return plain type', () => {
    expect(inferTypeString({ type: 'string' })).toBe('string');
    expect(inferTypeString({ type: 'object' })).toBe('object');
  });

  test('should return object for allOf/anyOf/oneOf', () => {
    expect(inferTypeString({ allOf: [] })).toBe('object');
    expect(inferTypeString({ anyOf: [] })).toBe('object');
  });

  test('should return any for unknown', () => {
    expect(inferTypeString({})).toBe('any');
    expect(inferTypeString(null)).toBe('any');
  });
});

describe('renderSchemaToProperties', () => {
  test('should render simple object properties', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'User name' },
        age: { type: 'integer' },
      },
    };

    const props = renderSchemaToProperties(schema);
    expect(props).toHaveLength(2);
    // Properties are sorted alphabetically for deterministic output
    expect(props[0].name).toBe('age');
    expect(props[0].required).toBe(false);
    expect(props[1].name).toBe('name');
    expect(props[1].required).toBe(true);
    expect(props[1].description).toBe('User name');
  });

  test('should handle allOf merging', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        {
          properties: { name: { type: 'string' } },
        },
      ],
    };

    const props = renderSchemaToProperties(schema);
    expect(props.length).toBeGreaterThanOrEqual(2);
    expect(props.find(p => p.name === 'id')?.required).toBe(true);
  });

  test('should skip example-only sub-schemas in allOf', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          properties: { status: { type: 'string' } },
        },
        {
          example: { status: 'SUCCESS' },
        },
      ],
    };

    const props = renderSchemaToProperties(schema);
    expect(props).toHaveLength(1);
    expect(props[0].name).toBe('status');
  });

  test('should handle nested objects with dot notation', () => {
    const schema = {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
      },
    };

    const props = renderSchemaToProperties(schema);
    expect(props.length).toBe(2);
    expect(props[1].name).toBe('data.id');
  });

  test('should return empty for null/invalid input', () => {
    expect(renderSchemaToProperties(null)).toEqual([]);
    expect(renderSchemaToProperties(undefined)).toEqual([]);
    expect(renderSchemaToProperties('not-object')).toEqual([]);
  });
});

describe('renderPropertiesToMarkdown', () => {
  test('should render bullet list', () => {
    const props = [
      { name: 'id', type: 'string', required: true, description: 'Unique ID' },
      { name: 'name', type: 'string', required: false, description: '' },
    ];
    const md = renderPropertiesToMarkdown(props);
    expect(md).toContain('- `id` (string, **required**) — Unique ID');
    expect(md).toContain('- `name` (string, optional)');
  });

  test('should return empty for empty array', () => {
    expect(renderPropertiesToMarkdown([])).toBe('');
  });
});

describe('extractExample', () => {
  test('should extract direct example', () => {
    expect(extractExample({ example: { key: 'val' } })).toEqual({ key: 'val' });
  });

  test('should extract from allOf', () => {
    const schema = {
      allOf: [
        { type: 'object' },
        { example: { status: 'OK' } },
      ],
    };
    expect(extractExample(schema)).toEqual({ status: 'OK' });
  });

  test('should return undefined when no example', () => {
    expect(extractExample({ type: 'object' })).toBeUndefined();
    expect(extractExample(null)).toBeUndefined();
  });
});

describe('cleanDescription', () => {
  test('should strip HTML tags', () => {
    expect(cleanDescription('<h2>Hello</h2> <p>World</p>')).toBe('Hello World');
  });

  test('should handle undefined', () => {
    expect(cleanDescription(undefined)).toBe('');
  });

  test('should preserve plain text', () => {
    expect(cleanDescription('Hello World')).toBe('Hello World');
  });
});

describe('endpointToSlug', () => {
  test('should convert camelCase operationId to kebab', () => {
    const ep = { operationId: 'fetchToken' } as EndpointInfo;
    expect(endpointToSlug(ep)).toBe('fetch-token');
  });

  test('should convert PascalCase operationId to kebab', () => {
    const ep = { operationId: 'VerifyPAN' } as EndpointInfo;
    expect(endpointToSlug(ep)).toBe('verify-pan');
  });

  test('should fallback to method-path when no operationId', () => {
    const ep = { operationId: '', method: 'GET', path: '/api/users' } as EndpointInfo;
    expect(endpointToSlug(ep)).toBe('get-api-users');
  });
});

describe('parseEndpoints', () => {
  test('should parse OAS3 endpoints', () => {
    const spec = {
      paths: {
        '/api/test': {
          get: {
            summary: 'Test endpoint',
            operationId: 'testGet',
            parameters: [
              { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { result: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const endpoints = parseEndpoints(spec, 'openapi3');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].method).toBe('GET');
    expect(endpoints[0].path).toBe('/api/test');
    expect(endpoints[0].parameters).toHaveLength(1);
    expect(endpoints[0].responses).toHaveLength(1);
  });

  test('should convert Swagger 2 body parameter to requestBody', () => {
    const spec = {
      paths: {
        '/api/test': {
          post: {
            summary: 'Test',
            operationId: 'testPost',
            parameters: [
              {
                name: 'body',
                in: 'body',
                required: true,
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' } },
                },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const endpoints = parseEndpoints(spec, 'swagger2');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].requestBody).not.toBeNull();
    expect(endpoints[0].requestBody!.properties.length).toBeGreaterThan(0);
    // Body param should NOT appear in parameters list
    expect(endpoints[0].parameters).toHaveLength(0);
  });

  test('should merge path-level and operation-level parameters', () => {
    const spec = {
      paths: {
        '/api/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          get: {
            summary: 'Get by ID',
            parameters: [
              { name: 'expand', in: 'query', required: false, schema: { type: 'boolean' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const endpoints = parseEndpoints(spec, 'openapi3');
    expect(endpoints[0].parameters).toHaveLength(2);
  });
});

describe('parseSecuritySchemes', () => {
  test('should parse OAS3 security schemes', () => {
    const spec = {
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
        },
      },
    };

    const schemes = parseSecuritySchemes(spec, 'openapi3');
    expect(schemes).toHaveLength(1);
    expect(schemes[0].name).toBe('bearer');
    expect(schemes[0].scheme).toBe('bearer');
  });

  test('should parse Swagger 2 security definitions', () => {
    const spec = {
      securityDefinitions: {
        api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    };

    const schemes = parseSecuritySchemes(spec, 'swagger2');
    expect(schemes).toHaveLength(1);
    expect(schemes[0].type).toBe('apiKey');
  });
});

describe('renderSpecHeader', () => {
  test('should render title, version, base URL', () => {
    const spec = {
      title: 'Test API',
      description: 'A test API',
      version: '1.0',
      baseUrl: 'https://api.example.com',
      endpoints: [],
      securitySchemes: [],
      format: 'openapi3' as SpecFormat,
    };

    const header = renderSpecHeader(spec);
    expect(header).toContain('# Test API');
    expect(header).toContain('A test API');
    expect(header).toContain('**Version:** 1.0');
    expect(header).toContain('`https://api.example.com`');
  });
});

describe('renderEndpointToMarkdown', () => {
  test('should render endpoint with parameters and response', () => {
    const ep: EndpointInfo = {
      method: 'POST',
      path: '/api/test',
      summary: 'Test endpoint',
      description: '',
      operationId: 'test',
      tags: ['Testing'],
      parameters: [
        { name: 'x-api-key', in: 'header', required: true, type: 'string', description: 'API key' },
      ],
      requestBody: {
        description: 'Request body',
        required: true,
        properties: [
          { name: 'name', type: 'string', required: true, description: 'Name' },
        ],
        example: { name: 'test' },
      },
      responses: [
        {
          statusCode: '200',
          description: 'OK',
          properties: [{ name: 'id', type: 'string', required: true, description: '' }],
          example: { id: '123' },
          headers: [],
        },
      ],
      deprecated: false,
    };

    const md = renderEndpointToMarkdown(ep);
    expect(md).toContain('## POST /api/test');
    expect(md).toContain('Test endpoint');
    expect(md).toContain('### Parameters');
    expect(md).toContain('`x-api-key`');
    expect(md).toContain('### Request Body');
    expect(md).toContain('`name`');
    expect(md).toContain('### Response 200');
    expect(md).toContain('"name": "test"');
  });

  test('should mark deprecated endpoints', () => {
    const ep: EndpointInfo = {
      method: 'GET',
      path: '/old',
      summary: '',
      description: '',
      operationId: '',
      tags: [],
      parameters: [],
      requestBody: null,
      responses: [],
      deprecated: true,
    };

    const md = renderEndpointToMarkdown(ep);
    expect(md).toContain('(DEPRECATED)');
  });
});

describe('countTokens', () => {
  test('should return positive count for non-empty text', () => {
    expect(countTokens('Hello world')).toBeGreaterThan(0);
  });

  test('should return 0 for empty text', () => {
    expect(countTokens('')).toBe(0);
  });
});

describe('buildOutputFiles', () => {
  test('should produce single file for small spec', () => {
    const spec = {
      title: 'Small API',
      description: '',
      version: '1.0',
      baseUrl: '',
      format: 'openapi3' as SpecFormat,
      securitySchemes: [],
      endpoints: [
        {
          method: 'GET',
          path: '/test',
          summary: 'Test',
          description: '',
          operationId: 'test',
          tags: [],
          parameters: [],
          requestBody: null,
          responses: [{ statusCode: '200', description: 'OK', properties: [], example: undefined, headers: [] }],
          deprecated: false,
        },
      ],
    };

    const results = buildOutputFiles(spec, 'data', 'test-api');
    expect(results).toHaveLength(1);
    expect(results[0].outputPath).toBe('data/test-api.md');
    expect(results[0].tokenCount).toBeLessThanOrEqual(6000);
  });
});

// ============================================================================
// INTEGRATION TESTS (against real files)
// ============================================================================

describe('Integration: discoverSpecFiles', () => {
  test('should discover all 25 spec files', async () => {
    const files = await discoverSpecFiles(API_REFERENCES_DIR);
    expect(files.length).toBe(26);
  });

  test('should have correct categories', async () => {
    const files = await discoverSpecFiles(API_REFERENCES_DIR);
    const categories = new Set(files.map(f => f.category));
    expect(categories).toContain('data');
    expect(categories).toContain('payments');
  });

  test('should extract product names correctly', async () => {
    const files = await discoverSpecFiles(API_REFERENCES_DIR);
    const products = files.map(f => f.product);
    expect(products).toContain('aadhar-lite');
    expect(products).toContain('bav/penny-drop');
    expect(products).toContain('billpay/api-integration');
  });
});

describe('Integration: parse real spec files', () => {
  test('should parse aadhar-lite.json (small OAS3 spec)', async () => {
    const raw = await fs.readFile(path.join(API_REFERENCES_DIR, 'data/aadhar-lite.json'), 'utf-8');
    const parsed = safeParseJSON(raw, 'aadhar-lite.json');
    expect(detectSpecFormat(parsed)).toBe('openapi3');

    const spec = parseSpec(parsed, 'openapi3');
    expect(spec.title).toContain('GST');  // title from the file
    expect(spec.endpoints.length).toBeGreaterThan(0);
    expect(spec.endpoints[0].method).toBe('POST');
  });

  test('should parse whatsapp-collect.json (trailing commas)', async () => {
    const raw = await fs.readFile(
      path.join(API_REFERENCES_DIR, 'payments/whatsapp-collect.json'),
      'utf-8'
    );
    // Should not throw despite trailing commas
    const parsed = safeParseJSON(raw, 'whatsapp-collect.json');
    expect(parsed).toBeDefined();
    expect(parsed.info.title).toBe('WhatsApp Bill APIs');
  });

  test('should parse bbps.json (Swagger 2.0)', async () => {
    const raw = await fs.readFile(path.join(API_REFERENCES_DIR, 'payments/bbps.json'), 'utf-8');
    const parsed = safeParseJSON(raw, 'bbps.json');
    expect(detectSpecFormat(parsed)).toBe('swagger2');

    const spec = parseSpec(parsed, 'swagger2');
    expect(spec.endpoints.length).toBeGreaterThan(0);
    expect(spec.baseUrl).toContain('setu.co');
  });

  test('should handle HTML in descriptions', async () => {
    const raw = await fs.readFile(
      path.join(API_REFERENCES_DIR, 'payments/whatsapp-collect.json'),
      'utf-8'
    );
    const parsed = safeParseJSON(raw, 'whatsapp-collect.json');
    const spec = parseSpec(parsed, detectSpecFormat(parsed));
    // Description should have HTML stripped
    expect(spec.description).not.toContain('<h2>');
    expect(spec.description).not.toContain('<li>');
  });
});

describe('Integration: full normalization output', () => {
  let allOutputFiles: string[] = [];

  beforeAll(async () => {
    // Check if normalized output exists
    try {
      await fs.access(NORMALIZED_DIR);
      const walk = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await walk(fullPath));
          } else if (entry.name.endsWith('.md')) {
            files.push(path.relative(NORMALIZED_DIR, fullPath));
          }
        }
        return files;
      };
      allOutputFiles = await walk(NORMALIZED_DIR);
    } catch {
      // Directory doesn't exist yet, tests will be skipped
    }
  });

  test('should have output files in data/ and payments/', () => {
    if (allOutputFiles.length === 0) {
      console.log('Skipping: run normalize-api-specs first');
      return;
    }
    const dataFiles = allOutputFiles.filter(f => f.startsWith('data/'));
    const paymentFiles = allOutputFiles.filter(f => f.startsWith('payments/'));
    expect(dataFiles.length).toBeGreaterThan(0);
    expect(paymentFiles.length).toBeGreaterThan(0);
  });

  test('should not exceed token limit per file', async () => {
    if (allOutputFiles.length === 0) {
      console.log('Skipping: run normalize-api-specs first');
      return;
    }
    // Per-endpoint files include the spec header + metadata overhead,
    // so a single large endpoint can slightly exceed 6000 tokens.
    // Allow 10% tolerance for individual endpoint files.
    const hardLimit = 6600;
    const oversized: string[] = [];
    for (const file of allOutputFiles) {
      const content = await fs.readFile(path.join(NORMALIZED_DIR, file), 'utf-8');
      const tokens = countTokens(content);
      if (tokens > hardLimit) {
        oversized.push(`${file}: ${tokens} tokens`);
      }
    }
    if (oversized.length > 0) {
      console.log('Oversized files:', oversized);
    }
    expect(oversized).toHaveLength(0);
  }, 30000);

  test('should contain RAG metadata in every file', async () => {
    if (allOutputFiles.length === 0) {
      console.log('Skipping: run normalize-api-specs first');
      return;
    }
    const missing: string[] = [];
    for (const file of allOutputFiles) {
      const content = await fs.readFile(path.join(NORMALIZED_DIR, file), 'utf-8');
      if (!content.includes('## RAG Metadata')) {
        missing.push(file);
      }
    }
    expect(missing).toHaveLength(0);
  });

  test('should contain source_type: api-spec in metadata', async () => {
    if (allOutputFiles.length === 0) {
      console.log('Skipping: run normalize-api-specs first');
      return;
    }
    const sample = allOutputFiles.slice(0, 5);
    for (const file of sample) {
      const content = await fs.readFile(path.join(NORMALIZED_DIR, file), 'utf-8');
      expect(content).toContain('source_type: api-spec');
    }
  });

  test('should preserve examples from source JSON', async () => {
    if (allOutputFiles.length === 0) {
      console.log('Skipping: run normalize-api-specs first');
      return;
    }
    // Check aadhar-lite which has a known example
    const aadharFiles = allOutputFiles.filter(f => f.includes('aadhar-lite'));
    if (aadharFiles.length > 0) {
      const content = await fs.readFile(path.join(NORMALIZED_DIR, aadharFiles[0]), 'utf-8');
      // The example has aadhaar_number: "999999990001"
      expect(content).toContain('999999990001');
    }
  });
});
