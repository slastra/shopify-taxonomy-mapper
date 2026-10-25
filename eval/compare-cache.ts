/**
 * Re-map inputs from a Nova-era cache DB with the Jev mapper and compare.
 *
 * Reads a copy of a production mappings.db (never the live one), samples rows
 * stratified by Nova's confidence, runs each through HierarchicalMapper with a
 * throwaway cache, and classifies how Jev's answer relates to Nova's.
 *
 * Use:
 *   bun run compare <nova-db> --out <dir> [--sample 100] [--seed 1] [--concurrency 4]
 *
 * Omit --sample to re-map every row. Outputs results.json and disagreements.md
 * into --out. Production inputs are inventory data: keep --out outside the repo.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from 'util';
import { TaxonomyLoader } from '../src/taxonomy-loader.js';
import { MappingCache } from '../src/database.js';
import { HierarchicalMapper } from '../src/hierarchical-mapper.js';
import { CountingJevClient } from './counting-client.js';
import { errMessage } from '../src/errors.js';

type Stratum = 'high' | 'medium' | 'low' | 'bailout';
type Relation = 'same' | 'jev-deeper' | 'nova-deeper' | 'same-vertical' | 'different' | 'nova-stale' | 'error';

interface NovaRow {
  amazon_category: string;
  shopify_category_id: string;
  shopify_full_name: string;
  confidence: 'high' | 'medium' | 'low';
}

interface Row {
  input: string;
  kind: 'category' | 'product';
  stratum: Stratum;
  nova: { node_id: string; full_name: string; confidence: string };
  jev: { node_id: string; full_name: string; confidence: string; score: number | null; path_score: number | null } | null;
  relation: Relation;
  ms: number;
  error?: string;
}

// Pilot strata: oversample Nova's low-confidence answers and bail-outs, where
// disagreement is most informative. Scaled proportionally for other --sample sizes.
const STRATUM_SHARE: Record<Stratum, number> = { high: 0.5, medium: 0.1, low: 0.3, bailout: 0.1 };

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    sample: { type: 'string' },
    seed: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
  },
});

const novaDbPath = positionals[0];
if (!novaDbPath || !values.out) {
  console.error('Usage: bun run compare <nova-db> --out <dir> [--sample 100] [--seed 1] [--concurrency 4]');
  process.exit(1);
}
const outDir = values.out;
const sampleSize = values.sample ? Number(values.sample) : null;
const concurrency = Number(values.concurrency);

// mulberry32: tiny seeded PRNG so a given --seed always picks the same rows.
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stratumOf(row: NovaRow): Stratum {
  return row.shopify_full_name.includes(' > ') ? row.confidence : 'bailout';
}

function selectRows(rows: NovaRow[]): NovaRow[] {
  if (sampleSize === null) return rows;
  const random = seededRandom(Number(values.seed));
  const picked: NovaRow[] = [];
  for (const stratum of Object.keys(STRATUM_SHARE) as Stratum[]) {
    const pool = rows.filter(r => stratumOf(r) === stratum);
    picked.push(...shuffle(pool, random).slice(0, Math.round(sampleSize * STRATUM_SHARE[stratum])));
  }
  return picked;
}

const vertical = (fullName: string) => fullName.split(' > ')[0];

function relate(taxonomy: TaxonomyLoader, nova: NovaRow, jevId: string): Relation {
  const novaNode = taxonomy.getCategory(nova.shopify_category_id);
  const jevNode = taxonomy.getCategory(jevId);
  if (!novaNode) return 'nova-stale';
  if (!jevNode) return 'error';
  if (novaNode.id === jevNode.id) return 'same';
  if (jevNode.full_name.startsWith(`${novaNode.full_name} > `)) return 'jev-deeper';
  if (novaNode.full_name.startsWith(`${jevNode.full_name} > `)) return 'nova-deeper';
  return vertical(novaNode.full_name) === vertical(jevNode.full_name) ? 'same-vertical' : 'different';
}

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
}

// --- load ---
const novaDb = new Database(novaDbPath, { readonly: true });
const allRows = novaDb.query<NovaRow, []>(`
  SELECT amazon_category, shopify_category_id, shopify_full_name, confidence
  FROM amazon_shopify_category_mappings
  ORDER BY amazon_category
`).all();
novaDb.close();

const taxonomy = new TaxonomyLoader();
await taxonomy.load();

const scratchDbPath = join(tmpdir(), `compare-cache-${process.pid}.db`);
const cache = new MappingCache();
cache.connect(scratchDbPath);
const client = new CountingJevClient();
const mapper = new HierarchicalMapper(taxonomy, cache, client);

const selected = selectRows(allRows);
const realLog = console.log;
realLog(`Re-mapping ${selected.length} of ${allRows.length} rows with ${mapper.getModelId()} (concurrency ${concurrency})...`);
console.log = () => {};

// --- run ---
const results: Row[] = new Array(selected.length);
let next = 0;
let done = 0;

async function worker(): Promise<void> {
  while (next < selected.length) {
    const i = next++;
    const nova = selected[i];
    const kind = nova.amazon_category.includes(' > ') ? 'category' : 'product';
    const base = {
      input: nova.amazon_category,
      kind,
      stratum: stratumOf(nova),
      nova: { node_id: nova.shopify_category_id, full_name: nova.shopify_full_name, confidence: nova.confidence },
    } as const;
    const start = Date.now();
    try {
      const r = kind === 'category' ? await mapper.mapCategory(nova.amazon_category) : await mapper.mapProduct(nova.amazon_category);
      results[i] = {
        ...base,
        jev: { node_id: r.node_id, full_name: r.full_name, confidence: r.confidence, score: r.score, path_score: r.path_score ?? null },
        relation: relate(taxonomy, nova, r.node_id),
        ms: Date.now() - start,
      };
    } catch (e) {
      results[i] = { ...base, jev: null, relation: 'error', ms: Date.now() - start, error: errMessage(e) };
    }
    if (++done % 25 === 0) realLog(`  ${done}/${selected.length}`);
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
  console.log = realLog;
  await cache.close();
  rmSync(scratchDbPath, { force: true });
}

// --- report ---
const RELATIONS: Relation[] = ['same', 'jev-deeper', 'nova-deeper', 'same-vertical', 'different', 'nova-stale', 'error'];

function tally(rows: Row[]): string {
  const counts = RELATIONS.map(rel => rows.filter(r => r.relation === rel).length);
  const agree = counts[0] + counts[1] + counts[2];
  return `${String(rows.length).padStart(5)}  ${counts.map(c => String(c).padStart(6)).join('')}   ${(100 * agree / rows.length).toFixed(0).padStart(3)}%`;
}

function section(title: string, groups: Map<string, Row[]>): void {
  console.log(`\n${title}`);
  console.log(`${''.padEnd(28)}${'n'.padStart(5)}  ${['same', 'jev+', 'nova+', 'sameV', 'diff', 'stale', 'err'].map(h => h.padStart(6)).join('')}   path-agree`);
  for (const [key, rows] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${key.slice(0, 27).padEnd(28)}${tally(rows)}`);
  }
}

function groupBy(key: (r: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const r of results) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return groups;
}

console.log(`\n${'All'.padEnd(28)}${tally(results)}`);
section('By Nova stratum', groupBy(r => r.stratum));
section('By input kind', groupBy(r => r.kind));
section('By Jev vertical', groupBy(r => r.jev ? vertical(r.jev.full_name) : '(error)'));

type ScoreField = 'score' | 'path_score';
const scores = (rows: Row[], field: ScoreField) => rows.map(r => r.jev?.[field]).filter((s): s is number => s != null).sort((a, b) => a - b);
for (const field of ['score', 'path_score'] as const) {
  console.log(`\nJev ${field} (p25 / median / p75)`);
  for (const [label, rows] of [['same', results.filter(r => r.relation === 'same')], ['disagree', results.filter(r => r.relation !== 'same' && r.jev)]] as const) {
    const s = scores(rows, field);
    console.log(`  ${label.padEnd(10)} n=${String(s.length).padStart(4)}   ${percentile(s, 0.25).toFixed(2)} / ${percentile(s, 0.5).toFixed(2)} / ${percentile(s, 0.75).toFixed(2)}`);
  }
}

const latencies = results.map(r => r.ms).sort((a, b) => a - b);
console.log(`\nLatency: median ${percentile(latencies, 0.5)}ms, p95 ${percentile(latencies, 0.95)}ms`);
console.log(`Jev cost: $${client.cost.toFixed(4)} total, $${(client.cost / results.length).toFixed(5)}/mapping, ${client.requests} requests`);

// --- files ---
mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'results.json'), JSON.stringify(results, null, 2));

const cell = (s: string) => s.replace(/\|/g, '\\|');
const disagreements = results.filter(r => r.relation !== 'same');
const md = [
  `# Jev vs Nova disagreements (${disagreements.length} of ${results.length})`,
  '',
  '| # | Stratum | Kind | Input | Nova | Jev | Relation |',
  '|---|---|---|---|---|---|---|',
  ...disagreements.map((r, i) => `| ${i + 1} | ${r.stratum} | ${r.kind} | ${cell(r.input.slice(0, 120))} | ${cell(r.nova.full_name)} (${r.nova.confidence}) | ${r.jev ? `${cell(r.jev.full_name)} (${r.jev.score?.toFixed(2)})` : cell(r.error ?? '')} | ${r.relation} |`),
  '',
].join('\n');
await Bun.write(join(outDir, 'disagreements.md'), md);
console.log(`\nWrote ${join(outDir, 'results.json')} and ${join(outDir, 'disagreements.md')}`);
