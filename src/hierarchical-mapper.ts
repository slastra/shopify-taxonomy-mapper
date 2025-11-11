import { NovaLiteClient } from './nova-client.js';
import { TaxonomyLoader } from './taxonomy-loader.js';
import { MappingCache } from './database.js';

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
   * Perform guided navigation through taxonomy without tool use
   */
  private async performGuidedNavigation(query: string): Promise<Omit<MappingResult, 'cached'>> {
    this.nova.resetConversation();

    const path: string[] = [];
    let currentCategoryId: string | null = null;
    let turnCount = 0;

    // Turn 1: Select top-level vertical
    console.log(`  [Turn ${++turnCount}] Selecting top-level vertical...`);
    const verticals = this.taxonomy.getVerticals();
    const verticalNames = verticals.map(v => v.name);

    const selectedVertical = await this.askForSelection(
      query,
      verticalNames.map(name => ({ name, isLeaf: false })),
      'top-level category',
    );

    const vertical = verticals.find(v => v.name === selectedVertical);
    if (!vertical || !vertical.rootCategory) {
      throw new Error(`Could not find vertical: ${selectedVertical}`);
    }

    path.push(selectedVertical);
    currentCategoryId = vertical.rootCategory.id;
    console.log(`    └─ Selected: ${selectedVertical}`);

    // Turn 2+: Drill down until we reach a leaf
    while (currentCategoryId) {
      const category = this.taxonomy.getCategory(currentCategoryId);
      if (!category) break;

      // If this is a leaf, we're done
      if (category.children.length === 0) {
        return {
          node_id: category.id.replace('gid://shopify/TaxonomyCategory/', ''),
          confidence: 'high',
          reasoning: `Reached leaf category at level ${category.level}`,
          full_name: category.full_name,
          turns: turnCount,
        };
      }

      // Get children and ask for selection
      console.log(`  [Turn ${++turnCount}] Selecting from ${category.children.length} children...`);
      const children = this.taxonomy.getChildren(currentCategoryId);

      // Add "Other" option to allow stopping at parent category
      const childOptions = children.map(c => ({
        name: c.name,
        isLeaf: c.children.length === 0,
      }));
      childOptions.push({
        name: 'Other (use parent category)',
        isLeaf: true,
      });

      const selectedChild = await this.askForSelection(
        query,
        childOptions,
        'child category',
      );

      // Check if "Other" was selected (use parent category)
      if (selectedChild === 'Other (use parent category)') {
        console.log(`    └─ Selected: Other (using parent category "${category.name}")`);
        return {
          node_id: category.id.replace('gid://shopify/TaxonomyCategory/', ''),
          confidence: 'medium',
          reasoning: `Used parent category "${category.name}" - subcategories too specific`,
          full_name: category.full_name,
          turns: turnCount,
        };
      }

      // askForSelection now returns the exact matched name, so this should always find it
      const child = children.find(c => c.name === selectedChild);
      if (!child) {
        // This should never happen now, but keep as safety check
        console.error(`    └─ Available children: ${children.map(c => `"${c.name}"`).join(', ')}`);
        throw new Error(`Could not find child category: "${selectedChild}"`);
      }

      path.push(child.name);
      currentCategoryId = child.id;
      console.log(`    └─ Selected: ${child.name}${child.children.length === 0 ? ' (LEAF)' : ''}`);
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
   * Ask Nova to select one option from a list
   */
  private async askForSelection(
    query: string,
    options: Array<{ name: string; isLeaf: boolean }>,
    levelDescription: string,
  ): Promise<string> {
    const turnStartTime = Date.now();

    // Format options with leaf indicators
    const optionsList = options
      .map((o, i) => `${i + 1}. ${o.name}${o.isLeaf ? ' ← LEAF' : ''}`)
      .join('\n');

    const prompt = `You are mapping "${query}" to Shopify's product taxonomy.

Available ${levelDescription} options (${options.length} total):
${optionsList}

CRITICAL INSTRUCTIONS:
1. You MUST pick ONE option from the numbered list above
2. Return ONLY the exact category name (not the number, not "← LEAF")
3. Do NOT make up category names - only use the options shown
4. If the query is generic, pick the most common/general option from the list

Example: If the options include "3. Dog Food ← LEAF", return exactly: Dog Food

Pick the BEST match for "${query}":`;

    const response = await this.nova.converse(prompt);

    const turnTime = Date.now() - turnStartTime;
    console.log(`    └─ Turn complete: ${turnTime}ms`);

    if (!response.text) {
      throw new Error('Nova did not return a text response');
    }

    // Clean up response - remove numbers, "← LEAF", quotes, etc.
    let selected = response.text.trim();
    selected = selected.replace(/^\d+\.\s*/, ''); // Remove "1. " prefix
    selected = selected.replace(/\s*←\s*LEAF\s*$/i, ''); // Remove " ← LEAF" suffix
    selected = selected.replace(/^["']|["']$/g, ''); // Remove quotes
    selected = selected.trim(); // Trim again after cleanup

    console.log(`    └─ LLM returned: "${selected}"`);

    // Try exact match first
    const exactMatch = options.find(o => o.name === selected);
    if (exactMatch) {
      return exactMatch.name;
    }

    // Try case-insensitive match
    const caseInsensitiveMatch = options.find(o => o.name.toLowerCase() === selected.toLowerCase());
    if (caseInsensitiveMatch) {
      console.log(`    └─ Used case-insensitive match: "${caseInsensitiveMatch.name}"`);
      return caseInsensitiveMatch.name;
    }

    // If no match found, log available options and throw error
    console.error(`    └─ Available options: ${options.map(o => `"${o.name}"`).join(', ')}`);
    throw new Error(`Could not find category: "${selected}"`);
  }
}
