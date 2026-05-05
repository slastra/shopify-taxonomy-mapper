/**
 * In-process prompt iteration harness.
 *
 * Runs the 20 adjudicated test cases through HierarchicalMapper directly
 * (no HTTP, no server restart). Scores each result against the case's `right`
 * and `acceptable` patterns. Prints per-case verdicts plus aggregate accuracy,
 * turn count, and latency.
 *
 * Use:
 *   bun eval/iterate.ts
 *
 * Iterate by editing src/hierarchical-mapper.ts and re-running.
 */

import { TaxonomyLoader } from '../src/taxonomy-loader.js';
import { MappingCache } from '../src/database.js';
import { HierarchicalMapper } from '../src/hierarchical-mapper.js';
import { NovaLiteClient } from '../src/nova-client.js';
import { trackTokens } from './instrument.js';
import { TEST_CASES, type TestCase } from './test-cases.js';
import { errMessage } from '../src/errors.js';
import { rmSync } from 'fs';

const taxonomy = new TaxonomyLoader();
await taxonomy.load();

const dbPath = '/tmp/iterate-cache.db';
rmSync(dbPath, { force: true });
const cache = new MappingCache();
cache.connect(dbPath);

const client = new NovaLiteClient();
const { turns, reset: resetTurns } = trackTokens(client);
const mapper = new HierarchicalMapper(taxonomy, cache, client);

// Silence per-turn mapper logs; keep summary output clean.
const realLog = console.log;
console.log = () => {};

interface CaseResult {
  case: TestCase;
  ok: boolean;
  full_name: string;
  verdict: 'right' | 'acceptable' | 'wrong' | 'error';
  ms: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  error?: string;
}

function adjudicate(c: TestCase, fullName: string): 'right' | 'acceptable' | 'wrong' {
  for (const r of c.right) if (r.test(fullName)) return 'right';
  for (const r of c.acceptable) if (r.test(fullName)) return 'acceptable';
  return 'wrong';
}

const results: CaseResult[] = [];

try {
  for (const c of TEST_CASES) {
    resetTurns();
    const start = Date.now();
    try {
      const r = c.mode === 'category' ? await mapper.mapCategory(c.input) : await mapper.mapProduct(c.input);
      const ms = Date.now() - start;
      const verdict = adjudicate(c, r.full_name);
      const totals = turns.reduce(
        (a, t) => ({
          input: a.input + t.inputTokens,
          output: a.output + t.outputTokens,
          read: a.read + t.cacheReadTokens,
          write: a.write + t.cacheWriteTokens,
        }),
        { input: 0, output: 0, read: 0, write: 0 },
      );
      results.push({
        case: c, ok: true, full_name: r.full_name, verdict, ms,
        turns: r.turns ?? turns.length,
        inputTokens: totals.input, outputTokens: totals.output,
        cacheReadTokens: totals.read, cacheWriteTokens: totals.write,
      });
    } catch (e) {
      results.push({
        case: c, ok: false, full_name: '', verdict: 'error',
        ms: Date.now() - start, turns: turns.length,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        error: errMessage(e),
      });
    }
  }
} finally {
  console.log = realLog;
  await cache.close();
  rmSync(dbPath, { force: true });
}

// Per-case report
const VERDICT_GLYPH = { right: '✓', acceptable: '~', wrong: '✗', error: 'E' };

console.log('\nPer-case results:');
console.log('─'.repeat(140));
console.log(`${'verdict'.padEnd(8)}${'label'.padEnd(28)}${'turns'.padStart(6)}  ${'ms'.padStart(5)}  result`);
console.log('─'.repeat(140));
for (const r of results) {
  const v = VERDICT_GLYPH[r.verdict];
  const label = r.case.label.slice(0, 26).padEnd(28);
  const turnsStr = String(r.turns).padStart(6);
  const msStr = String(r.ms).padStart(5);
  const path = (r.full_name || r.error || '').slice(0, 90);
  console.log(`  ${v}     ${label}${turnsStr}  ${msStr}  ${path}`);
}

// Aggregate
const counts = { right: 0, acceptable: 0, wrong: 0, error: 0 };
for (const r of results) counts[r.verdict]++;
const totalCorrect = counts.right + counts.acceptable;
const meanTurns = results.reduce((s, r) => s + r.turns, 0) / results.length;
const meanMs = results.reduce((s, r) => s + r.ms, 0) / results.length;
const sortedMs = [...results].map(r => r.ms).sort((a, b) => a - b);
const medianMs = sortedMs[Math.floor(sortedMs.length / 2)];
const p95Ms = sortedMs[Math.floor(sortedMs.length * 0.95)];

const sumIn = results.reduce((s, r) => s + r.inputTokens, 0);
const sumOut = results.reduce((s, r) => s + r.outputTokens, 0);
const sumRead = results.reduce((s, r) => s + r.cacheReadTokens, 0);
const sumWrite = results.reduce((s, r) => s + r.cacheWriteTokens, 0);

console.log('\nAggregate:');
console.log('─'.repeat(60));
console.log(`Right (best leaf):   ${counts.right}/${results.length}`);
console.log(`Acceptable (close):  ${counts.acceptable}/${results.length}`);
console.log(`Wrong:               ${counts.wrong}/${results.length}`);
if (counts.error) console.log(`Error:               ${counts.error}/${results.length}`);
console.log(`─────────────────────────────`);
console.log(`Total correct:       ${totalCorrect}/${results.length} (${(100*totalCorrect/results.length).toFixed(0)}%)`);
console.log(`Right-only rate:     ${counts.right}/${results.length} (${(100*counts.right/results.length).toFixed(0)}%)`);
console.log();
console.log(`Mean turns:          ${meanTurns.toFixed(1)}`);
console.log(`Mean latency:        ${meanMs.toFixed(0)} ms`);
console.log(`Median latency:      ${medianMs} ms`);
console.log(`p95 latency:         ${p95Ms} ms`);
console.log();
console.log(`Total tokens:        in=${sumIn}  out=${sumOut}  cache_read=${sumRead}  cache_write=${sumWrite}`);

console.log('\nWrong cases (need fixing):');
for (const r of results.filter(r => r.verdict === 'wrong' || r.verdict === 'error')) {
  console.log(`  ✗ ${r.case.label}`);
  console.log(`    input:  ${r.case.input}`);
  console.log(`    got:    ${r.full_name || r.error}`);
}
