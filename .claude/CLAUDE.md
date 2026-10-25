# Shopify Taxonomy Mapper - Project Guidelines

## Project Overview

HTTP API that maps Amazon products to Shopify's official product taxonomy using TypeSafe's **Jev** decision model (via OpenRouter's Decisions API).

**Caller:** relo, the stocking utility (`~/Projects/Nuxt/relo`, deployed on the relo Coolify instance). Its shared client is `server/utils/shopify/stm-client.ts`. It sends Keepa `product_data` (asin, title, brand, features, product_group, amazon_category_tree) to `/api/map` from store-stocking lookups, product creation and bulk recategorisation, and reports staff overrides to `/api/feedback`.

**Production URL:** https://stm.revolvetrading.com
**Tech Stack:** Bun runtime, TypeScript, Jev (OpenRouter), SQLite cache
**Deployment (2026-10-25):** prod still runs as the systemd unit `shopify-taxonomy-mapper` on the main Coolify box (lastra.us, `/home/shaun/shopify-taxonomy-mapper`, port 3001), behind a hand-written Traefik route `/data/coolify/proxy/dynamic/stm.yaml` → `http://10.0.0.1:3001`. Git push does NOT deploy it. A move into Coolify (main) via `nixpacks.toml` is planned: remove `stm.yaml` at cutover, and stopping the unit needs sudo.

**History:** until 2026-10 this used Bedrock (Nova / Claude Haiku) with multi-turn forced tool use and LLM-driven backtracking. That route is fully abandoned: no AWS SDK, no generative model anywhere. Don't reintroduce one without asking.

## Architecture

### Core Components

- **src/server.ts** - HTTP server with Bun.serve(), API endpoints, token authentication
- **src/jev-client.ts** - Stateless OpenRouter Decisions API client (retries 429/5xx, 15 s timeout)
- **src/hierarchical-mapper.ts** - `mapItem()` (beam search + keyword candidates + final comparison) and `correct()` (manual corrections)
- **src/taxonomy-loader.ts** - In-memory index of Shopify categories + BM25 `keywordSearch()`
- **src/data-fetcher.ts** - Downloads the pinned taxonomy release once (no network when the local file matches)
- **src/database.ts** - SQLite result cache, `feedback` labels table, migrations

### Data Flow

1. Request → Token validation → item fields parsed (`parseItem`) → cache key (`cacheKeyFor`: `asin:<ASIN>`, else title @ path, else path)
2. Cache hit (Jev or manual row) → returned with `cached: true`
3. Cache miss → `stateFor(item)` → beam search (one Jev request per level) → keyword candidates → order-debiased final comparison
4. Pick + score + 3 alternatives + model/mapper_version cached → response

## Critical Patterns

### Jev, not an LLM (MOST IMPORTANT)

Jev is a decision model: you send a `state` and typed questions, and it returns a probability for every option. It writes no text. Wire format:

```json
POST https://openrouter.ai/api/alpha/decisions
{"model": "typesafe/jev-1.14",
 "state": {"item": {"kind": "Amazon category path", "text": "..."}},
 "questions": {"q0": {"type": "choice", "instructions": "...", "criteria": {"Electronics": {"what": "Electronics", "includes": ["Audio", "..."]}}}}}
```

The answer is `answers.q0.probabilities` (option name → p). Option names are taxonomy names verbatim, so there is no output parsing or name matching. The model can only return a listed option.

**Rules that came from measurement (see the jev skill and https://docs.typesafe.ai/model-jaggedness/jev-1.13):**
- **Facts go in `state`; instructions hold only the question.** The item lives at `state.item`; instructions point at it with backticked paths.
- **One question per open beam path, all in one request.** Jev evaluates questions in parallel against one read of the state, so five questions cost about what one does.
- **Child hints matter.** Options with subcategories are `{what, includes: [first 20 grandchildren]}`. With only 6 hints, reading glasses missed "Vision Care" (it sits under Personal Care). A single-child node skips the request only above `MIN_STOP_LEVEL`, where there's no stop option.
- **Jev reads literally.** "Industrial & Scientific > … > Calipers" puts p=1.00 on "Business & Industrial" at level 1. The final comparison recovers it now, but literal word overlap with Amazon department names is still the main way paths go wrong.
- **First-option bias exists.** Level questions send options in taxonomy order. The final comparison is asked in both orders and averaged.
- **Not fully deterministic.** Identical calls differ by ~0.02, and near-tied cases (separation ≈ 1.0, e.g. "iPad case") can flip between runs. The result cache makes answers stable after the first call.
- **The version is pinned** (`typesafe/jev-1.14`, overridable via `JEV_MODEL`). Re-run `bun run eval` and a `bun run compare` pilot before moving it. Moving from 1.13 to 1.14 changed about 12% of answers, mostly for the better.

### Map the product, not the category path

Measured on 600 random relo products (2026-10-25): Amazon category trees from Keepa are often shallow ("Clothing, Shoes & Jewelry > Women") or don't describe the product ("Suitcases" for luggage-wheel covers, "Incandescent Bulbs" for a bulb-changer pole). Mapping with title + brand + product group + bullets + category path changed 18% of answers even where the category-only score was ≥0.9, and was better in about 20 of 22 sampled changes. Adding brand and bullets on top of title + category changed 8% more, about 11 better / 3 worse. So `stateFor()` sends every field it has. A category path alone is only used when there's no title. A "category first, product only when ambiguous" router was considered and rejected on this evidence.

Product-level scores run lower than category-only ones (mean 0.83 vs 0.88). The category-only scores were overconfident.

### Beam Search + Final Comparison

In `hierarchical-mapper.ts` (`classify()`):
- `BEAM_WIDTH = 5` open paths, `POOL_SIZE = 8` finished candidates, `KEYWORD_CANDIDATES = 5`, `HINT_COUNT = 20`, `MIN_STOP_LEVEL = 2`, `MAX_DEPTH = 10`.
- **Each level:** every open path asks "which subcategory of `<path>`?", all in one request. From level 2 down (e.g. `Home & Garden > Decor > Picture Frames`), the options also include `None of these: <node> in general`, so general inputs can end on a non-leaf. Offering it higher up gave answers that were too broad.
- **Finished paths leave the beam** (leaves, or stops) and go into a pool instead of competing with open paths. The path score is a geometric mean (`exp(sum log p / decisions)`), so without the pool a run of middling steps pushed out a short correct path with one hard step. Example: dome camera → TV Mounts, because Cameras & Optics got only 4% at level 1.
- **Keyword candidates:** `TaxonomyLoader.keywordSearch()` (BM25 over category names) adds its top 5 hits to the final comparison. For Amazon paths it uses only the last two segments. This reaches categories the walk pruned early. Example: "Smart Watch…" → Apparel & Accessories > Jewelry > Smart Watches, which Jev rules out at level 1. Noise hits ("PETG Refill" → Lipstick Refills) lose the comparison.
- **Final comparison:** one choice question over the beam and keyword candidates, by full path ("most specific category that is still correct"). It is asked twice in the same request, forward and reversed, and the probabilities are averaged to cancel first-option bias. The averaged winning probability is the result's `score`. `path_score` is also returned on fresh beam results for calibration work (not exposed by the API).
- A single-child node is a real decision once the stop option exists. Picture Frames' only child is Digital Photo Frames, so auto-advancing made "Picture Frames" unreachable.
- These replace the old "None of these match" backtracking and invalid-name guards. Don't add them back.
- **Tried and rejected (2026-10-25):** two-level subtree hints (bigger requests, broke a guard case), an Amazon-department note in state, reserving beam slots per vertical, and confidence back-off to the parent. None helped once pool + final comparison existed.
- **Jev-native redesigns also tested and rejected (2026-10-25, 293 production rows, diffed against the current design):**
  - *Flat route → pick → compare.* Level 1 has only 218 nodes, so one 218-way route question picks branches, then each branch's whole subtree is flattened into ≤250-option questions in one request (3 requests total). It fixed the structural misroutes, including grilling utensils → Outdoor Grill Accessories. But it lost precision inside the huge lists (Tabasco → Starter Cultures, the Febreze plug-in refill lost Air Fresheners), and scored about 7 better / 10 worse at 2.2× the cost.
  - *Start the walk with the 218-way level-1 question* instead of 26 verticals. About 5 better / 5 worse, at 50% more tokens.
  - Conclusion: the walk's small steps are more precise than big flat choices. Remaining errors are mostly inputs that don't contain the answer, so the next lever is richer input, not question layout.
- **Known weak spots:** grilling utensils ("Grilling & Barbecue Utensils" never reaches Outdoor Grill Accessories; lands broad, scored low), and inputs too vague for anyone ("Salmas", "Mats"). Jev sends gibberish to `Uncategorized`.

**Confidence bands** (`HIGH_SCORE = 0.9`, `MEDIUM_SCORE = 0.75`, applied to the final-comparison probability) are **provisional**, from the 2026-10-25 pilots. Recalibrate them against owner-written labels, never against another model's verdicts. In the pilots, wrong answers clustered below 0.65.

### Authentication

`/api/map-category` and `/api/map-product` require Bearer token auth (`API_ACCESS_TOKEN`). `/api/search`, `/api/category/:id` and `/health` are open.

```typescript
function requireToken(req: Request): Response | null {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  return token === API_ACCESS_TOKEN ? null : unauthorized();
}
```

Token stored in `.env` (not committed). Generate with: `openssl rand -hex 32`

### Environment Variables

**Required:**
- `OPENROUTER_API_KEY` - OpenRouter key (locally: `~/.config/openrouter.env`)
- `API_ACCESS_TOKEN` - Bearer token for API auth

**Optional:**
- `JEV_MODEL` - Default: `typesafe/jev-1.14`
- `HTTP_PORT` - Default: 3001

### Taxonomy Data Management

**On startup:** read the `"version"` at the top of `data/categories.json` (first 512 bytes, no full parse). If it equals the pinned release, there's no network call. Otherwise download the release; if GitHub is unreachable, keep the local file.

**GitHub source:** `Shopify/product-taxonomy` at the release tag in `TAXONOMY_RELEASE` (`v2026-08`) → `dist/en/categories.json`. Don't point it at `main`: that's the unstable taxonomy, whose IDs can change before release. When bumping the release, migrate cached `node_id`s using `dist/en/integrations/shopify/shopify_<old>_to_shopify_<new>.json`. (v2026-08 and 2026-11-unstable have identical category sets, so the pin changed no answers.)

### Result Cache

**SQLite in `data/mappings.db`:**
- Key column `amazon_category` (legacy name; holds any key) = `cacheKeyFor(item)` normalized via `trim().toLowerCase().replace(/\s+/g, ' ')`. Title-only and category-only keys match the rows the legacy endpoints wrote.
- Permanent until deleted. A cache hit returns `cached: true, turns: 0`.
- Columns: `score` (null for manual and Nova rows), `alternatives` (JSON), `created_by IN ('llm', 'jev', 'manual')`, `model`, `mapper_version`. Bump `MAPPER_VERSION` in `hierarchical-mapper.ts` when a change alters answers, so older rows can be found and re-mapped cheaply.
- `correct()` / `POST /api/feedback` overwrite the item's row with a `manual` one and append to `feedback` (input_key, node_id, previous_node_id, item JSON). The feedback table is the owner-written label set: use it to calibrate `HIGH_SCORE` / `MEDIUM_SCORE`.
- `llm` rows are Nova-era mappings. A fresh production DB never has them: the 2026-05 migration flushes old caches.

**Migrations** live in `runMigrations()` and are recorded in `schema_migrations`. SQLite can't alter CHECK constraints, so schema changes to the mappings table rebuild it (rename → create from `TABLE_DDL` → copy → drop → recreate index) inside a transaction.

## File Structure

```
shopify-taxonomy-mapper/
├── src/
│   ├── server.ts              # HTTP server + API routes
│   ├── jev-client.ts          # OpenRouter Decisions API client
│   ├── hierarchical-mapper.ts # Beam search over Jev choice questions
│   ├── taxonomy-loader.ts     # Category index + keyword search
│   ├── data-fetcher.ts        # Pinned taxonomy release download
│   ├── database.ts            # SQLite result cache, feedback labels, migrations
│   ├── ids.ts / errors.ts     # Small helpers
│   └── types.ts               # TypeScript definitions
├── eval/
│   ├── iterate.ts             # bun run eval: accuracy, latency, Jev spend
│   ├── compare-cache.ts       # bun run compare: Jev vs a Nova-era cache (outputs stay outside the repo)
│   ├── counting-client.ts     # JevClient subclass that tallies requests and cost
│   └── test-cases.ts          # 20 adjudicated real-inventory cases
├── data/                      # categories.json + mappings.db (auto-created, not committed)
├── nixpacks.toml              # Coolify build
├── install-service.sh         # Systemd installer
└── README.md                  # API documentation
```

## Development Workflow

```bash
bun run dev          # Watch mode
bun start            # Run (no build step: Bun runs the TypeScript directly)
bun run type-check   # tsc over src/ and eval/ (noEmit)
bun run lint         # eslint --fix over src/
bun run eval         # Run the 20 adjudicated cases (needs OPENROUTER_API_KEY; ~$0.015)
bun run compare <db> --out <dir> --sample 100 --seed 1   # Re-map rows from a Nova-era mappings.db copy and compare
```

`bun run eval` is the gate for any change to the mapper, hints, beam width, or Jev version. Current baseline (2026-10-25, Jev 1.14 + pool + stop + keyword candidates + order-debiased final comparison): **20/20 correct** (16 best leaf, 4 acceptable), 1.5 s mean, 2.4 s p95, $0.00083/mapping. The first plain-beam version scored 18/20. On real production rows, each step was checked by diffing against the previous version on a fresh 100-row sample (`compare` with a new `--seed`). The keyword/order/1.14 step changed 14 of 100 answers: about 11 better, none worse. For comparison on the same cases, Nova 2 Lite scored 16/20 at 4.0 s mean / 9.8 s p95 / ~$0.0035, and Nova Pro scored 17/20.

### Testing Locally

```bash
bun start

curl -X POST http://localhost:3001/api/map \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"asin": "B0TEST", "title": "Apple AirPods Pro", "brand": "Apple", "amazon_category_tree": [{"name": "Electronics"}, {"name": "Headphones"}]}'
```

## API Endpoints

Full reference in README.md.

- `POST /api/map`: item fields `asin`, `title`, `brand`, `features[]`, `product_group`, `amazon_category_tree[{name}]` (or an `amazon_category` string); needs a title or a category. Returns `node_id`, `full_name`, `confidence`, `score`, `alternatives[3]`, `source` (jev | manual | llm), `cached`, `unmapped` (pick is Uncategorized `na`), `turns`.
- `POST /api/feedback`: same item fields + `node_id` (node id or any taxonomy GID, including relo's `ProductTaxonomyNode`). Writes a manual row and a feedback label.
- `POST /api/map-category` / `POST /api/map-product`: legacy single-field wrappers around `mapItem()`. Remove once relo's `stm-product-mapping` branch is live.
- `GET /api/search?q=` (BM25 keyword search), `GET /api/category/:id`, `GET /health` (model, taxonomy version, cache stats incl. feedback count) are open.

## Common Issues and Solutions

### Issue: "Jev request failed (4xx)"
Bad or missing `OPENROUTER_API_KEY`, or out of OpenRouter credit. 429/5xx are already retried 3× with backoff.

### Issue: A category maps wrong
Run `bun run eval` first to get a baseline. Then inspect the per-level probabilities: the log shows the leading path per level. Typical causes are literal word overlap between the input and a vertical name, or a missing hint. Fix it in the question design (hints, instructions, state), not with string-matching hacks.

### Issue: Taxonomy data not available
First run with GitHub unreachable. Manually download categories.json to `data/categories.json`.

### Issue: 401 Unauthorized
Check that `.env` contains `API_ACCESS_TOKEN` and the header is `Authorization: Bearer <token>`.

### Issue: Systemd service won't start (status=226/NAMESPACE)
`install-service.sh` uses relaxed settings (no ProtectSystem/ProtectHome) for Bun compatibility.

## Code Style and Conventions

- Explicit types for public APIs. Never widen to `any`/`unknown` to silence the compiler.
- Validate required env vars at startup with a helpful message.
- Logging format:

```
[MAPPING] "Apple AirPods Pro"
  [Turn 1] 1 question(s): 312ms
    └─ Leading open path: Electronics (1.000)
  ...
  [Turn 7] 1 question(s): 280ms
    └─ Final pick: Electronics > ... > In-Ear Headphones (0.990 of 8 candidates)
[COMPLETE] Apple AirPods Pro -> Electronics > ...
  ├─ Turns: 7
  ├─ Score: 0.990 (high), path 0.993
  └─ Time: 1840ms
```

## Git Commit Guidelines

```
Brief description of change (imperative mood)

- Bullet point details
- What changed and why
- Any breaking changes
```

## Important Notes

- **Never commit `.env`** or **`data/`**
- **No generative model**: mapping is Jev beam search only
- **Relo is the only caller**: API changes need a matching change in relo's `stm-client.ts`
- **Run `bun run eval`** before shipping mapper or model-version changes
- **Auto-create directories**: don't assume `data/` exists
- **Check logs**: `journalctl` (systemd) or the Coolify app logs
