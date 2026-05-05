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

### Structured Output via Forced Tool Use (MOST IMPORTANT)

Bedrock Nova doesn't natively expose `response_format: json_schema`. We use the
Converse API's tool-use mechanism with `toolChoice` set to force the model to
"call" a synthetic tool whose input schema is our enum. The tool input becomes
the structured output.

```typescript
// nova-client.ts wires the schema as a tool with forced toolChoice:
const tool = {
  toolSpec: {
    name: 'submit_selection',
    description: 'Submit the selected category and confidence level.',
    inputSchema: { json: jsonSchema },
  },
};
const toolConfig = {
  tools: [tool],
  toolChoice: { tool: { name: 'submit_selection' } }, // forces the call
};
// Model's tool input is surfaced as response.structuredOutput
```

**Why this matters:**
- Without forcing: model emits text like "Audio" that doesn't match "Audio Components" → errors
- With forced tool use: model is constrained to call submit_selection with valid enum → guaranteed match
- This is NOT `additionalModelResponseFieldPaths` — that field exists on Bedrock but Nova doesn't honor JSON-schema response formats. Tool use is the working path.

**Validation guard at hierarchical-mapper.ts:** even with forced tool choice, models occasionally pick a child-hint name instead of one of the actual options. The mapper detects this and falls back to the parent option. Logged so you can see how often it fires.

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
- `NOVA_MODEL_ID` - Default: us.amazon.nova-2-lite-v1:0
  - Options: nova-2-lite, nova-micro, nova-lite, nova-pro
  - The client also tolerates Anthropic Claude IDs (e.g. us.anthropic.claude-haiku-4-5-...) — it auto-drops `topP` for Claude since Bedrock rejects `temperature` + `topP` together.
- `HTTP_PORT` - Default: 3001

### Nova Model Configuration

Model selected via `NOVA_MODEL_ID` environment variable:

```typescript
this.modelId = config.modelId || process.env.NOVA_MODEL_ID || 'us.amazon.nova-micro-v1:0';
```

**Model characteristics (measured on 25-query eval, agreement vs Haiku 4.5):**
| Model | Accuracy | Avg ms | $/mapping (no cache) | $/mapping (cached) |
|---|---|---|---|---|
| Nova Micro | 36% | 2972 | $0.00023 | — |
| Nova Lite v1 | 72% | 3652 | $0.00040 | — |
| **Nova 2 Lite (default)** | **80%** | 3869 | $0.00322 | **$0.00066** |
| Nova Pro | 72% | 3938 | $0.00527 | — |
| Claude Haiku 4.5 | 100% (gold) | 7281 | $0.01042 | — |

Nova 2 Lite is the prod default — best accuracy in the Nova family, ~2x faster than Haiku 4.5, ~5x cheaper with caching enabled.

**Inference config:**
```typescript
inferenceConfig: {
  maxTokens: 512,      // Sufficient for JSON tool input
  temperature: 0.3,    // Low for deterministic selection
  topP: 0.9,           // Auto-dropped for Claude models
}
```

### Bedrock Prompt Caching

Each turn's prompt is split into:
- **Static cacheable prefix**: instructions + numbered options list (turn 1 = 26 verticals; drill-down = current parent's children). Identical across queries that hit the same option set, so it caches.
- **Dynamic suffix**: the input query and current navigation path.

A `cachePoint` marker is placed between them. Nova requires ≥1024 tokens before the marker — turn 1 (verticals + hints) clears this easily. Drill-down turns may not always hit the threshold, in which case the cache silently no-ops.

**Verifying cache hits:**
```bash
bun run measure-cache  # runs 7 sequential mappings, reports cache reads/writes/cost
```

`NovaResponse.usage` exposes `cacheReadInputTokens` and `cacheWriteInputTokens`. With a warm cache, steady-state cost drops ~78% vs uncached.

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

**SQLite result cache in `data/mappings.db`:**
- Cache key: input string, normalized via `trim().toLowerCase().replace(/\s+/g, ' ')`
- Cache duration: Permanent (until DB deleted)
- Cache hit: Instant return with `cached: true`

**Normalization:** "Apple AirPods Pro", "  apple  airpods  pro  ", and "APPLE AIRPODS PRO" all hit the same cache row. Different content (e.g. "Apple Airpods Pro" vs "Apple AirPods Pro") still produces different rows — case-insensitive only, not fuzzy.

**Clear cache:**
```bash
rm data/mappings.db
```

This is separate from Bedrock's prompt cache (above), which is per-turn LLM-input caching not result caching.

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

**"None of these match" fallback option:**
Added to child options so the model can backtrack when no subcategory fits:

```typescript
childOptions.push({
  name: 'None of these match',
  isLeaf: false,
  childNames: [],
});
```

When chosen, the mapper pops the current node and tries siblings (or re-picks a top-level vertical if the stack empties). MAX_BACKTRACKS = 5; beyond that we return the deepest reached category with `confidence: 'low'`.

## File Structure

```
shopify-taxonomy-mapper/
├── src/
│   ├── server.ts              # HTTP server + API routes
│   ├── nova-client.ts         # Bedrock Converse client (Nova + Claude tolerant)
│   ├── hierarchical-mapper.ts # Multi-turn navigation logic with prompt-cache friendly prompts
│   ├── taxonomy-loader.ts     # Category indexing
│   ├── data-fetcher.ts        # GitHub auto-update
│   ├── database.ts            # SQLite result cache (normalized keys)
│   └── types.ts               # TypeScript definitions
├── eval/
│   ├── eval-models.ts         # bun run eval — accuracy/speed across candidate models
│   └── measure-cache.ts       # bun run measure-cache — verify Bedrock prompt cache hits
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

**Cause:** Forced tool choice not in use OR model picked a child-hint name not in the enum.

**Solution:** Confirm `toolChoice: { tool: { name: 'submit_selection' } }` is set in nova-client.ts. The validation guard in `askForSelection` recovers from child-hint confusion by falling back to the parent option — but if it logs an error, that's a hint the option list format needs work.

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

**Typical mapping (Nova 2 Lite):**
- Turns: 3-7 (avg ~5-6)
- Time: 2-4 seconds total
- Per-turn: 400-700ms

**SQLite result cache:**
- First request: 2-4s (LLM drill-down)
- Cached (same input): 10-20ms

**Bedrock prompt cache (warm):**
- ~78% cost reduction vs uncached on the LLM side
- No latency penalty — actually slightly faster (less re-tokenization)

**Cost per mapping:**
- Nova 2 Lite, no caching: ~$0.0032
- Nova 2 Lite, with prompt cache warm: ~$0.0007
- SQLite-cached repeat: ~$0

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
