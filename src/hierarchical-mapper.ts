import { NovaLiteClient } from './nova-client.js';
import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';

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
  reasoning: string;
  full_name: string;
  cached: boolean;
  turns?: number; // Only for hierarchical approach
}

/**
 * Hierarchical category mapper using Nova Lite with multi-turn drill-down
 */
export class HierarchicalMapper {
  private nova: NovaLiteClient;
  private taxonomy: TaxonomyLoader;
  private cache: MappingCache;

  constructor(taxonomy: TaxonomyLoader, cache: MappingCache) {
    this.nova = new NovaLiteClient();
    this.taxonomy = taxonomy;
    this.cache = cache;
  }

  /**
   * Map Amazon category path to Shopify taxonomy
   */
  async mapCategory(categoryPath: string): Promise<MappingResult> {
    const startTime = Date.now();

    // Check cache first
    const cached = await this.cache.getHierarchicalMapping(categoryPath);
    if (cached) {
      console.log(`[CACHE HIT] ${categoryPath} -> ${cached.full_name} (${Date.now() - startTime}ms)`);
      return { ...cached, cached: true, reasoning: '' };
    }

    console.log(`[MAPPING] "${categoryPath}"`);

    // Use guided navigation without tool use
    const result = await this.performGuidedNavigation(categoryPath);

    const totalTime = Date.now() - startTime;
    console.log(`[COMPLETE] ${categoryPath} -> ${result.full_name}`);
    console.log(`  ├─ Turns: ${result.turns}`);
    console.log(`  ├─ Confidence: ${result.confidence}`);
    console.log(`  └─ Time: ${totalTime}ms (${Math.round(totalTime / (result.turns || 1))}ms/turn)`);

    // Save to cache
    await this.cache.saveHierarchicalMapping(categoryPath, result.node_id, result.confidence, result.full_name);

    return { ...result, cached: false };
  }

  /**
   * Map product title to Shopify taxonomy
   */
  async mapProduct(productTitle: string): Promise<MappingResult> {
    const startTime = Date.now();

    // Check cache first
    const cached = await this.cache.getHierarchicalMapping(productTitle);
    if (cached) {
      console.log(`[CACHE HIT] ${productTitle} -> ${cached.full_name} (${Date.now() - startTime}ms)`);
      return { ...cached, cached: true, reasoning: '' };
    }

    console.log(`[MAPPING] "${productTitle}"`);

    // Use guided navigation without tool use
    const result = await this.performGuidedNavigation(productTitle);

    const totalTime = Date.now() - startTime;
    console.log(`[COMPLETE] ${productTitle} -> ${result.full_name}`);
    console.log(`  ├─ Turns: ${result.turns}`);
    console.log(`  ├─ Confidence: ${result.confidence}`);
    console.log(`  └─ Time: ${totalTime}ms (${Math.round(totalTime / (result.turns || 1))}ms/turn)`);

    // Save to cache
    await this.cache.saveHierarchicalMapping(productTitle, result.node_id, result.confidence, result.full_name);

    return { ...result, cached: false };
  }

  /**
   * Perform guided navigation through taxonomy with backtracking support
   */
  private async performGuidedNavigation(query: string): Promise<Omit<MappingResult, 'cached'>> {
    this.nova.resetConversation();

    const MAX_BACKTRACKS = 5;
    let backtrackCount = 0;
    let turnCount = 0;

    // Track minimum confidence across all turns
    let minConfidence: 'high' | 'medium' | 'low' = 'high';
    const updateMinConfidence = (conf: 'high' | 'medium' | 'low') => {
      if (conf === 'low') {
        minConfidence = 'low';
      } else if (conf === 'medium' && minConfidence === 'high') {
        minConfidence = 'medium';
      }
    };

    // Navigation stack: each entry tracks the category and which children have been tried
    interface NavState {
      categoryId: string;
      categoryName: string;
      triedChildren: Set<string>;
    }
    const navStack: NavState[] = [];

    // Track navigation path for context in prompts
    const navigationPath: string[] = [];

    // Start with verticals selection
    const verticals = this.taxonomy.getVerticals();
    const triedVerticals = new Set<string>();

    // Select initial vertical - include child category names as hints
    console.log(`  [Turn ${++turnCount}] Selecting top-level vertical...`);
    const verticalResult = await this.askForSelection(
      query,
      verticals.map(v => {
        const children = v.rootCategory ? this.taxonomy.getChildren(v.rootCategory.id) : [];
        return {
          name: v.name,
          isLeaf: false,
          childNames: children.map(c => c.name),
        };
      }),
      [],
    );

    const vertical = verticals.find(v => v.name === verticalResult.category);
    if (!vertical || !vertical.rootCategory) {
      throw new Error(`Could not find vertical: ${verticalResult.category}`);
    }

    updateMinConfidence(verticalResult.confidence);
    triedVerticals.add(verticalResult.category);
    navigationPath.push(verticalResult.category);
    console.log(`    └─ Selected: ${verticalResult.category}`);

    // Push root category onto stack
    navStack.push({
      categoryId: vertical.rootCategory.id,
      categoryName: verticalResult.category,
      triedChildren: new Set(),
    });

    // Navigate until we reach a leaf
    while (navStack.length > 0) {
      const current = navStack[navStack.length - 1];
      const category = this.taxonomy.getCategory(current.categoryId);
      if (!category) {
        navStack.pop();
        continue;
      }

      // If this is a leaf, we're done
      if (category.children.length === 0) {
        // Use accumulated confidence, but downgrade if we had to backtrack
        const finalConfidence = backtrackCount > 0 ? 'low' : minConfidence;
        return {
          node_id: category.id.replace('gid://shopify/TaxonomyCategory/', ''),
          confidence: finalConfidence,
          reasoning: backtrackCount === 0
            ? `Reached leaf category at level ${category.level}`
            : `Reached leaf category at level ${category.level} after ${backtrackCount} backtrack(s)`,
          full_name: category.full_name,
          turns: turnCount,
        };
      }

      // Get available children (excluding already tried ones)
      const allChildren = this.taxonomy.getChildren(current.categoryId);
      const availableChildren = allChildren.filter(c => !current.triedChildren.has(c.name));

      // If no children left to try, we need to backtrack
      if (availableChildren.length === 0) {
        console.log(`  [Backtrack] No more options at "${category.name}", going back...`);
        navStack.pop();
        backtrackCount++;

        if (backtrackCount > MAX_BACKTRACKS) {
          // Use the deepest category we reached as fallback
          const deepest = navStack.length > 0
            ? this.taxonomy.getCategory(navStack[navStack.length - 1].categoryId)
            : vertical.rootCategory;
          if (deepest) {
            return {
              node_id: deepest.id.replace('gid://shopify/TaxonomyCategory/', ''),
              confidence: 'low',
              reasoning: `Max backtracks (${MAX_BACKTRACKS}) exceeded, using best available category`,
              full_name: deepest.full_name,
              turns: turnCount,
            };
          }
        }

        // If stack is empty, try a different vertical
        if (navStack.length === 0) {
          const availableVerticals = verticals.filter(v => !triedVerticals.has(v.name));
          if (availableVerticals.length === 0) {
            // All verticals exhausted, use the original one
            return {
              node_id: vertical.rootCategory.id.replace('gid://shopify/TaxonomyCategory/', ''),
              confidence: 'low',
              reasoning: 'All navigation paths exhausted, using root category',
              full_name: vertical.rootCategory.full_name,
              turns: turnCount,
            };
          }

          console.log(`  [Turn ${++turnCount}] Re-selecting top-level vertical (excluding tried)...`);
          const newVerticalResult = await this.askForSelection(
            query,
            availableVerticals.map(v => {
              const children = v.rootCategory ? this.taxonomy.getChildren(v.rootCategory.id) : [];
              return {
                name: v.name,
                isLeaf: false,
                childNames: children.map(c => c.name),
              };
            }),
            [],
          );

          const newV = verticals.find(v => v.name === newVerticalResult.category);
          if (!newV || !newV.rootCategory) {
            throw new Error(`Could not find vertical: ${newVerticalResult.category}`);
          }

          updateMinConfidence(newVerticalResult.confidence);
          triedVerticals.add(newVerticalResult.category);
          navigationPath.length = 0; // Reset path
          navigationPath.push(newVerticalResult.category);
          console.log(`    └─ Selected: ${newVerticalResult.category}`);

          navStack.push({
            categoryId: newV.rootCategory.id,
            categoryName: newVerticalResult.category,
            triedChildren: new Set(),
          });
        }
        continue;
      }

      // Ask for selection from available children
      console.log(`  [Turn ${++turnCount}] Selecting from ${availableChildren.length} children of "${category.name}"...`);

      const childOptions = availableChildren.map(c => {
        const grandchildren = this.taxonomy.getChildren(c.id);
        return {
          name: c.name,
          isLeaf: c.children.length === 0,
          childNames: grandchildren.map(gc => gc.name),
        };
      });

      // Add "None of these" option if we have somewhere to go back to
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

      // Handle backtrack request
      if (childResult.category === 'None of these match') {
        // The category we're abandoning was already marked as "tried" on the parent
        // when we first selected it, so just pop and continue
        const abandonedCategory = navStack[navStack.length - 1];
        console.log(`    └─ No match found, backtracking from "${abandonedCategory.categoryName}"...`);

        navStack.pop();
        navigationPath.pop();
        backtrackCount++;

        if (backtrackCount > MAX_BACKTRACKS) {
          const deepest = navStack.length > 0
            ? this.taxonomy.getCategory(navStack[navStack.length - 1].categoryId)
            : vertical.rootCategory;
          if (deepest) {
            return {
              node_id: deepest.id.replace('gid://shopify/TaxonomyCategory/', ''),
              confidence: 'low',
              reasoning: `Max backtracks (${MAX_BACKTRACKS}) exceeded, using best available category`,
              full_name: deepest.full_name,
              turns: turnCount,
            };
          }
        }

        // If stack is empty after backtrack, try a different vertical
        if (navStack.length === 0) {
          const availableVerticals = verticals.filter(v => !triedVerticals.has(v.name));
          if (availableVerticals.length === 0) {
            // All verticals exhausted, use the original one
            return {
              node_id: vertical.rootCategory.id.replace('gid://shopify/TaxonomyCategory/', ''),
              confidence: 'low',
              reasoning: 'All navigation paths exhausted, using root category',
              full_name: vertical.rootCategory.full_name,
              turns: turnCount,
            };
          }

          console.log(`  [Turn ${++turnCount}] Re-selecting top-level vertical (excluding ${triedVerticals.size} tried)...`);
          const newVerticalResult = await this.askForSelection(
            query,
            availableVerticals.map(v => {
              const children = v.rootCategory ? this.taxonomy.getChildren(v.rootCategory.id) : [];
              return {
                name: v.name,
                isLeaf: false,
                childNames: children.map(c => c.name),
              };
            }),
            [],
          );

          const newV = verticals.find(v => v.name === newVerticalResult.category);
          if (!newV || !newV.rootCategory) {
            throw new Error(`Could not find vertical: ${newVerticalResult.category}`);
          }

          updateMinConfidence(newVerticalResult.confidence);
          triedVerticals.add(newVerticalResult.category);
          navigationPath.length = 0; // Reset path
          navigationPath.push(newVerticalResult.category);
          console.log(`    └─ Selected: ${newVerticalResult.category}`);

          navStack.push({
            categoryId: newV.rootCategory.id,
            categoryName: newVerticalResult.category,
            triedChildren: new Set(),
          });
        }
        continue;
      }

      updateMinConfidence(childResult.confidence);

      // Find the selected child
      const child = allChildren.find(c => c.name === childResult.category);
      if (!child) {
        console.error(`    └─ Available children: ${availableChildren.map(c => `"${c.name}"`).join(', ')}`);
        throw new Error(`Could not find child category: "${childResult.category}"`);
      }

      // Mark this child as tried and push to stack
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

  /**
   * Get the current Nova model ID
   */
  getModelId(): string {
    return this.nova.getModelId();
  }

  /**
   * Ask Nova to select one option from a list using JSON schema structured output
   */
  private async askForSelection(
    query: string,
    options: Array<{ name: string; isLeaf: boolean; childNames?: string[] }>,
    currentPath: string[],
  ): Promise<{ category: string; confidence: 'high' | 'medium' | 'low' }> {
    const turnStartTime = Date.now();

    // Build JSON schema with enum of exact category names and confidence
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

    // Build options list with child hints on separate lines
    const optionsList = options.map((o, i) => {
      if (o.isLeaf || !o.childNames || o.childNames.length === 0) {
        return `${i + 1}. ${o.name}`;
      }
      // Show up to 5 children as hints on next line, indented
      const childList = o.childNames.slice(0, 5).join(', ') + (o.childNames.length > 5 ? '...' : '');
      return `${i + 1}. ${o.name}\n   → includes: ${childList}`;
    }).join('\n');

    // Build path context
    const pathContext = currentPath.length > 0
      ? `\nPath: ${currentPath.join(' > ')}`
      : '';

    const prompt = `Product: "${query}"${pathContext}

Which category? (Select from the numbered options, not the examples in parentheses)
${optionsList}`;

    // Reset conversation before each turn to avoid tool result requirements
    // Each turn is stateless - we provide full context in the prompt
    this.nova.resetConversation();

    const response = await this.nova.converse(prompt, undefined, TAXONOMY_SYSTEM_PROMPT, schema);

    const turnTime = Date.now() - turnStartTime;
    console.log(`    └─ Turn complete: ${turnTime}ms`);

    // Debug: log raw response
    if (response.text) {
      console.log(`    └─ Raw response: ${response.text.substring(0, 200)}`);
    }

    // Extract from structured output
    if (!response.structuredOutput || !('category' in response.structuredOutput)) {
      console.error('    └─ No structured output. Response:', JSON.stringify(response, null, 2));
      throw new Error('No structured response received from Nova');
    }

    const selectedCategory = response.structuredOutput.category as string;
    const confidence = (response.structuredOutput.confidence as 'high' | 'medium' | 'low') || 'medium';
    console.log(`    └─ LLM selected: "${selectedCategory}" (confidence: ${confidence})`);

    // Validate that the selected category is actually in our options (enum not strictly enforced by models)
    const validOptionNames = options.map(o => o.name);
    if (!validOptionNames.includes(selectedCategory)) {
      console.error(`    └─ ERROR: "${selectedCategory}" is not a valid option!`);
      console.error(`    └─ Valid options: ${validOptionNames.join(', ')}`);

      // Try to find if it matches a child hint (common error)
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
