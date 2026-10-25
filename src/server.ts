import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';
import { HierarchicalMapper, type ItemInput, type MappingResult } from './hierarchical-mapper.js';
import { DataFetcher } from './data-fetcher.js';
import { stripGid } from './ids.js';
import { errMessage } from './errors.js';

const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;
if (!API_ACCESS_TOKEN) {
  console.error('ERROR: API_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

const dataFetcher = new DataFetcher();
await dataFetcher.ensureTaxonomyData();

const taxonomy = new TaxonomyLoader();
console.log('Loading Shopify taxonomy...');
await taxonomy.load();
console.log(`✓ Loaded Shopify taxonomy version ${taxonomy.getVersion()}`);
console.log(`✓ Total categories: ${taxonomy.getTotalCategoryCount()}`);

const cache = new MappingCache();
cache.connect('./data/mappings.db');
console.log('✓ Connected to mapping cache database (SQLite)');

const mapper = new HierarchicalMapper(taxonomy, cache);
console.log(`✓ Using Jev model: ${mapper.getModelId()}`);

const port = Number(process.env.HTTP_PORT || 3001);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function unauthorized(): Response {
  return json({ error: 'Unauthorized - valid access token required' }, 401);
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function notFound(message = 'Not found'): Response {
  return json({ error: message }, 404);
}

function requireToken(req: Request): Response | null {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  return token === API_ACCESS_TOKEN ? null : unauthorized();
}

function mappingResponse(r: MappingResult): Response {
  return json({
    node_id: r.node_id,
    full_name: r.full_name,
    confidence: r.confidence,
    score: r.score,
    alternatives: r.alternatives,
    source: r.source,
    cached: r.cached,
    unmapped: r.unmapped,
    turns: r.turns,
  });
}

async function handle(label: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    console.error(`Error ${label}:`, error);
    return json({ error: 'Internal server error', message: errMessage(error) }, 500);
  }
}

const optionalString = (value: unknown): value is string | undefined => value === undefined || value === null || typeof value === 'string';

/**
 * Item fields from a request body. Accepts relo's Keepa product_data as-is:
 * asin, title, brand, features, product_group, and the category as either
 * amazon_category_tree ([{ name }]) or an amazon_category path string.
 */
function parseItem(body: Record<string, unknown>): ItemInput | string {
  const { asin, title, brand, features, product_group: productGroup, amazon_category: categoryPath, amazon_category_tree: tree } = body;
  for (const [name, value] of Object.entries({ asin, title, brand, product_group: productGroup, amazon_category: categoryPath })) {
    if (!optionalString(value)) return `"${name}" must be a string`;
  }
  if (features != null && !(Array.isArray(features) && features.every(f => typeof f === 'string'))) {
    return '"features" must be an array of strings';
  }
  let path = categoryPath as string | undefined;
  if (tree != null) {
    if (!(Array.isArray(tree) && tree.every(t => t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'))) {
      return '"amazon_category_tree" must be an array of { name } objects';
    }
    path = (tree as Array<{ name: string }>).map(t => t.name).join(' > ');
  }
  const item: ItemInput = {
    asin: (asin as string | null) ?? undefined,
    title: (title as string | null) ?? undefined,
    brand: (brand as string | null) ?? undefined,
    features: (features as string[] | null) ?? undefined,
    product_group: (productGroup as string | null) ?? undefined,
    category_path: path || undefined,
  };
  if (!item.title?.trim() && !item.category_path?.trim()) {
    return 'Need a "title" or a category ("amazon_category_tree" or "amazon_category")';
  }
  return item;
}

/** A category id in any form: "aa-1", or a TaxonomyCategory / ProductTaxonomyNode GID. */
function parseNodeId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().split('/').pop() ?? null;
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return json({
        status: 'ok',
        model: mapper.getModelId(),
        taxonomy_version: taxonomy.getVersion(),
        total_categories: taxonomy.getTotalCategoryCount(),
        cache_stats: cache.getStats(),
      });
    }

    if (url.pathname === '/api/map' && req.method === 'POST') {
      return requireToken(req) ?? handle('mapping item', async () => {
        const item = parseItem(await req.json() as Record<string, unknown>);
        if (typeof item === 'string') return badRequest(item);
        return mappingResponse(await mapper.mapItem(item));
      });
    }

    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      return requireToken(req) ?? handle('recording feedback', async () => {
        const body = await req.json() as Record<string, unknown>;
        const nodeId = parseNodeId(body.node_id);
        if (!nodeId) return badRequest('Missing or invalid "node_id"');
        if (!taxonomy.getCategory(nodeId)) return badRequest(`Unknown category "${nodeId}"`);
        const item = parseItem(body);
        if (typeof item === 'string') return badRequest(item);
        const { input_key: inputKey, previous_node_id: previousNodeId, mapping } = mapper.correct(item, nodeId);
        return json({ ok: true, input_key: inputKey, previous_node_id: previousNodeId, node_id: mapping.node_id, full_name: mapping.full_name });
      });
    }

    // Single-field endpoints, kept for existing callers. Prefer /api/map with every field.
    if (url.pathname === '/api/map-category' && req.method === 'POST') {
      return requireToken(req) ?? handle('mapping category', async () => {
        const body = await req.json() as { amazon_category?: string };
        if (!body.amazon_category || typeof body.amazon_category !== 'string') {
          return badRequest('Missing or invalid "amazon_category" field');
        }
        return mappingResponse(await mapper.mapCategory(body.amazon_category));
      });
    }

    if (url.pathname === '/api/map-product' && req.method === 'POST') {
      return requireToken(req) ?? handle('mapping product', async () => {
        const body = await req.json() as { product_title?: string };
        if (!body.product_title || typeof body.product_title !== 'string') {
          return badRequest('Missing or invalid "product_title" field');
        }
        return mappingResponse(await mapper.mapProduct(body.product_title));
      });
    }

    if (url.pathname === '/api/search' && req.method === 'GET') {
      return handle('searching categories', async () => {
        const query = url.searchParams.get('q');
        const limit = Number(url.searchParams.get('limit') || 10);
        if (!query) return badRequest('Missing "q" query parameter');

        const results = taxonomy.keywordSearch(query, limit);
        return json({
          results: results.map(c => ({
            node_id: stripGid(c.id),
            name: c.name,
            full_name: c.full_name,
            level: c.level,
          })),
          count: results.length,
        });
      });
    }

    if (url.pathname.startsWith('/api/category/') && req.method === 'GET') {
      return handle('fetching category', async () => {
        const nodeId = url.pathname.replace('/api/category/', '');
        if (!nodeId) return badRequest('Missing category ID');

        const category = taxonomy.getCategory(nodeId);
        if (!category) return notFound('Category not found');

        return json({
          node_id: stripGid(category.id),
          gid: category.id,
          name: category.name,
          full_name: category.full_name,
          level: category.level,
          is_leaf: category.children.length === 0,
          children_count: category.children.length,
          parent_id: category.parent_id,
        });
      });
    }

    return notFound();
  },
});

console.log(`\n✓ HTTP server running on http://localhost:${port}`);
console.log('\nAvailable endpoints:');
console.log('  GET  /health                  - Health check and stats');
console.log('  POST /api/map                 - Map an item (title, brand, features, category...)');
console.log('  POST /api/feedback            - Record a correction for an item');
console.log('  POST /api/map-category        - Map an Amazon category path (legacy)');
console.log('  POST /api/map-product         - Map a product title (legacy)');
console.log('  GET  /api/search?q=...        - Search categories by keyword');
console.log('  GET  /api/category/:id        - Get category by ID');
console.log('\nPress Ctrl+C to stop\n');
