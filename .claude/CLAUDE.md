# Shopify Taxonomy Mapper - Project Guidelines

## Project Overview

HTTP API service for mapping Amazon categories and product titles to Shopify's official product taxonomy using Amazon Nova models with AWS Bedrock.

**Production URL:** https://stm.revolvetrading.com
**Tech Stack:** Bun runtime, TypeScript, AWS Bedrock (Nova), SQLite cache
**Deployment:** Systemd service on VPS

## Architecture

### Core Components

- **src/server.ts** - HTTP server with Bun.serve(), API endpoints, token authentication
- **src/nova-client.ts** - AWS Bedrock client wrapper for Nova models
- **src/hierarchical-mapper.ts** - Multi-turn hierarchical navigation through taxonomy tree
- **src/taxonomy-loader.ts** - In-memory indexing of Shopify categories
- **src/data-fetcher.ts** - Auto-updates taxonomy from Shopify GitHub
- **src/database.ts** - SQLite caching layer for mapping results

### Data Flow

1. Request → Token validation → Cache check
2. If cache miss → Multi-turn LLM navigation
3. Each turn: LLM selects from category children using JSON schema
4. Result cached → Response returned

## Critical Patterns

### JSON Schema Structured Output (MOST IMPORTANT)

**Always use JSON schema with enum constraints for category selection:**

```typescript
// Build schema with exact category names as enum
const schema = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: options.map(o => o.name),  // Exact names only!
      description: 'The best matching category',
    },
  },
  required: ['category'],
};

// Pass to Nova
const response = await this.nova.converse(prompt, undefined, undefined, schema);

// Extract from structured output (guaranteed valid)
const selectedCategory = response.structuredOutput.category as string;
```

**Why this matters:**
- Without schema: LLM returns free-text ("Audio") that doesn't match ("Audio Equipment") → errors
- With schema: LLM constrained to exact enum values → guaranteed match
- See AWS Bedrock structured output docs: `additionalModelResponseFieldPaths`

**Never:**
- ❌ Parse free-text responses for category names
- ❌ Use string cleanup/matching logic for categories
- ❌ Rely on case-insensitive matching

### Authentication

All `/api/*` endpoints require Bearer token authentication:

```typescript
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN;  // Required env var

function validateToken(req: Request): boolean {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return false;
  const token = authHeader.replace('Bearer ', '');
  return token === API_ACCESS_TOKEN;
}
```

Token stored in `.env` (not committed). Generate with: `openssl rand -hex 32`

### Environment Variables

**Required:**
- `AMAZON-KEY` - AWS access key ID
- `AMAZON-SECRET` - AWS secret access key
- `AWS_REGION` - Default: us-east-1
- `API_ACCESS_TOKEN` - Bearer token for API auth

**Optional:**
- `NOVA_MODEL_ID` - Default: us.amazon.nova-micro-v1:0
  - Options: nova-micro, nova-lite, nova-pro
- `HTTP_PORT` - Default: 3001

### Nova Model Configuration

Model selected via `NOVA_MODEL_ID` environment variable:

```typescript
this.modelId = config.modelId || process.env.NOVA_MODEL_ID || 'us.amazon.nova-micro-v1:0';
```

**Model characteristics:**
- **Nova Micro** - Fastest, cheapest (~$0.003/mapping)
- **Nova Lite** - Better accuracy, moderate cost
- **Nova Pro** - Best accuracy, highest cost

**Inference config:**
```typescript
inferenceConfig: {
  maxTokens: 512,      // Optimized for tool use
  temperature: 0.2,    // Low for deterministic selection
}
```

### Taxonomy Data Management

**Auto-update on startup:**
1. Check local `data/categories.json` exists
2. Fetch version from Shopify GitHub
3. Download if version mismatch or missing
4. Fallback to cached version if GitHub unavailable

**Manual update:**
```bash
rm data/categories.json
bun start  # Will download latest
```

**GitHub source:** `Shopify/product-taxonomy` → `dist/en/categories.json`

### Caching Strategy

**SQLite cache in `data/mappings.db`:**
- Cache key: Exact string (category path or product title)
- Cache duration: Permanent (until DB deleted)
- Cache hit: Instant return with `cached: true`

**Clear cache:**
```bash
rm data/mappings.db
```

**Important:** Cache is based on exact string match. "Apple AirPods Pro" ≠ "Apple Airpods Pro"

### Multi-Turn Hierarchical Navigation

**Strategy:**
1. Turn 1: Select from 26 top-level verticals
2. Turn 2+: Drill down through subcategories
3. Continue until leaf node or "Other (use parent)" selected
4. Each turn uses JSON schema enum for selection

**Turn logging pattern:**
```typescript
console.log(`  [Turn ${++turnCount}] Selecting from ${category.children.length} children...`);
// ... make selection ...
console.log(`    └─ LLM selected: "${selectedCategory}"`);
console.log(`    └─ Selected: ${child.name}${child.children.length === 0 ? ' (LEAF)' : ''}`);
```

**"Other" fallback option:**
Always add to child options to allow stopping at parent when subcategories too specific:

```typescript
childOptions.push({
  name: 'Other (use parent category)',
  isLeaf: true,
});
```

## File Structure

```
shopify-taxonomy-mapper/
├── src/
│   ├── server.ts              # HTTP server + API routes
│   ├── nova-client.ts         # AWS Bedrock Nova client
│   ├── hierarchical-mapper.ts # Multi-turn navigation logic
│   ├── taxonomy-loader.ts     # Category indexing
│   ├── data-fetcher.ts        # GitHub auto-update
│   ├── database.ts            # SQLite cache
│   └── types.ts               # TypeScript definitions
├── data/
│   ├── categories.json        # Shopify taxonomy (auto-downloaded)
│   └── mappings.db            # SQLite cache (auto-created)
├── dist/                      # Compiled JS output
├── .env                       # Environment vars (NOT committed)
├── .env.example               # Template for .env
├── install-service.sh         # Systemd installer script
└── README.md                  # API documentation
```

## Development Workflow

### Build and Run

```bash
bun run build        # Compile TypeScript
bun start            # Run production build
bun run dev          # Development with watch mode
```

### Testing Locally

```bash
# Start server
bun start

# Test product mapping
curl -X POST http://localhost:3001/api/map-product \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"product_title": "Apple AirPods Pro"}'

# Test category mapping
curl -X POST http://localhost:3001/api/map-category \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"amazon_category": "Electronics > Audio"}'
```

### Production Deployment

**Initial setup:**
```bash
# On server
git clone <repo>
cd shopify-taxonomy-mapper
bun install
cp .env.example .env
# Edit .env with credentials
bun run build
sudo ./install-service.sh
sudo systemctl start shopify-taxonomy-mapper
```

**Systemd service commands:**
```bash
sudo systemctl status shopify-taxonomy-mapper    # Check status
sudo systemctl restart shopify-taxonomy-mapper   # Restart
sudo journalctl -u shopify-taxonomy-mapper -f    # View logs
```

**Deploying updates:**
```bash
git pull
bun install  # If dependencies changed
bun run build
sudo systemctl restart shopify-taxonomy-mapper
```

## API Endpoints

### POST /api/map-product

Map product title to Shopify taxonomy.

**Request:**
```json
{
  "product_title": "Apple AirPods Pro"
}
```

**Response:**
```json
{
  "node_id": "el-7-8-4-3",
  "full_name": "Electronics > Electronics Accessories > ...",
  "confidence": "high",
  "cached": false,
  "turns": 5
}
```

### POST /api/map-category

Map Amazon category path to Shopify taxonomy.

**Request:**
```json
{
  "amazon_category": "Tools & Home Improvement > Hardware > Brackets"
}
```

**Response:**
```json
{
  "node_id": "ha-6-1",
  "full_name": "Hardware > Hardware Accessories > Brackets & Reinforcement Braces",
  "confidence": "high",
  "cached": false,
  "turns": 3
}
```

### GET /health

Health check and statistics.

**Response:**
```json
{
  "status": "ok",
  "taxonomy_version": "2025-11-unstable",
  "total_categories": 11768,
  "cache_stats": {
    "total": 42,
    "byConfidence": { "high": 30, "medium": 10, "low": 2 }
  }
}
```

## Common Issues and Solutions

### Issue: "Could not find category" errors

**Cause:** Not using JSON schema structured output (free-text LLM responses don't match exact category names)

**Solution:** Always use JSON schema with enum constraints in `askForSelection()`. See "JSON Schema Structured Output" section above.

### Issue: Taxonomy data not available

**Cause:** First run and GitHub unreachable

**Solution:** Manually download categories.json from Shopify GitHub to `data/categories.json`

### Issue: 401 Unauthorized

**Cause:** Missing or invalid API access token

**Solution:**
1. Verify `.env` contains `API_ACCESS_TOKEN`
2. Check Authorization header: `Bearer <token>`
3. Regenerate token if needed: `openssl rand -hex 32`

### Issue: Data directory missing on production

**Cause:** `data/` directory doesn't exist on fresh deploy

**Solution:** Code now auto-creates directory via `mkdir(dirname(LOCAL_DATA_PATH), { recursive: true })`

### Issue: Systemd service won't start (status=226/NAMESPACE)

**Cause:** Overly restrictive security settings incompatible with Bun

**Solution:** `install-service.sh` uses relaxed settings (removed ProtectSystem, ProtectHome)

## Performance Characteristics

**Typical mapping:**
- Turns: 3-5
- Time: 1.5-3 seconds total
- Per-turn: 400-700ms (depends on model)

**Cache performance:**
- First request: 1.5-3s (LLM inference)
- Cached request: 10-20ms (99% faster)

**Cost (Nova Micro):**
- ~$0.003-0.004 per mapping
- 50x cheaper than Claude Sonnet
- Cached requests: Free

## Code Style and Conventions

### TypeScript Patterns

```typescript
// Use explicit types for public APIs
export interface MappingResult {
  node_id: string;
  confidence: 'high' | 'medium' | 'low';
  full_name: string;
  cached: boolean;
  turns?: number;
}

// Use optional chaining for safety
const version = parsed.version || null;

// Use template literals for logging
console.log(`[MAPPING] "${query}"`);
```

### Error Handling

```typescript
// Validate required environment variables at startup
if (!API_ACCESS_TOKEN) {
  console.error('ERROR: API_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

// Provide helpful error messages
throw new Error(
  'Taxonomy data not available: GitHub is unreachable and no cached version exists. ' +
  'Please check your internet connection or manually download categories.json'
);
```

### Logging Format

```typescript
// Startup checks
console.log('Checking taxonomy data...');
console.log('✓ Local taxonomy found (version 2025-11-unstable)');

// Mapping progress
console.log('[MAPPING] "Apple AirPods Pro"');
console.log('  [Turn 1] Selecting top-level vertical...');
console.log('    └─ Turn complete: 530ms');
console.log('    └─ LLM selected: "Electronics"');
console.log('[COMPLETE] Apple AirPods Pro -> Electronics > ...');
console.log('  ├─ Turns: 5');
console.log('  ├─ Confidence: high');
console.log('  └─ Time: 2682ms (536ms/turn)');
```

## Git Commit Guidelines

**Commit message format:**
```
Brief description of change (imperative mood)

- Bullet point details
- What changed and why
- Any breaking changes
```

**Examples:**
```
Implement JSON schema structured output for category selection

- Add JSON schema support to NovaLiteClient.converse()
- Use AWS Bedrock structured output with enum constraints
- Eliminate category matching errors and string cleanup logic
- Fix "Could not find category" errors (e.g., "Audio" mismatch)
```

```
Add systemd service installer script

- Auto-detects deployment directory and user
- Relaxed security settings for Bun compatibility
- Includes auto-restart and resource limits
```

## Important Notes

- **Never commit `.env`** - Contains sensitive AWS credentials
- **Never commit `data/`** - Auto-generated taxonomy and cache
- **Always use JSON schema** - For category selection (prevents matching errors)
- **Validate tokens** - All API endpoints require authentication
- **Auto-create directories** - Don't assume `data/` exists
- **Test before deploy** - Run local tests with fresh cache
- **Check logs** - Use `journalctl` to debug production issues
- **Model selection** - Micro for speed/cost, Lite for accuracy
