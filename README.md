# Shopify Taxonomy Mapper

HTTP API that maps Amazon products to Shopify's official product taxonomy, using [TypeSafe's Jev](https://docs.typesafe.ai) decision model. Send what you know about a product (title, brand, feature bullets, Amazon category path) and get a Shopify category, a score, and runner-up alternatives.

## Features

- **Maps the product, not just its category path**: on real inventory, title + brand + bullets beat the Amazon category path alone, which is often shallow ("Clothing, Shoes & Jewelry > Women") or describes something else ("Suitcases" for luggage-wheel covers)
- **Beam search over the taxonomy** plus keyword candidates and an order-debiased final comparison (see How It Works)
- **Scored answers with alternatives**: a 0-1 score, `high` / `medium` / `low` confidence, and the next 3 candidates
- **Corrections loop**: `POST /api/feedback` stores a person's choice; it's served for that product from then on and kept as a label
- **Pinned taxonomy release**: 14,606 Shopify categories from a stable release, downloaded once
- **SQLite result cache**: keyed by ASIN when given; repeat lookups return in milliseconds
- **Fast and cheap**: ~1.3 s and ~$0.0008 per uncached mapping

## How It Works

Jev doesn't generate text. It answers typed questions with a probability for every option. The mapper exploits that:

1. **Level 1**: one choice question over the 26 top-level verticals. Each option lists up to 20 of its subcategories so the model can see what a branch holds.
2. **Each later level**: every surviving path asks "which subcategory of `<path>` fits this item?". All paths' questions go in **one** request, which Jev evaluates in parallel.
3. **Stopping early**: from three levels deep, each question also offers "none of these, this category in general", so a general input like "Picture Frames" can end on a non-leaf category.
4. **Pruning**: open paths are ranked by the geometric mean of their edge probabilities, and the top 5 survive. Paths that finish (at a leaf, or by stopping) move to a candidate pool instead of competing for those 5 slots.
5. **Keyword candidates**: a keyword search over the 14,000 category names adds its top 5 hits, catching categories the walk pruned early. Smart Watches, for example, sits under Apparel & Accessories > Jewelry.
6. **Final comparison**: one question puts the best 8 walk candidates and the keyword hits side by side by full category path. It's asked in both option orders and averaged. The winner's probability is the mapping's `score`; the next 3 are its `alternatives`.

Every question sees the same `state`: the product's title, brand, product group, Amazon category path and up to 5 feature bullets (or just the category path when there's no title).

### Example

```
Item:    "Metal Squirrel Baffle for 4X4 Post, 17 Inch Square Bird Feeder Guard…"
         Amazon category: Patio, Lawn & Garden > Backyard Birding & Wildlife > Birds > Feeder Accessories
Result:  Home & Garden > Decor > Bird & Wildlife Feeder Accessories > Squirrel Guards
Score:   1.00 (high), 7 requests
Alternatives: Predator Guards (0.01), …
```

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime
- An [OpenRouter](https://openrouter.ai) API key (Jev is served through OpenRouter's Decisions API)

### Setup

```bash
git clone <repository-url>
cd shopify-taxonomy-mapper
bun install
cp .env.example .env   # then fill in OPENROUTER_API_KEY and API_ACCESS_TOKEN
bun start
```

On first start the server downloads the pinned taxonomy release into `data/categories.json`, then listens on `http://localhost:3001`.

## API Endpoints

`/api/map`, `/api/feedback` and the two legacy mapping endpoints require `Authorization: Bearer <API_ACCESS_TOKEN>`. Search, category and health are open.

### POST /api/map

Map a product. Every field is optional, but send a `title` or a category. Field names match Keepa's `product_data`, so a caller can pass its product record as-is.

| Field | Type | Notes |
|---|---|---|
| `asin` | string | Keys the cache. Without it, the title + category path is the key |
| `title` | string | The listing title |
| `brand` | string | |
| `features` | string[] | Feature bullets; the first 5 are used, 200 characters each |
| `product_group` | string | e.g. "Kitchen" |
| `amazon_category_tree` | `[{ "name": string }]` | Amazon category path, root first. Or send `amazon_category` as a `"A > B > C"` string |

```bash
curl -X POST http://localhost:3001/api/map \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"asin": "B0DNMND41W", "title": "Metal Squirrel Baffle for 4X4 Post…", "brand": "…",
       "amazon_category_tree": [{"name": "Patio, Lawn & Garden"}, {"name": "Birds"}, {"name": "Feeder Accessories"}]}'
```

```json
{
  "node_id": "hg-3-7-7",
  "full_name": "Home & Garden > Decor > Bird & Wildlife Feeder Accessories > Squirrel Guards",
  "confidence": "high",
  "score": 0.998,
  "alternatives": [
    { "node_id": "hg-3-7-6", "full_name": "Home & Garden > Decor > Bird & Wildlife Feeder Accessories > Predator Guards", "score": 0.01 }
  ],
  "source": "jev",
  "cached": false,
  "unmapped": false,
  "turns": 7
}
```

**Response fields:**

| Field | Meaning |
|---|---|
| `node_id` | Shopify taxonomy ID, without the GID prefix |
| `full_name` | Full category path |
| `score` | Probability Jev gave this category in the final comparison, 0-1. `null` for manual corrections and Nova-era rows |
| `confidence` | `high` (score ≥ 0.9), `medium` (≥ 0.75), `low` otherwise. Provisional bands; treat `low` as "needs review". Manual corrections are `high` |
| `alternatives` | The next 3 categories from the final comparison, with their scores |
| `source` | `jev` (computed), `manual` (a person's correction), or `llm` (cached by the old Nova mapper) |
| `cached` | `true` when served from the cache |
| `unmapped` | `true` when the pick is Shopify's Uncategorized: nobody could place the input |
| `turns` | Jev requests made; `0` when cached |

### POST /api/feedback

Record the category a person chose for a product. Same item fields as `/api/map`, plus `node_id` (a node id like `hg-3-7`, or any taxonomy GID, e.g. `gid://shopify/ProductTaxonomyNode/hg-3-7`). The choice replaces the cached answer for that item, so `/api/map` returns it from then on with `source: "manual"`, and it's logged in the `feedback` table with the previous answer.

```json
{ "ok": true, "input_key": "asin:B0DNMND41W", "previous_node_id": "hg-3-7-7", "node_id": "hg-3-7", "full_name": "Home & Garden > Decor > Bird & Wildlife Feeder Accessories" }
```

### POST /api/map-category, POST /api/map-product (legacy)

Single-field versions kept for older callers: `{"amazon_category": "A > B > C"}` and `{"product_title": "…"}`. Same response as `/api/map`. Prefer `/api/map` with every field you have.

### GET /api/search

Keyword search over category names (no model involved).

```bash
curl "http://localhost:3001/api/search?q=smart%20watch&limit=5"
```

### GET /api/category/:id

Category details by node ID.

```bash
curl http://localhost:3001/api/category/ap-2-3-6
```

### GET /health

```json
{
  "status": "ok",
  "model": "typesafe/jev-1.14",
  "taxonomy_version": "2026-08",
  "total_categories": 14606,
  "cache_stats": {
    "total": 42,
    "byConfidence": { "high": 30, "medium": 10, "low": 2 },
    "bySource": { "jev": 40, "manual": 2 },
    "feedback": 2
  }
}
```

## Data Management

### Taxonomy

The taxonomy is pinned to a stable Shopify release (`TAXONOMY_RELEASE` in `src/data-fetcher.ts`, currently `v2026-08`). On startup the server reads the version at the top of `data/categories.json`; if it matches, there's no network call. Otherwise it downloads the release from [Shopify's GitHub](https://github.com/Shopify/product-taxonomy), keeping the local copy if GitHub is unreachable. It doesn't use `main`, because unstable category IDs can change before Shopify ships them.

### Result cache

Results are cached permanently in `data/mappings.db`, with the model and mapper version that produced them. Keys are normalized (`trim`, lowercase, collapse whitespace). A product with an ASIN is keyed `asin:<ASIN>`; otherwise title + category path. Manual corrections overwrite the row for their key.

```bash
rm data/mappings.db                     # clear everything
sqlite3 data/mappings.db "DELETE FROM amazon_shopify_category_mappings WHERE created_by = 'jev' AND mapper_version != '2026-10-25'"   # drop rows from an older mapper
sqlite3 data/mappings.db "SELECT * FROM feedback ORDER BY created_at DESC LIMIT 20"   # recent corrections
```

## Development

```bash
bun run dev          # watch mode
bun start            # run
bun run type-check   # tsc over src/ and eval/
bun run lint         # eslint --fix over src/
bun run eval         # accuracy harness: 20 adjudicated real-inventory cases
bun run compare <mappings.db copy> --out <dir> --sample 100   # re-map cached rows and compare
```

There's no build step: Bun runs the TypeScript directly. `bun run eval` runs the mapper in-process against `eval/test-cases.ts` and prints per-case verdicts, accuracy, latency, and Jev spend. Run it after changing the mapper or the Jev version.

### Project structure

```
src/
├── server.ts              # HTTP server and routes
├── hierarchical-mapper.ts # Beam search over Jev choice questions
├── jev-client.ts          # OpenRouter Decisions API client
├── taxonomy-loader.ts     # In-memory category index + keyword search
├── data-fetcher.ts        # Pinned taxonomy release download
├── database.ts            # SQLite result cache, corrections, migrations
└── types.ts               # Shared types
eval/
├── iterate.ts             # bun run eval
├── compare-cache.ts       # bun run compare
├── counting-client.ts     # Request/cost tally for eval scripts
└── test-cases.ts          # Adjudicated cases
```

## Deployment

### Coolify (Dockerfile)

The `Dockerfile` builds on the official `oven/bun` image and runs `bun src/server.ts` on port 3001. In Coolify, use the Dockerfile build pack, set `OPENROUTER_API_KEY` and `API_ACCESS_TOKEN`, mount a persistent volume at `/app/data` (taxonomy + cache), and point the health check at `/health`.

### Systemd

```bash
sudo ./install-service.sh
sudo systemctl start shopify-taxonomy-mapper
sudo journalctl -u shopify-taxonomy-mapper -f
```

The installer reads secrets from `.env` in the project directory.

### Environment variables

| Variable | Required | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | |
| `API_ACCESS_TOKEN` | yes | generate with `openssl rand -hex 32` |
| `JEV_MODEL` | no | `typesafe/jev-1.14` (pinned) |
| `HTTP_PORT` | no | `3001` |

## Troubleshooting

**"OpenRouter API key is required"**: `OPENROUTER_API_KEY` is missing from the environment.

**"Jev request failed (4xx)"**: check the key and OpenRouter credit. 429s and 5xx are retried up to three times automatically.

**"Taxonomy data not available"**: first run with GitHub unreachable. Download [categories.json](https://github.com/Shopify/product-taxonomy/blob/main/dist/en/categories.json) to `data/categories.json`.

**401 Unauthorized**: the `Authorization: Bearer <token>` header doesn't match `API_ACCESS_TOKEN`.

## License

MIT

## Acknowledgments

- [Shopify Product Taxonomy](https://github.com/Shopify/product-taxonomy)
- [TypeSafe Jev](https://docs.typesafe.ai)
- [Bun](https://bun.sh)
