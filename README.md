# Shopify Taxonomy Mapper

Intelligent HTTP API for mapping Amazon categories and product titles to Shopify's official product taxonomy using Amazon Nova Lite.

## Features

- **Intelligent Mapping**: Uses Amazon Nova Lite for semantic category matching via multi-turn hierarchical navigation
- **11,768 Shopify Categories**: Complete Shopify product taxonomy (auto-updated from GitHub)
- **Smart Caching**: SQLite-based cache prevents redundant API calls
- **Auto-Update**: Checks Shopify's GitHub repository for taxonomy updates on startup
- **Fast Performance**: 3-4 turns typical, ~2-3 seconds per mapping
- **Fallback Safety**: Uses cached taxonomy if GitHub is unavailable
- **CORS Enabled**: Ready for browser-based applications

## How It Works

### Hierarchical Drill-Down Strategy

The API uses a multi-turn conversation with Amazon Nova Lite to intelligently navigate the taxonomy tree:

1. **Turn 1**: Select from 26 top-level verticals (Animals & Pet Supplies, Electronics, Furniture, etc.)
2. **Turn 2+**: Drill down through subcategories level by level
3. **Smart Selection**: Nova Lite makes semantic matches based on product context
4. **Leaf Detection**: Continues until reaching most specific category
5. **Fallback Option**: "Other (use parent category)" available when subcategories are too specific

### Example Flow

```
Query: "Raspberry Pi 5"

Turn 1: Select vertical
  → "Electronics"

Turn 2: Select from 20 Electronics children
  → "Computers"

Turn 3: Select from 12 Computers children
  → "Barebone Computers" (LEAF)

Result: Electronics > Computers > Barebone Computers
Time: ~1.9s (3 turns)
```

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (or Node.js >=18)
- AWS account with Bedrock access (for Nova Lite)
- AWS credentials with `bedrock:InvokeModel` permission

### Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd shopify-taxonomy-mapper
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Configure environment** (copy `.env.example` to `.env`):
   ```bash
   cp .env.example .env
   ```

4. **Edit `.env` with your AWS credentials**:
   ```env
   AMAZON-KEY=your_aws_access_key_id
   AMAZON-SECRET=your_aws_secret_access_key
   AWS_REGION=us-east-1
   NOVA_MODEL_ID=us.amazon.nova-micro-v1:0
   HTTP_PORT=3001
   ```

5. **Build the project**:
   ```bash
   bun run build
   ```

6. **Start the server**:
   ```bash
   bun start
   ```

The server will:
- Check for taxonomy updates from Shopify's GitHub
- Download categories.json if needed (or use cached version)
- Start listening on `http://localhost:3001`

## API Endpoints

### POST /api/map-category

Map an Amazon category path to Shopify taxonomy.

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
  "approach": "hierarchical",
  "turns": 3
}
```

**curl Example:**
```bash
curl -X POST http://localhost:3001/api/map-category \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"amazon_category": "Pet Supplies > Dogs > Food"}'
```

---

### POST /api/map-product

Map a product title to Shopify taxonomy.

**Request:**
```json
{
  "product_title": "Raspberry Pi 5 8GB RAM"
}
```

**Response:**
```json
{
  "node_id": "el-6-1",
  "full_name": "Electronics > Computers > Barebone Computers",
  "confidence": "high",
  "cached": false,
  "approach": "hierarchical",
  "turns": 3
}
```

**curl Example:**
```bash
curl -X POST http://localhost:3001/api/map-product \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"product_title": "Stainless Steel Dog Bowl"}'
```

---

### GET /api/search

Search Shopify categories by keyword (utility endpoint).

**Query Parameters:**
- `q` (required): Search query
- `limit` (optional): Max results (default: 10)

**Response:**
```json
{
  "results": [
    {
      "node_id": "ap-2-3-6",
      "name": "Dog Supplies",
      "full_name": "Animals & Pet Supplies > Pet Supplies > Dog Supplies",
      "level": 2
    }
  ],
  "count": 1
}
```

**curl Example:**
```bash
curl "http://localhost:3001/api/search?q=dog%20food&limit=5"
```

---

### GET /api/category/:id

Get detailed category information by node ID (utility endpoint).

**Response:**
```json
{
  "node_id": "ap-2-3-6",
  "gid": "gid://shopify/TaxonomyCategory/ap-2-3-6",
  "name": "Dog Supplies",
  "full_name": "Animals & Pet Supplies > Pet Supplies > Dog Supplies",
  "level": 2,
  "is_leaf": false,
  "children_count": 15,
  "parent_id": "gid://shopify/TaxonomyCategory/ap-2-3"
}
```

**curl Example:**
```bash
curl http://localhost:3001/api/category/ap-2-3-6
```

---

### GET /health

Health check and server statistics.

**Response:**
```json
{
  "status": "ok",
  "taxonomy_version": "2025-11-unstable",
  "total_categories": 11768,
  "cache_stats": {
    "total": 42,
    "byConfidence": { "high": 30, "medium": 10, "low": 2 },
    "bySource": { "llm": 42 }
  }
}
```

## Data Management

### Taxonomy Updates

The API automatically manages the Shopify product taxonomy data:

**On Startup:**
1. Checks if `data/categories.json` exists locally
2. Fetches version info from [Shopify's GitHub](https://github.com/Shopify/product-taxonomy)
3. Downloads new version if available
4. Falls back to cached version if GitHub is unavailable

**Manual Update:**
Delete the cached file to force a fresh download:
```bash
rm data/categories.json
bun start
```

### Caching

All mapping results are cached in SQLite (`data/mappings.db`) to prevent redundant Nova API calls:

- **Cache keys**: Amazon category paths or product titles (exact string match)
- **Cache duration**: Permanent (until database is cleared)
- **Cache hit**: Returns instantly with `"cached": true`

**Clear cache:**
```bash
rm data/mappings.db
```

## Cost & Performance

### API Costs

- **Nova Lite**: ~$0.003-0.004 per mapping (50x cheaper than Claude)
- **Cached requests**: Free (instant return)

### Performance Metrics

**Typical mapping:**
- **Turns**: 3-4
- **Time**: 1.9-2.8 seconds
- **Per-turn**: 600-800ms

**Cache performance:**
- **First request**: 1.9-2.8s (LLM inference)
- **Cached request**: 10-20ms (99% faster)

## Development

### Scripts

```bash
bun run dev          # Development mode with watch
bun run build        # Compile TypeScript
bun start            # Production start
bun run lint         # ESLint check
bun run lint:fix     # Auto-fix linting issues
bun run type-check   # TypeScript validation
```

### Project Structure

```
shopify-taxonomy-mapper/
├── src/
│   ├── server.ts              # HTTP server entry point
│   ├── data-fetcher.ts        # GitHub taxonomy updater
│   ├── hierarchical-mapper.ts # Mapping logic
│   ├── taxonomy-loader.ts     # Category indexing
│   ├── database.ts            # SQLite cache
│   ├── nova-client.ts         # AWS Bedrock client
│   └── types.ts               # Type definitions
├── data/
│   ├── categories.json        # Shopify taxonomy (auto-downloaded)
│   └── mappings.db            # SQLite cache (auto-created)
├── dist/                      # Compiled JavaScript
├── package.json
├── tsconfig.json
├── .env                       # Environment variables (not in git)
└── README.md
```

## Deployment

### Docker (recommended)

```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install

COPY . .
RUN bun run build

EXPOSE 3001
CMD ["bun", "start"]
```

### Systemd Service (Production)

The project includes an automated installer for systemd service deployment:

```bash
# Install and configure the systemd service
sudo ./install-service.sh

# Start the service
sudo systemctl start shopify-taxonomy-mapper

# Check status
sudo systemctl status shopify-taxonomy-mapper

# View logs (follow mode)
sudo journalctl -u shopify-taxonomy-mapper -f

# View logs (last 100 lines)
sudo journalctl -u shopify-taxonomy-mapper -n 100

# Restart the service
sudo systemctl restart shopify-taxonomy-mapper

# Stop the service
sudo systemctl stop shopify-taxonomy-mapper
```

**Features:**
- Auto-detects deployment directory and user
- Auto-restart on crashes (10s delay, max 3 attempts/minute)
- Memory limit: 1GB
- CPU limit: 100%
- Security hardening (read-only filesystem, private tmp)
- Integrated with systemd journal for logging
- Auto-start on system boot

### Environment Variables

Required:
- `AMAZON-KEY`: AWS access key ID
- `AMAZON-SECRET`: AWS secret access key
- `AWS_REGION`: AWS region (default: us-east-1)
- `API_ACCESS_TOKEN`: Access token for API authentication (generate with `openssl rand -hex 32`)

Optional:
- `NOVA_MODEL_ID`: Nova model to use (default: us.amazon.nova-micro-v1:0)
  - Options: `us.amazon.nova-micro-v1:0`, `us.amazon.nova-lite-v1:0`, `us.amazon.nova-pro-v1:0`
- `HTTP_PORT`: Server port (default: 3001)

### Production Checklist

- [ ] Set AWS credentials with least-privilege IAM policy
- [ ] Configure reverse proxy (nginx/Caddy) with HTTPS
- [ ] Set up monitoring for API errors and latency
- [ ] Consider rate limiting for public deployment
- [ ] Review CORS settings in `src/server.ts`

## Troubleshooting

### Issue: "Taxonomy data not available"

**Cause:** First run and GitHub is unreachable.

**Solution:** Manually download [categories.json](https://github.com/Shopify/product-taxonomy/blob/main/dist/en/categories.json) to `data/categories.json`.

### Issue: "AWS credentials are required"

**Cause:** Missing or invalid AWS credentials in `.env`.

**Solution:**
1. Verify `.env` file exists and contains valid credentials
2. Test AWS access: `aws bedrock list-foundation-models --region us-east-1`
3. Ensure IAM permissions include `bedrock:InvokeModel`

### Issue: Slow mapping performance

**Possible causes:**
- Cold start (first request after restart)
- Large number of subcategories (>40)
- Network latency to AWS Bedrock

**Solutions:**
- Enable caching (default)
- Monitor per-turn latency in logs
- Consider adjusting Nova Lite timeout settings

## License

MIT

## Acknowledgments

- [Shopify Product Taxonomy](https://github.com/Shopify/product-taxonomy) - Official Shopify category data
- [Amazon Nova Lite](https://aws.amazon.com/bedrock/nova/) - Fast LLM for semantic matching
- [Bun](https://bun.sh) - Fast JavaScript runtime
