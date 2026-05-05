#!/usr/bin/env node

import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';
import { HierarchicalMapper } from './hierarchical-mapper.js';
import { DataFetcher } from './data-fetcher.js';
import { stripGid } from './ids.js';
import { errMessage } from './errors.js';

const dataFetcher = new DataFetcher();
await dataFetcher.ensureTaxonomyData();

const taxonomy = new TaxonomyLoader();
console.log('Loading Shopify taxonomy...');
await taxonomy.load();
console.log(`✓ Loaded Shopify taxonomy version ${taxonomy.getVersion()}`);
console.log(`✓ Total categories: ${taxonomy.getTotalCategoryCount()}`);

const cache = new MappingCache();
try {
  cache.connect('./data/mappings.db');
  console.log('✓ Connected to mapping cache database (SQLite)');
} catch (error) {
  console.error('Warning: Could not connect to database:', error);
}

const mapper = new HierarchicalMapper(taxonomy, cache);
console.log('✓ Hierarchical mapper initialized');
console.log(`✓ Using Nova model: ${mapper.getModelId()}`);

const port = Number(process.env.HTTP_PORT || 3001);

const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;
if (!API_ACCESS_TOKEN) {
  console.error('ERROR: API_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}
console.log('✓ API access token configured');

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

async function handle(label: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    console.error(`Error ${label}:`, error);
    return json({ error: 'Internal server error', message: errMessage(error) }, 500);
  }
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
        taxonomy_version: taxonomy.getVersion(),
        total_categories: taxonomy.getTotalCategoryCount(),
        cache_stats: cache.getStats(),
      });
    }

    if (url.pathname === '/api/map-category' && req.method === 'POST') {
      return requireToken(req) ?? handle('mapping category', async () => {
        const body = await req.json() as { amazon_category?: string };
        if (!body.amazon_category || typeof body.amazon_category !== 'string') {
          return badRequest('Missing or invalid "amazon_category" field');
        }
        const r = await mapper.mapCategory(body.amazon_category);
        return json({ node_id: r.node_id, full_name: r.full_name, confidence: r.confidence, cached: r.cached, turns: r.turns, unmapped: r.unmapped ?? false });
      });
    }

    if (url.pathname === '/api/map-product' && req.method === 'POST') {
      return requireToken(req) ?? handle('mapping product', async () => {
        const body = await req.json() as { product_title?: string };
        if (!body.product_title || typeof body.product_title !== 'string') {
          return badRequest('Missing or invalid "product_title" field');
        }
        const r = await mapper.mapProduct(body.product_title);
        return json({ node_id: r.node_id, full_name: r.full_name, confidence: r.confidence, cached: r.cached, turns: r.turns, unmapped: r.unmapped ?? false });
      });
    }

    if (url.pathname === '/api/search' && req.method === 'GET') {
      return handle('searching categories', async () => {
        const query = url.searchParams.get('q');
        const limit = Number(url.searchParams.get('limit') || 10);
        if (!query) return badRequest('Missing "q" query parameter');

        const results = taxonomy.search(query, limit);
        return json({
          results: results.map(r => ({
            node_id: stripGid(r.category.id),
            name: r.category.name,
            full_name: r.category.full_name,
            level: r.category.level,
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
console.log('  POST /api/map-category        - Map Amazon category path');
console.log('  POST /api/map-product         - Map product title');
console.log('  GET  /api/search?q=...        - Search categories');
console.log('  GET  /api/category/:id        - Get category by ID');
console.log('\nPress Ctrl+C to stop\n');
