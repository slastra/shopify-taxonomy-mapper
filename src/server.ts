#!/usr/bin/env node

import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';
import { HierarchicalMapper } from './hierarchical-mapper.js';
import { DataFetcher } from './data-fetcher.js';

// Ensure taxonomy data is available (fetch from GitHub if needed)
const dataFetcher = new DataFetcher();
await dataFetcher.ensureTaxonomyData();

// Initialize instances
const taxonomy = new TaxonomyLoader();
const cache = new MappingCache();
let mapper: HierarchicalMapper;

// Load taxonomy data at startup
console.log('Loading Shopify taxonomy...');
await taxonomy.load();
console.log(`✓ Loaded Shopify taxonomy version ${taxonomy.getVersion()}`);
console.log(`✓ Total categories: ${taxonomy.getTotalCategoryCount()}`);

// Connect to SQLite database
try {
  cache.connect('./data/mappings.db');
  console.log('✓ Connected to mapping cache database (SQLite)');
} catch (error) {
  console.error('Warning: Could not connect to database:', error);
}

// Initialize hierarchical mapper
mapper = new HierarchicalMapper(taxonomy, cache);
console.log('✓ Hierarchical mapper initialized');
console.log(`✓ Using Nova model: ${mapper.getModelId()}`);

// Get port from environment or use default
const port = Number(process.env.HTTP_PORT || 3001);

// Get API access token from environment
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;
if (!API_ACCESS_TOKEN) {
  console.error('ERROR: API_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}
console.log('✓ API access token configured');

// Helper function to validate access token
function validateToken(req: Request): boolean {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return false;

  const token = authHeader.replace('Bearer ', '');
  return token === API_ACCESS_TOKEN;
}

// Start HTTP server
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Health check endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json(
        {
          status: 'ok',
          taxonomy_version: taxonomy.getVersion(),
          total_categories: taxonomy.getTotalCategoryCount(),
          cache_stats: cache.getStats(),
        },
        { headers: corsHeaders },
      );
    }

    // Map Amazon category path endpoint
    if (url.pathname === '/api/map-category' && req.method === 'POST') {
      // Validate access token
      if (!validateToken(req)) {
        return Response.json(
          { error: 'Unauthorized - valid access token required' },
          { status: 401, headers: corsHeaders },
        );
      }

      try {
        const body = await req.json() as { amazon_category?: string };

        if (!body.amazon_category || typeof body.amazon_category !== 'string') {
          return Response.json(
            { error: 'Missing or invalid "amazon_category" field' },
            { status: 400, headers: corsHeaders },
          );
        }

        const result = await mapper.mapCategory(body.amazon_category);

        return Response.json(
          {
            node_id: result.node_id,
            full_name: result.full_name,
            confidence: result.confidence,
            cached: result.cached,
            turns: result.turns,
          },
          { headers: corsHeaders },
        );
      } catch (error) {
        console.error('Error mapping category:', error);
        return Response.json(
          {
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // Map product title endpoint
    if (url.pathname === '/api/map-product' && req.method === 'POST') {
      // Validate access token
      if (!validateToken(req)) {
        return Response.json(
          { error: 'Unauthorized - valid access token required' },
          { status: 401, headers: corsHeaders },
        );
      }

      try {
        const body = await req.json() as { product_title?: string };

        if (!body.product_title || typeof body.product_title !== 'string') {
          return Response.json(
            { error: 'Missing or invalid "product_title" field' },
            { status: 400, headers: corsHeaders },
          );
        }

        const result = await mapper.mapProduct(body.product_title);

        return Response.json(
          {
            node_id: result.node_id,
            full_name: result.full_name,
            confidence: result.confidence,
            cached: result.cached,
            turns: result.turns,
          },
          { headers: corsHeaders },
        );
      } catch (error) {
        console.error('Error mapping product:', error);
        return Response.json(
          {
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // Search categories endpoint (utility)
    if (url.pathname === '/api/search' && req.method === 'GET') {
      try {
        const query = url.searchParams.get('q');
        const limit = Number(url.searchParams.get('limit') || 10);

        if (!query) {
          return Response.json(
            { error: 'Missing "q" query parameter' },
            { status: 400, headers: corsHeaders },
          );
        }

        const results = taxonomy.search(query, limit);

        return Response.json(
          {
            results: results.map(r => ({
              node_id: r.category.id.replace('gid://shopify/TaxonomyCategory/', ''),
              name: r.category.name,
              full_name: r.category.full_name,
              level: r.category.level,
            })),
            count: results.length,
          },
          { headers: corsHeaders },
        );
      } catch (error) {
        console.error('Error searching categories:', error);
        return Response.json(
          {
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // Get category by ID endpoint (utility)
    if (url.pathname.startsWith('/api/category/') && req.method === 'GET') {
      try {
        const nodeId = url.pathname.replace('/api/category/', '');

        if (!nodeId) {
          return Response.json(
            { error: 'Missing category ID' },
            { status: 400, headers: corsHeaders },
          );
        }

        const category = taxonomy.getCategory(nodeId);

        if (!category) {
          return Response.json(
            { error: 'Category not found' },
            { status: 404, headers: corsHeaders },
          );
        }

        return Response.json(
          {
            node_id: category.id.replace('gid://shopify/TaxonomyCategory/', ''),
            gid: category.id,
            name: category.name,
            full_name: category.full_name,
            level: category.level,
            is_leaf: category.children.length === 0,
            children_count: category.children.length,
            parent_id: category.parent_id,
          },
          { headers: corsHeaders },
        );
      } catch (error) {
        console.error('Error fetching category:', error);
        return Response.json(
          {
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // 404 for unknown routes
    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: corsHeaders },
    );
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
