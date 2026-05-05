/**
 * Measure prompt-cache effectiveness.
 *
 * Runs queries sequentially (so the second+ mapping hits a warm cache for turn 1's
 * vertical list, and warm caches for any drilled-into vertical that repeats).
 * Reports per-mapping input/output/cache-read/cache-write token counts plus
 * effective $/mapping at Nova 2 Lite rates.
 */

import { TaxonomyLoader } from '../src/taxonomy-loader.js';
import { MappingCache } from '../src/database.js';
import { HierarchicalMapper } from '../src/hierarchical-mapper.js';
import { NovaLiteClient } from '../src/nova-client.js';
import { rmSync } from 'fs';
import { MODEL_IDS } from '../src/models.js';
import { trackTokens } from './instrument.js';

// Nova 2 Lite pricing (per 1M tokens)
const PRICE_IN = 0.30;
const PRICE_OUT = 2.50;
// Bedrock prompt cache for Nova: read = 90% off input, write = same as input rate (no premium).
const PRICE_CACHE_READ = PRICE_IN * 0.10;
const PRICE_CACHE_WRITE = PRICE_IN;

const QUERIES = [
  'Apple AirPods Pro',
  'Samsung 65" QLED 4K TV',
  'Sony WH-1000XM5 Headphones',
  'Logitech Webcam C920',
  'Anker USB-C 100W Charger',
  "Levi's 501 Original Fit Jeans",
  'Nike Air Force 1 Sneakers',
];

const taxonomy = new TaxonomyLoader();
await taxonomy.load();

const dbPath = '/tmp/measure-cache.db';
rmSync(dbPath, { force: true });
const cache = new MappingCache();
cache.connect(dbPath);

const client = new NovaLiteClient({ modelId: MODEL_IDS.nova2Lite });
const { turns, reset: resetTurns } = trackTokens(client);
const mapper = new HierarchicalMapper(taxonomy, cache, client);

// Silence noisy mapper logs
const origLog = console.log;
console.log = () => {};

interface MappingStats {
  query: string;
  turns: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
}
const results: MappingStats[] = [];

try {
  for (const q of QUERIES) {
    resetTurns();
    const t0 = Date.now();
    await mapper.mapProduct(q);
    const elapsed = Date.now() - t0;
    const totals = turns.reduce(
      (a, t) => ({
        in: a.in + t.inputTokens,
        out: a.out + t.outputTokens,
        cacheRead: a.cacheRead + t.cacheReadTokens,
        cacheWrite: a.cacheWrite + t.cacheWriteTokens,
      }),
      { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    );
    results.push({
      query: q, turns: turns.length, ms: elapsed,
      ...totals,
    });
  }
} finally {
  console.log = origLog;
  await cache.close();
  rmSync(dbPath, { force: true });
}

// Bedrock Nova reports `inputTokens` as ONLY the post-cachepoint fresh tokens.
// `cacheReadInputTokens` and `cacheWriteInputTokens` are separate counters.
// Total input billed (with caching)    = in + read*0.10 + write*1.0  (×PRICE_IN)
// Total input billed (without caching) = in + read + write             (×PRICE_IN)
function withCacheCost(r: { in: number; out: number; cacheRead: number; cacheWrite: number }) {
  return (
    r.in * PRICE_IN +
    r.cacheRead * PRICE_CACHE_READ +
    r.cacheWrite * PRICE_CACHE_WRITE +
    r.out * PRICE_OUT
  ) / 1_000_000;
}
function noCacheCost(r: { in: number; out: number; cacheRead: number; cacheWrite: number }) {
  return (
    (r.in + r.cacheRead + r.cacheWrite) * PRICE_IN +
    r.out * PRICE_OUT
  ) / 1_000_000;
}

// Per-mapping report
console.log('\nQuery                               | Turns | Input  | Output | CacheRead | CacheWrite | $cached  | $nocache | ms');
console.log('-'.repeat(125));
for (const r of results) {
  const cached = withCacheCost(r);
  const nocache = noCacheCost(r);
  console.log(
    `${r.query.slice(0, 35).padEnd(35)} | ${String(r.turns).padStart(5)} | ${String(r.in).padStart(6)} | ${String(r.out).padStart(6)} | ${String(r.cacheRead).padStart(9)} | ${String(r.cacheWrite).padStart(10)} | $${cached.toFixed(5)} | $${nocache.toFixed(5)} | ${r.ms}`,
  );
}

// Summary
const sumIn = results.reduce((s, r) => s + r.in, 0);
const sumOut = results.reduce((s, r) => s + r.out, 0);
const sumCacheRead = results.reduce((s, r) => s + r.cacheRead, 0);
const sumCacheWrite = results.reduce((s, r) => s + r.cacheWrite, 0);
const totalInputAllSources = sumIn + sumCacheRead + sumCacheWrite;

const totalCost = results.reduce((s, r) => s + withCacheCost(r), 0);
const baselineCost = results.reduce((s, r) => s + noCacheCost(r), 0);
const savings = (1 - totalCost / baselineCost) * 100;

console.log('\n=== TOTALS (' + results.length + ' mappings) ===');
console.log(`Total input tokens (in + read + write): ${totalInputAllSources}`);
console.log(`  - fresh (post-cachepoint):  ${sumIn}`);
console.log(`  - served from cache (90% off): ${sumCacheRead} (${(sumCacheRead / totalInputAllSources * 100).toFixed(0)}%)`);
console.log(`  - written to cache (full price): ${sumCacheWrite} (${(sumCacheWrite / totalInputAllSources * 100).toFixed(0)}%)`);
console.log(`Output tokens:         ${sumOut}`);
console.log(`Cost (with caching):   $${totalCost.toFixed(5)}`);
console.log(`Cost (no caching):     $${baselineCost.toFixed(5)}`);
console.log(`Savings:               ${savings.toFixed(1)}%`);
console.log(`Avg $/mapping (cached):    $${(totalCost / results.length).toFixed(5)}`);
console.log(`Avg $/mapping (no cache):  $${(baselineCost / results.length).toFixed(5)}`);
console.log(`\nNote: writes happen on first encounter of each unique vertical/parent. Long-running`);
console.log(`production traffic with TTL refresh (5m) reduces write share toward 0 → ~90% savings`);
console.log(`steady-state.`);
