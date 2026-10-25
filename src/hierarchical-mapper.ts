import { JevClient, type ChoiceAnswer, type ChoiceQuestion, type Criterion } from './jev-client.js';
import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';
import { stripGid } from './ids.js';
import type { Alternative, Category, Confidence, StoredMapping } from './types.js';

// Open paths kept per level. Wider beams recover from an ambiguous early pick
// (gift bags, reading glasses) at the cost of more questions per request.
const BEAM_WIDTH = 5;
// Finished candidates (by path score) that go to the final comparison.
const POOL_SIZE = 8;
// Keyword-search hits added to the final comparison alongside the beam's candidates.
const KEYWORD_CANDIDATES = 5;
// Grandchild names shown under each option so the model can see what a branch holds.
const HINT_COUNT = 20;
// Stopping at a node is offered from this level down (0 = vertical). Level 2 is
// e.g. "Home & Garden > Decor > Picture Frames"; stopping higher was too broad.
const MIN_STOP_LEVEL = 2;
// Taxonomy is 7 levels deep; this only guards against a malformed tree.
const MAX_DEPTH = 10;
const MIN_PROBABILITY = 1e-6;
// Runner-up categories returned alongside the pick.
const ALTERNATIVE_COUNT = 3;
// Feature bullets kept from a listing, and characters per bullet.
const FEATURE_LIMIT = 5;
const FEATURE_CHARS = 200;
// Shopify's "Uncategorized" node: Jev's answer for input nobody could place.
const UNCATEGORIZED_ID = 'na';

// Recorded on every cached row. Bump when a change alters answers, so rows made
// by an older mapper can be found and re-mapped.
export const MAPPER_VERSION = '2026-10-25';

// Provisional bands on the final comparison's probability, set from a 100-row
// pilot. Recalibrate against owner-written labels before relying on them.
const HIGH_SCORE = 0.9;
const MEDIUM_SCORE = 0.75;

/** What a caller knows about an item. Field names follow relo's Keepa product_data. */
export interface ItemInput {
  asin?: string;
  title?: string;
  brand?: string;
  features?: string[];
  product_group?: string;
  /** Amazon category path, e.g. "Home & Kitchen > Kitchen & Dining > ...". */
  category_path?: string;
}

export interface MappingResult extends StoredMapping {
  cached: boolean;
  /** True when the pick is Shopify's Uncategorized node. */
  unmapped: boolean;
  /** Geometric mean of the edge probabilities along the pick's path. Only on
   * fresh beam results; kept for calibration work, not returned by the API. */
  path_score?: number;
  /** Jev requests made. 0 when cached. */
  turns: number;
}

interface BeamPath {
  node: Category | null;
  logProbability: number;
  decisions: number;
  /** True when the model chose to stop here rather than descend. */
  stopped: boolean;
}

interface Candidate {
  node: Category;
  /** Null for keyword-search hits, which weren't reached by the walk. */
  pathScore: number | null;
  source: 'beam' | 'keyword';
}

/** Length-normalized so shallow and deep paths compare fairly. */
function pathScore(path: BeamPath): number {
  return path.decisions ? Math.exp(path.logProbability / path.decisions) : 1;
}

function byPathScore(a: BeamPath, b: BeamPath): number {
  return pathScore(b) - pathScore(a);
}

function confidenceFor(score: number): Confidence {
  if (score >= HIGH_SCORE) return 'high';
  if (score >= MEDIUM_SCORE) return 'medium';
  return 'low';
}

function stopOptionName(node: Category): string {
  return `None of these: ${node.name} in general`;
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Cache key for an item. A product is keyed by ASIN when it has one. Without
 * one, title-only and category-only keys match the rows written by the old
 * map-product and map-category endpoints.
 */
export function cacheKeyFor(item: ItemInput): string {
  if (hasText(item.asin)) return `asin:${item.asin.trim()}`;
  if (hasText(item.title)) return hasText(item.category_path) ? `${item.title} @ ${item.category_path}` : item.title;
  if (hasText(item.category_path)) return item.category_path;
  throw new Error('Item needs a title or a category path');
}

/** The `state` Jev reads. A listing with a title is described by every field it has. */
function stateFor(item: ItemInput): Record<string, unknown> {
  if (!hasText(item.title)) {
    return { item: { kind: 'Amazon category path', text: item.category_path } };
  }
  const listing: Record<string, unknown> = { kind: 'Amazon product listing', title: item.title };
  if (hasText(item.brand)) listing.brand = item.brand;
  if (hasText(item.product_group)) listing.product_group = item.product_group;
  if (hasText(item.category_path)) listing.amazon_category = item.category_path;
  const features = (item.features ?? []).filter(hasText).slice(0, FEATURE_LIMIT)
    .map(f => (f.length > FEATURE_CHARS ? `${f.slice(0, FEATURE_CHARS)}…` : f));
  if (features.length > 0) listing.features = features;
  return { item: listing };
}

/** Words for keyword search. Amazon paths: the last two segments say what the
 * item is; department names mislead. */
function keywordQueryFor(item: ItemInput): string {
  const tail = hasText(item.category_path) ? item.category_path.split(' > ').slice(-2).join(' ') : '';
  return [item.title ?? '', tail].join(' ').trim();
}

/**
 * Maps inputs onto the Shopify taxonomy with Jev choice questions:
 *
 * 1. Beam search. Each open path asks "which child of this node?" (all paths at
 *    a level in one request). From MIN_STOP_LEVEL down, "stay at this node" is
 *    also an option, so a general input can end on a non-leaf category.
 * 2. Finished paths (leaves, or stops) leave the beam for a pool instead of
 *    competing with longer open paths. Path-score averaging otherwise lets a run
 *    of middling steps push out a short correct path with one hard step.
 * 3. The best POOL_SIZE finished categories, plus KEYWORD_CANDIDATES keyword-search
 *    hits, are compared by full name in one final question (asked in both option
 *    orders and averaged). The winner's probability is the result's score.
 */
export class HierarchicalMapper {
  private jev: JevClient;
  private taxonomy: TaxonomyLoader;
  private cache: MappingCache;

  constructor(taxonomy: TaxonomyLoader, cache: MappingCache, jev?: JevClient) {
    this.jev = jev ?? new JevClient();
    this.taxonomy = taxonomy;
    this.cache = cache;
  }

  mapCategory(categoryPath: string): Promise<MappingResult> {
    return this.mapItem({ category_path: categoryPath });
  }

  mapProduct(productTitle: string): Promise<MappingResult> {
    return this.mapItem({ title: productTitle });
  }

  getModelId(): string {
    return this.jev.getModelId();
  }

  async mapItem(item: ItemInput): Promise<MappingResult> {
    const startTime = Date.now();
    const key = cacheKeyFor(item);

    const cached = this.cache.get(key);
    if (cached) {
      console.log(`[CACHE HIT] ${key} -> ${cached.full_name} (${cached.source}, ${Date.now() - startTime}ms)`);
      return { ...cached, cached: true, unmapped: cached.node_id === UNCATEGORIZED_ID, turns: 0 };
    }

    console.log(`[MAPPING] "${key}"`);
    const result = await this.classify(item);

    const totalTime = Date.now() - startTime;
    console.log(`[COMPLETE] ${key} -> ${result.full_name}`);
    console.log(`  ├─ Turns: ${result.turns}`);
    console.log(`  ├─ Score: ${result.score?.toFixed(3)} (${result.confidence}), path ${result.path_score?.toFixed(3)}`);
    console.log(`  └─ Time: ${totalTime}ms`);

    this.cache.save(key, result);
    return result;
  }

  /**
   * Record a person's correction. It replaces the cached answer for this item
   * (so it is served from now on) and is logged as a label for evaluation.
   */
  correct(item: ItemInput, nodeId: string): { input_key: string; previous_node_id: string | null; mapping: StoredMapping } {
    const category = this.taxonomy.getCategory(nodeId);
    if (!category) throw new Error(`Unknown category: ${nodeId}`);
    const key = cacheKeyFor(item);
    const previous = this.cache.get(key)?.node_id ?? null;
    const mapping: StoredMapping = {
      node_id: stripGid(category.id),
      full_name: category.full_name,
      confidence: 'high',
      score: null,
      alternatives: [],
      source: 'manual',
      model: null,
      mapper_version: null,
    };
    this.cache.save(key, mapping);
    this.cache.recordFeedback(key, mapping.node_id, previous, item);
    console.log(`[CORRECTION] ${key}: ${previous ?? '(none)'} -> ${mapping.node_id}`);
    return { input_key: key, previous_node_id: previous, mapping };
  }

  private childrenOf(node: Category | null): Category[] {
    if (node) return this.taxonomy.getChildren(node.id);
    return this.taxonomy.getVerticals()
      .map(v => v.rootCategory)
      .filter((c): c is Category => c !== undefined);
  }

  private canStopAt(node: Category | null): node is Category {
    return node !== null && node.level >= MIN_STOP_LEVEL;
  }

  private async ask(state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>, turn: number): Promise<Record<string, ChoiceAnswer>> {
    const turnStart = Date.now();
    const { answers } = await this.jev.decide(state, questions);
    console.log(`  [Turn ${turn}] ${Object.keys(questions).length} question(s): ${Date.now() - turnStart}ms`);
    return answers;
  }

  private async classify(item: ItemInput): Promise<MappingResult> {
    const state = stateFor(item);
    let beam: BeamPath[] = [{ node: null, logProbability: 0, decisions: 0, stopped: false }];
    const finished: BeamPath[] = [];
    let turns = 0;

    for (let depth = 0; depth < MAX_DEPTH && beam.length > 0; depth++) {
      const questions: Record<string, ChoiceQuestion> = {};
      beam.forEach((path, i) => {
        const options = this.childrenOf(path.node);
        // A lone child with no stop option is not a decision; skip the question.
        if (options.length > 1 || this.canStopAt(path.node)) {
          questions[`q${i}`] = this.buildQuestion(path.node, options);
        }
      });
      const answers = Object.keys(questions).length > 0 ? await this.ask(state, questions, ++turns) : {};

      const expanded: BeamPath[] = [];
      beam.forEach((path, i) => {
        const options = this.childrenOf(path.node);
        const answer = answers[`q${i}`];
        if (!answer) {
          expanded.push({ ...path, node: options[0] });
          return;
        }
        const extend = (node: Category | null, name: string, stopped: boolean): BeamPath => ({
          node,
          logProbability: path.logProbability + Math.log(Math.max(answer.probabilities[name] ?? 0, MIN_PROBABILITY)),
          decisions: path.decisions + 1,
          stopped,
        });
        for (const option of options) expanded.push(extend(option, option.name, false));
        if (this.canStopAt(path.node)) expanded.push(extend(path.node, stopOptionName(path.node), true));
      });

      const isFinished = (p: BeamPath) => p.stopped || this.childrenOf(p.node).length === 0;
      finished.push(...expanded.filter(isFinished));
      beam = expanded.filter(p => !isFinished(p)).sort(byPathScore).slice(0, BEAM_WIDTH);
      if (beam.length > 0) {
        console.log(`    └─ Leading open path: ${beam[0].node?.full_name} (${pathScore(beam[0]).toFixed(3)})`);
      }
    }

    // The same node can finish twice (reached as a leaf on one path, stopped at
    // on another); keep its best path.
    const candidates: Candidate[] = [];
    const addCandidate = (candidate: Candidate) => {
      if (!candidates.some(c => c.node.id === candidate.node.id)) candidates.push(candidate);
    };
    for (const path of finished.sort(byPathScore)) {
      if (candidates.length === POOL_SIZE) break;
      if (path.node) addCandidate({ node: path.node, pathScore: pathScore(path), source: 'beam' });
    }
    // Keyword hits reach categories the walk pruned early, e.g. "Smart Watches"
    // under Apparel & Accessories > Jewelry for an Electronics-looking title.
    for (const node of this.taxonomy.keywordSearch(keywordQueryFor(item), KEYWORD_CANDIDATES)) {
      addCandidate({ node, pathScore: null, source: 'keyword' });
    }
    if (candidates.length === 0) {
      throw new Error('Beam search ended without reaching a category');
    }

    // Every candidate with its probability, best first. A lone candidate is certain.
    let ranked: Array<{ candidate: Candidate; probability: number }> = [{ candidate: candidates[0], probability: 1 }];
    if (candidates.length > 1) {
      // Asked in both orders and averaged, to cancel Jev's lean toward the first option.
      const answers = await this.ask(state, {
        forward: this.buildFinalQuestion(candidates),
        reversed: this.buildFinalQuestion([...candidates].reverse()),
      }, ++turns);
      ranked = candidates
        .map(c => ({
          candidate: c,
          probability: ((answers.forward.probabilities[c.node.full_name] ?? 0) + (answers.reversed.probabilities[c.node.full_name] ?? 0)) / 2,
        }))
        .sort((a, b) => b.probability - a.probability);
    }
    const { candidate: chosen, probability: score } = ranked[0];
    console.log(`    └─ Final pick: ${chosen.node.full_name} (${score.toFixed(3)} of ${candidates.length} candidates, ${chosen.source})`);

    const alternatives: Alternative[] = ranked.slice(1, 1 + ALTERNATIVE_COUNT).map(r => ({
      node_id: stripGid(r.candidate.node.id),
      full_name: r.candidate.node.full_name,
      score: r.probability,
    }));
    const nodeId = stripGid(chosen.node.id);
    return {
      node_id: nodeId,
      full_name: chosen.node.full_name,
      confidence: confidenceFor(score),
      score,
      alternatives,
      source: 'jev',
      model: this.jev.getModelId(),
      mapper_version: MAPPER_VERSION,
      cached: false,
      unmapped: nodeId === UNCATEGORIZED_ID,
      path_score: chosen.pathScore ?? undefined,
      turns,
    };
  }

  private buildQuestion(parent: Category | null, options: Category[]): ChoiceQuestion {
    const criteria: Record<string, Criterion> = {};
    for (const option of options) {
      const grandchildren = this.taxonomy.getChildren(option.id).map(c => c.name);
      criteria[option.name] = grandchildren.length > 0
        ? { what: option.name, includes: grandchildren.slice(0, HINT_COUNT) }
        : option.name;
    }
    if (this.canStopAt(parent)) {
      criteria[stopOptionName(parent)] = `The item belongs in "${parent.full_name}" but none of the other options describes it specifically, or the item is too general to tell which one.`;
    }
    const scope = parent ? `subcategory of "${parent.full_name}"` : 'top-level product category';
    return {
      type: 'choice',
      instructions: `Which ${scope} best fits the item described in \`item\`? \`item.kind\` says whether it is an Amazon category path or a product listing title.`,
      criteria,
    };
  }

  /** Options are full category paths, in the order given. */
  private buildFinalQuestion(candidates: Candidate[]): ChoiceQuestion {
    const criteria: Record<string, Criterion> = {};
    for (const c of candidates) criteria[c.node.full_name] = c.node.full_name;
    return {
      type: 'choice',
      instructions: 'Which Shopify category is the most accurate for the item described in `item`? Prefer the most specific category that is still correct.',
      criteria,
    };
  }
}
