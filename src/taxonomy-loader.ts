import { readFile } from 'fs/promises';
import { join } from 'path';
import type { TaxonomyData, Category, SearchResult } from './types.js';

export class TaxonomyLoader {
  private data: TaxonomyData | null = null;
  private categoryIndex: Map<string, Category> = new Map();
  private nameIndex: Map<string, Category[]> = new Map();

  async load(dataPath: string = '../data/categories.json'): Promise<void> {
    const fullPath = join(import.meta.dirname, dataPath);
    const fileContent = await readFile(fullPath, 'utf-8');
    this.data = JSON.parse(fileContent) as TaxonomyData;
    this.buildIndices();
  }

  private buildIndices(): void {
    if (!this.data) return;

    // Build category ID index and name index
    for (const vertical of this.data.verticals) {
      for (const category of vertical.categories) {
        // Index by ID (both short form and GID)
        this.categoryIndex.set(category.id, category);
        const shortId = category.id.replace('gid://shopify/TaxonomyCategory/', '');
        this.categoryIndex.set(shortId, category);

        // Index by name (for searching)
        const nameLower = category.name.toLowerCase();
        const fullNameLower = category.full_name.toLowerCase();

        const nameCategories = this.nameIndex.get(nameLower) || [];
        nameCategories.push(category);
        this.nameIndex.set(nameLower, nameCategories);

        if (fullNameLower !== nameLower) {
          const fullNameCategories = this.nameIndex.get(fullNameLower) || [];
          fullNameCategories.push(category);
          this.nameIndex.set(fullNameLower, fullNameCategories);
        }
      }
    }
  }

  getCategory(id: string): Category | undefined {
    return this.categoryIndex.get(id);
  }

  getAllCategories(): Category[] {
    if (!this.data) return [];
    return this.data.verticals.flatMap(v => v.categories);
  }

  getVerticals(): Array<{ name: string; prefix: string; rootCategory: Category | undefined }> {
    if (!this.data) return [];
    return this.data.verticals.map(v => ({
      name: v.name,
      prefix: v.prefix,
      rootCategory: this.categoryIndex.get(`gid://shopify/TaxonomyCategory/${v.prefix}`),
    }));
  }

  search(query: string, limit: number = 10): SearchResult[] {
    if (!this.data || !query) return [];

    const queryLower = query.toLowerCase().trim();
    const results: SearchResult[] = [];

    // Exact name match
    const exactMatches = this.nameIndex.get(queryLower) || [];
    for (const category of exactMatches) {
      results.push({
        category,
        score: 100,
        matchType: 'exact',
      });
    }

    // Partial matches in name or full_name
    for (const category of this.getAllCategories()) {
      const nameLower = category.name.toLowerCase();
      const fullNameLower = category.full_name.toLowerCase();

      if (nameLower.includes(queryLower) || fullNameLower.includes(queryLower)) {
        // Skip if already added as exact match
        if (results.some(r => r.category.id === category.id)) continue;

        // Score based on position and type of match
        let score = 50;
        if (nameLower.startsWith(queryLower)) score = 80;
        if (fullNameLower.includes(` > ${queryLower}`)) score = 70;
        if (fullNameLower.endsWith(queryLower)) score = 75;

        results.push({
          category,
          score,
          matchType: 'partial',
        });
      }
    }

    // Sort by score descending, then by level (prefer more specific categories)
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.category.level - a.category.level;
    });

    return results.slice(0, limit);
  }

  getChildren(categoryId: string): Category[] {
    const category = this.getCategory(categoryId);
    if (!category) return [];

    return category.children
      .map(child => this.getCategory(child.id))
      .filter((c): c is Category => c !== undefined);
  }

  getAncestors(categoryId: string): Category[] {
    const category = this.getCategory(categoryId);
    if (!category) return [];

    return category.ancestors
      .map(ancestor => this.getCategory(ancestor.id))
      .filter((c): c is Category => c !== undefined);
  }

  /**
   * Search for categories within a specific parent category subtree
   */
  searchWithinCategory(parentId: string, query: string, limit: number = 10): SearchResult[] {
    const parent = this.getCategory(parentId);
    if (!parent) return [];

    // Get all descendants of parent category
    const descendants = this.getDescendants(parentId);

    // Search within descendants
    const queryLower = query.toLowerCase().trim();
    const results: SearchResult[] = [];

    // Check each descendant for matches
    for (const category of descendants) {
      const nameLower = category.name.toLowerCase();
      const fullNameLower = category.full_name.toLowerCase();

      if (nameLower === queryLower || fullNameLower === queryLower) {
        results.push({
          category,
          score: 100,
          matchType: 'exact',
        });
      } else if (nameLower.includes(queryLower) || fullNameLower.includes(queryLower)) {
        let score = 50;
        if (nameLower.startsWith(queryLower)) score = 80;
        if (fullNameLower.endsWith(queryLower)) score = 75;

        results.push({
          category,
          score,
          matchType: 'partial',
        });
      }
    }

    // Sort by score and level
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.category.level - a.category.level;
    });

    return results.slice(0, limit);
  }

  /**
   * Get all descendants of a category
   */
  private getDescendants(categoryId: string): Category[] {
    const category = this.getCategory(categoryId);
    if (!category) return [];

    const descendants: Category[] = [];
    const queue: string[] = [categoryId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) continue;

      const current = this.getCategory(currentId);
      if (!current) continue;

      // Add all children to queue and descendants
      for (const child of current.children) {
        const childCategory = this.getCategory(child.id);
        if (childCategory) {
          descendants.push(childCategory);
          queue.push(child.id);
        }
      }
    }

    return descendants;
  }

  getVersion(): string {
    return this.data?.version || 'unknown';
  }

  getTotalCategoryCount(): number {
    return this.categoryIndex.size / 2; // Divided by 2 because we index both GID and short form
  }
}
