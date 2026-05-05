import { TaxonomyLoader } from '../src/taxonomy-loader.js';
import { MappingCache } from '../src/database.js';
import { HierarchicalMapper } from '../src/hierarchical-mapper.js';
import { NovaLiteClient } from '../src/nova-client.js';
import { rmSync } from 'fs';
import { errMessage } from '../src/errors.js';
import { MODEL_IDS } from '../src/models.js';
import { trackTokens } from './instrument.js';

interface Query { kind: 'product' | 'category'; text: string; }

const QUERIES: Query[] = [
  // Common consumer electronics
  { kind: 'product', text: 'Apple AirPods Pro' },
  { kind: 'product', text: 'Samsung 65" QLED 4K TV' },
  { kind: 'product', text: 'Logitech MX Master 3 Wireless Mouse' },
  { kind: 'product', text: 'Anker USB-C 100W Charger' },
  { kind: 'product', text: 'GoPro Hero 12 Black Action Camera' },
  // Apparel
  { kind: 'product', text: "Levi's 501 Original Fit Jeans" },
  { kind: 'product', text: 'Nike Air Force 1 Sneakers' },
  { kind: 'product', text: 'Patagonia Better Sweater Fleece Jacket' },
  // Home / kitchen
  { kind: 'product', text: 'KitchenAid Artisan Stand Mixer 5qt' },
  { kind: 'product', text: 'Stanley 40oz Quencher Tumbler' },
  { kind: 'product', text: 'Dyson V15 Detect Cordless Vacuum' },
  { kind: 'product', text: 'Brita Standard 10-Cup Water Pitcher' },
  // Tools / hardware
  { kind: 'product', text: 'DeWalt 20V Max Cordless Drill' },
  { kind: 'product', text: 'Stanley FatMax 25ft Tape Measure' },
  { kind: 'product', text: 'Makita Reciprocating Saw Blade Set' },
  // Sporting / outdoor
  { kind: 'product', text: 'Yeti Tundra 45 Cooler' },
  { kind: 'product', text: 'Coleman 4-Person Dome Tent' },
  { kind: 'product', text: 'Wilson Pro Staff Tennis Racket' },
  // Ambiguous / edge
  { kind: 'product', text: 'Pet Carrier for Small Dogs' },
  { kind: 'product', text: 'Yoga Mat Non-Slip 6mm Thick' },
  { kind: 'product', text: 'LED Strip Lights 16ft Color Changing' },
  { kind: 'product', text: 'Glass Food Storage Containers Set of 10' },
  // Amazon category paths
  { kind: 'category', text: 'Tools & Home Improvement > Hardware > Brackets' },
  { kind: 'category', text: 'Electronics > Headphones, Earbuds & Accessories > Earbud Headphones' },
  { kind: 'category', text: 'Sports & Outdoors > Outdoor Recreation > Camping & Hiking > Tents' },
];

interface ModelSpec { id: string; label: string; inPrice: number; outPrice: number; gold?: boolean }

const MODELS: ModelSpec[] = [
  { id: MODEL_IDS.novaMicro,    label: 'Nova Micro',      inPrice: 0.035, outPrice: 0.14 },
  { id: MODEL_IDS.novaLite,     label: 'Nova Lite v1',    inPrice: 0.06,  outPrice: 0.24 },
  { id: MODEL_IDS.novaPro,      label: 'Nova Pro (prod)', inPrice: 0.80,  outPrice: 3.20 },
  { id: MODEL_IDS.nova2Lite,    label: 'Nova 2 Lite',     inPrice: 0.30,  outPrice: 2.50 },
  { id: MODEL_IDS.claude3Haiku, label: 'Claude 3 Haiku',  inPrice: 0.25,  outPrice: 1.25 },
  { id: MODEL_IDS.haiku45,      label: 'Haiku 4.5',       inPrice: 1.00,  outPrice: 5.00, gold: true },
];

const GOLD = MODELS.find(m => m.gold)!.id;

interface RunResult {
  modelId: string;
  query: string;
  kind: 'product' | 'category';
  ok: boolean;
  node_id?: string;
  full_name?: string;
  confidence?: string;
  turns?: number;
  ms?: number;
  inTok?: number;
  outTok?: number;
  error?: string;
}

const taxonomy = new TaxonomyLoader();
await taxonomy.load();

const PER_MAPPING_TIMEOUT_MS = 90_000;

function tmpDbPathFor(modelId: string): string {
  return `/tmp/eval-${modelId.replace(/[^a-z0-9]/gi, '_')}.db`;
}

async function runOne(model: ModelSpec, q: Query): Promise<RunResult> {
  const dbPath = tmpDbPathFor(model.id);
  rmSync(dbPath, { force: true });

  const cache = new MappingCache();
  cache.connect(dbPath);

  const client = new NovaLiteClient({ modelId: model.id });
  const { turns } = trackTokens(client);
  const mapper = new HierarchicalMapper(taxonomy, cache, client);

  const start = Date.now();
  const work = q.kind === 'product' ? mapper.mapProduct(q.text) : mapper.mapCategory(q.text);
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`timeout after ${PER_MAPPING_TIMEOUT_MS}ms`)), PER_MAPPING_TIMEOUT_MS),
  );
  try {
    const r = await Promise.race([work, timeout]);
    const totalIn = turns.reduce((s, t) => s + t.inputTokens, 0);
    const totalOut = turns.reduce((s, t) => s + t.outputTokens, 0);
    return {
      modelId: model.id, query: q.text, kind: q.kind, ok: true,
      node_id: r.node_id, full_name: r.full_name, confidence: r.confidence,
      turns: r.turns, ms: Date.now() - start, inTok: totalIn, outTok: totalOut,
    };
  } catch (e) {
    const totalIn = turns.reduce((s, t) => s + t.inputTokens, 0);
    const totalOut = turns.reduce((s, t) => s + t.outputTokens, 0);
    return {
      modelId: model.id, query: q.text, kind: q.kind, ok: false,
      error: errMessage(e).slice(0, 150),
      ms: Date.now() - start, inTok: totalIn, outTok: totalOut,
    };
  } finally {
    await cache.close();
  }
}

// Silence the chatty per-turn logs from the mapper
const realLog = console.log;
console.log = () => { /* swallow */ };

const allResults: RunResult[] = [];

try {
  // Run each query across all models in parallel; sequence queries to avoid burst throttling
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    realLog(`[${i + 1}/${QUERIES.length}] ${q.text}`);
    const settled = await Promise.all(MODELS.map(m => runOne(m, q)));
    allResults.push(...settled);
    for (const r of settled) {
      const m = MODELS.find(x => x.id === r.modelId)!;
      if (r.ok) {
        realLog(`  ${m.label.padEnd(18)} ${String(r.ms).padStart(5)}ms  ${String(r.turns ?? '?').padStart(2)}t  ${(r.full_name || '').slice(0, 70)}`);
      } else {
        realLog(`  ${m.label.padEnd(18)} ERROR  ${r.error}`);
      }
    }
  }
} finally {
  console.log = realLog;
  for (const m of MODELS) {
    rmSync(tmpDbPathFor(m.id), { force: true });
  }
}

// === REPORT ===
console.log('\n' + '='.repeat(110));
console.log('SUMMARY BY MODEL');
console.log('='.repeat(110));

console.log('Model              | OK    | Avg ms  | Avg turns | Avg in tok | Avg out tok | Cost/mapping | Agree w/ Haiku 4.5');
console.log('-'.repeat(110));

for (const m of MODELS) {
  const rs = allResults.filter(r => r.modelId === m.id && r.ok);
  if (rs.length === 0) {
    console.log(`${m.label.padEnd(18)} | NO DATA`);
    continue;
  }
  const avgMs = rs.reduce((s, r) => s + (r.ms || 0), 0) / rs.length;
  const avgTurns = rs.reduce((s, r) => s + (r.turns || 0), 0) / rs.length;
  const avgIn = rs.reduce((s, r) => s + (r.inTok || 0), 0) / rs.length;
  const avgOut = rs.reduce((s, r) => s + (r.outTok || 0), 0) / rs.length;
  const cost = (avgIn * m.inPrice + avgOut * m.outPrice) / 1_000_000;

  let matched = 0, comparable = 0;
  for (const r of rs) {
    const goldRow = allResults.find(g => g.modelId === GOLD && g.query === r.query && g.ok);
    if (goldRow) {
      comparable++;
      if (goldRow.node_id === r.node_id) matched++;
    }
  }
  const pctOk = (rs.length / QUERIES.length * 100).toFixed(0);
  const pctAgree = comparable > 0 ? (matched / comparable * 100).toFixed(0) : '-';

  console.log(
    `${m.label.padEnd(18)} | ${(pctOk + '%').padEnd(5)} | ${avgMs.toFixed(0).padStart(7)} | ${avgTurns.toFixed(1).padStart(9)} | ${avgIn.toFixed(0).padStart(10)} | ${avgOut.toFixed(0).padStart(11)} | $${cost.toFixed(5).padStart(11)} | ${matched}/${comparable} (${pctAgree}%)`,
  );
}

console.log('\n' + '='.repeat(110));
console.log('PER-QUERY AGREEMENT (✓ = matches Haiku 4.5 node_id, ✗ = different, E = error)');
console.log('='.repeat(110));

const headerCells = MODELS.map(m => m.label.slice(0, 12).padStart(12)).join(' | ');
console.log('Query'.padEnd(50) + ' | ' + headerCells);
console.log('-'.repeat(110));

for (const q of QUERIES) {
  const cells = MODELS.map(m => {
    const r = allResults.find(x => x.modelId === m.id && x.query === q.text);
    if (!r) return 'no data'.padStart(12);
    if (!r.ok) return 'E'.padStart(12);
    const goldRow = allResults.find(g => g.modelId === GOLD && g.query === q.text && g.ok);
    if (!goldRow) return '?'.padStart(12);
    return (goldRow.node_id === r.node_id ? '✓' : '✗').padStart(12);
  }).join(' | ');
  console.log(q.text.slice(0, 50).padEnd(50) + ' | ' + cells);
}

console.log('\n' + '='.repeat(110));
console.log('DISAGREEMENTS (full_name shown)');
console.log('='.repeat(110));

for (const q of QUERIES) {
  const haiku45 = allResults.find(g => g.modelId === GOLD && g.query === q.text && g.ok);
  if (!haiku45) continue;
  const disagreers = MODELS.filter(m => m.id !== GOLD).filter(m => {
    const r = allResults.find(x => x.modelId === m.id && x.query === q.text && x.ok);
    return r && r.node_id !== haiku45.node_id;
  });
  if (disagreers.length === 0) continue;

  console.log(`\n"${q.text}"`);
  console.log(`  Haiku 4.5 (gold):  ${haiku45.full_name}`);
  for (const m of disagreers) {
    const r = allResults.find(x => x.modelId === m.id && x.query === q.text && x.ok)!;
    console.log(`  ${m.label.padEnd(18)} ${r.full_name}`);
  }
}

