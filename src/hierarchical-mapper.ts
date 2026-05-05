import { NovaLiteClient } from './nova-client.js';
import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';
import { stripGid } from './ids.js';

/**
 * System prompt with key disambiguation rules for Shopify's taxonomy
 */
const TAXONOMY_SYSTEM_PROMPT = `You categorize products into Shopify's taxonomy.

Key rules for Shopify's taxonomy:
- Kitchen appliances (mixers, blenders, pressure cookers, etc.) go under "Kitchen & Dining", NOT "Household Appliances"
- "Household Appliances" is for laundry machines, vacuums, air purifiers - NOT kitchen items
- Headphones and earbuds are "Audio Components", NOT "Audio Accessories"
- "Audio Accessories" is for cases, cables, stands - not the audio devices themselves

Select the category that best matches the product.`;

export interface MappingResult {
  node_id: string;
  confidence: 'high' | 'medium' | 'low';
  full_name: string;
  cached: boolean;
  turns?: number;
  /** True when navigation exhausted MAX_BACKTRACKS without reaching a leaf.
   * The returned node_id/full_name will be the deepest reached (often a
   * top-level vertical). Callers should treat as "needs manual review" rather
   * than a confident mapping. */
  unmapped?: boolean;
}

/**
 * Hierarchical category mapper using Nova Lite with multi-turn drill-down
 */
export class HierarchicalMapper {
  private nova: NovaLiteClient;
  private taxonomy: TaxonomyLoader;
  private cache: MappingCache;
  // Cached vertical option list. Static for the process lifetime once taxonomy is loaded.
  private verticalOptionsCache: ReadonlyArray<{ name: string; isLeaf: boolean; childNames: string[] }> | null = null;

  constructor(taxonomy: TaxonomyLoader, cache: MappingCache, nova?: NovaLiteClient) {
    this.nova = nova ?? new NovaLiteClient();
    this.taxonomy = taxonomy;
    this.cache = cache;
  }

  mapCategory(categoryPath: string): Promise<MappingResult> {
    return this.map(categoryPath);
  }

  mapProduct(productTitle: string): Promise<MappingResult> {
    return this.map(productTitle);
  }

  private async map(input: string): Promise<MappingResult> {
    const startTime = Date.now();

    const cached = await this.cache.getHierarchicalMapping(input);
    if (cached) {
      console.log(`[CACHE HIT] ${input} -> ${cached.full_name} (${Date.now() - startTime}ms)`);
      return { ...cached, cached: true };
    }

    console.log(`[MAPPING] "${input}"`);
    const result = await this.performGuidedNavigation(input);

    const totalTime = Date.now() - startTime;
    console.log(`[COMPLETE] ${input} -> ${result.full_name}${result.unmapped ? ' (UNMAPPED)' : ''}`);
    console.log(`  ├─ Turns: ${result.turns}`);
    console.log(`  ├─ Confidence: ${result.confidence}`);
    console.log(`  └─ Time: ${totalTime}ms (${Math.round(totalTime / (result.turns || 1))}ms/turn)`);

    // Don't cache unmapped results — future retries with cleared state may succeed.
    if (!result.unmapped) {
      await this.cache.saveHierarchicalMapping(input, result.node_id, result.confidence, result.full_name);
    }
    return { ...result, cached: false };
  }

  private getVerticalOptions(): ReadonlyArray<{ name: string; isLeaf: boolean; childNames: string[] }> {
    if (!this.verticalOptionsCache) {
      this.verticalOptionsCache = this.taxonomy.getVerticals().map(v => {
        const children = v.rootCategory ? this.taxonomy.getChildren(v.rootCategory.id) : [];
        return { name: v.name, isLeaf: false, childNames: children.map(c => c.name) };
      });
    }
    return this.verticalOptionsCache;
  }

  /**
   * Perform guided navigation through taxonomy with backtracking support
   */
  private async performGuidedNavigation(query: string): Promise<Omit<MappingResult, 'cached'>> {
    this.nova.resetConversation();

    const MAX_BACKTRACKS = 5;
    let backtrackCount = 0;
    let turnCount = 0;

    let minConfidence: 'high' | 'medium' | 'low' = 'high';
    const updateMinConfidence = (conf: 'high' | 'medium' | 'low') => {
      if (conf === 'low') {
        minConfidence = 'low';
      } else if (conf === 'medium' && minConfidence === 'high') {
        minConfidence = 'medium';
      }
    };

    interface NavState {
      categoryId: string;
      categoryName: string;
      triedChildren: Set<string>;
    }
    const navStack: NavState[] = [];
    const navigationPath: string[] = [];

    const verticals = this.taxonomy.getVerticals();
    const triedVerticals = new Set<string>();
    const allVerticalOptions = this.getVerticalOptions();
    const verticalOptionsExcluding = (tried: Set<string>) =>
      allVerticalOptions.filter(o => !tried.has(o.name));

    console.log(`  [Turn ${++turnCount}] Selecting top-level vertical...`);
    const verticalResult = await this.askForSelection(query, [...allVerticalOptions], []);

    const vertical = verticals.find(v => v.name === verticalResult.category);
    if (!vertical || !vertical.rootCategory) {
      throw new Error(`Could not find vertical: ${verticalResult.category}`);
    }

    updateMinConfidence(verticalResult.confidence);
    triedVerticals.add(verticalResult.category);
    navigationPath.push(verticalResult.category);
    console.log(`    └─ Selected: ${verticalResult.category}`);

    navStack.push({
      categoryId: vertical.rootCategory.id,
      categoryName: verticalResult.category,
      triedChildren: new Set(),
    });

    // Pop the current node off both stacks, bump backtrackCount. Returns a final
    // mapping if MAX_BACKTRACKS is exceeded, reselects a vertical if the stack
    // empties, or null to continue navigating from the new top.
    const tryBacktrack = async (logMessage: string): Promise<Omit<MappingResult, 'cached'> | null> => {
      console.log(logMessage);
      navStack.pop();
      navigationPath.pop();
      backtrackCount++;
      if (backtrackCount > MAX_BACKTRACKS) {
        const deepest = navStack.length > 0
          ? this.taxonomy.getCategory(navStack[navStack.length - 1].categoryId)
          : vertical.rootCategory;
        if (deepest) {
          return {
            node_id: stripGid(deepest.id),
            confidence: 'low',
            full_name: deepest.full_name,
            turns: turnCount,
            unmapped: true,
          };
        }
      }
      if (navStack.length === 0) {
        return reselectOrExhaust();
      }
      return null;
    };

    // Re-pick a top-level vertical after navStack empties. Returns a final mapping
    // when every vertical has been tried, or null when a fresh vertical was pushed.
    const reselectOrExhaust = async (): Promise<Omit<MappingResult, 'cached'> | null> => {
      const available = verticalOptionsExcluding(triedVerticals);
      if (available.length === 0) {
        return {
          node_id: stripGid(vertical.rootCategory!.id),
          confidence: 'low',
          full_name: vertical.rootCategory!.full_name,
          turns: turnCount,
          unmapped: true,
        };
      }
      console.log(`  [Turn ${++turnCount}] Re-selecting top-level vertical (excluding ${triedVerticals.size} tried)...`);
      const result = await this.askForSelection(query, available, []);
      const newV = verticals.find(v => v.name === result.category);
      if (!newV || !newV.rootCategory) {
        throw new Error(`Could not find vertical: ${result.category}`);
      }
      updateMinConfidence(result.confidence);
      triedVerticals.add(result.category);
      navigationPath.length = 0;
      navigationPath.push(result.category);
      console.log(`    └─ Selected: ${result.category}`);
      navStack.push({
        categoryId: newV.rootCategory.id,
        categoryName: result.category,
        triedChildren: new Set(),
      });
      return null;
    };

    while (navStack.length > 0) {
      const current = navStack[navStack.length - 1];
      const category = this.taxonomy.getCategory(current.categoryId);
      if (!category) {
        navStack.pop();
        continue;
      }

      if (category.children.length === 0) {
        // Any backtrack collapses confidence to low even if every individual turn was high.
        const finalConfidence = backtrackCount > 0 ? 'low' : minConfidence;
        return {
          node_id: stripGid(category.id),
          confidence: finalConfidence,
          full_name: category.full_name,
          turns: turnCount,
        };
      }

      const allChildren = this.taxonomy.getChildren(current.categoryId);
      const availableChildren = allChildren.filter(c => !current.triedChildren.has(c.name));

      if (availableChildren.length === 0) {
        const result = await tryBacktrack(`  [Backtrack] No more options at "${category.name}", going back...`);
        if (result) return result;
        continue;
      }

      console.log(`  [Turn ${++turnCount}] Selecting from ${availableChildren.length} children of "${category.name}"...`);

      const childOptions = availableChildren.map(c => {
        const grandchildren = this.taxonomy.getChildren(c.id);
        return {
          name: c.name,
          isLeaf: c.children.length === 0,
          childNames: grandchildren.map(gc => gc.name),
        };
      });

      const canGoBack = navStack.length > 1 || triedVerticals.size < verticals.length;
      if (canGoBack) {
        childOptions.push({
          name: 'None of these match',
          isLeaf: false,
          childNames: [],
        });
      }

      const childResult = await this.askForSelection(
        query,
        childOptions,
        navigationPath,
      );

      if (childResult.category === 'None of these match') {
        const abandoned = navStack[navStack.length - 1];
        const result = await tryBacktrack(`    └─ No match found, backtracking from "${abandoned.categoryName}"...`);
        if (result) return result;
        continue;
      }

      updateMinConfidence(childResult.confidence);

      const child = allChildren.find(c => c.name === childResult.category);
      if (!child) {
        console.error(`    └─ Available children: ${availableChildren.map(c => `"${c.name}"`).join(', ')}`);
        throw new Error(`Could not find child category: "${childResult.category}"`);
      }

      current.triedChildren.add(child.name);
      navigationPath.push(child.name);
      console.log(`    └─ Selected: ${child.name}${child.children.length === 0 ? ' (LEAF)' : ''}`);

      navStack.push({
        categoryId: child.id,
        categoryName: child.name,
        triedChildren: new Set(),
      });
    }

    throw new Error('Navigation ended without reaching a leaf category');
  }

  getModelId(): string {
    return this.nova.getModelId();
  }

  private async askForSelection(
    query: string,
    options: Array<{ name: string; isLeaf: boolean; childNames?: string[] }>,
    currentPath: string[],
  ): Promise<{ category: string; confidence: 'high' | 'medium' | 'low' }> {
    const turnStartTime = Date.now();

    const schema = {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: options.map(o => o.name),
          description: 'The selected category (must exactly match one option)',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'How certain: high=clear match, medium=reasonable, low=uncertain',
        },
      },
      required: ['category', 'confidence'],
    };

    const optionsList = options.map((o, i) => {
      if (o.isLeaf || !o.childNames || o.childNames.length === 0) {
        return `${i + 1}. ${o.name}`;
      }
      const childList = o.childNames.slice(0, 5).join(', ') + (o.childNames.length > 5 ? '...' : '');
      return `${i + 1}. ${o.name}\n   → includes: ${childList}`;
    }).join('\n');

    const pathContext = currentPath.length > 0
      ? `\nPath: ${currentPath.join(' > ')}`
      : '';

    // Reverted to prod's single-block prompt (no cachePoint). Splitting into a
    // cacheable prefix changed the model's attention pattern and caused bail-outs.
    const prompt = `Product: "${query}"${pathContext}

Which category? (Select from the numbered options, not the examples in parentheses)
${optionsList}`;

    // Each turn is stateless: we re-emit the full context every call. resetConversation
    // avoids the SDK requiring tool-result continuity from prior turns.
    this.nova.resetConversation();

    const response = await this.nova.converse(prompt, {
      systemPrompt: TAXONOMY_SYSTEM_PROMPT,
      jsonSchema: schema,
    });

    const turnTime = Date.now() - turnStartTime;
    console.log(`    └─ Turn complete: ${turnTime}ms`);

    if (response.text) {
      console.log(`    └─ Raw response: ${response.text.substring(0, 200)}`);
    }

    if (!response.structuredOutput || !('category' in response.structuredOutput)) {
      console.error('    └─ No structured output. Response:', JSON.stringify(response, null, 2));
      throw new Error('No structured response received from Nova');
    }

    const selectedCategory = response.structuredOutput.category as string;
    const confidence = (response.structuredOutput.confidence as 'high' | 'medium' | 'low') || 'medium';
    console.log(`    └─ LLM selected: "${selectedCategory}" (confidence: ${confidence})`);

    const validOptionNames = options.map(o => o.name);
    if (!validOptionNames.includes(selectedCategory)) {
      console.error(`    └─ ERROR: "${selectedCategory}" is not a valid option!`);
      console.error(`    └─ Valid options: ${validOptionNames.join(', ')}`);

      // Models sometimes emit a child-hint name instead of the parent option. Recover.
      for (const opt of options) {
        if (opt.childNames?.includes(selectedCategory)) {
          console.log(`    └─ "${selectedCategory}" is a child of "${opt.name}", selecting parent instead`);
          return { category: opt.name, confidence: 'medium' };
        }
      }

      throw new Error(`Model returned invalid category "${selectedCategory}" not in options: ${validOptionNames.join(', ')}`);
    }

    return { category: selectedCategory, confidence };
  }
}
