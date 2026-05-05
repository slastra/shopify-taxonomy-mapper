import { readFile } from 'fs/promises';
import { join } from 'path';
import type { TaxonomyData, Category, SearchResult } from './types.js';
import { stripGid, toGid } from './ids.js';

export class TaxonomyLoader {
  private data: TaxonomyData | null = null;
  private categoryIndex: Map<string, Category> = new Map();
  private nameIndex: Map<string, Category[]> = new Map();
  private totalCategoryCount = 0;

  async load(dataPath: string = '../data/categories.json'): Promise<void> {
    const fullPath = join(import.meta.dirname, dataPath);
    const fileContent = await readFile(fullPath, 'utf-8');
    this.data = JSON.parse(fileContent) as TaxonomyData;
    this.buildIndices();
  }

  private buildIndices(): void {
    if (!this.data) return;
    for (const vertical of this.data.verticals) {
      for (const category of vertical.categories) {
        this.totalCategoryCount++;
        this.categoryIndex.set(category.id, category);
        this.categoryIndex.set(stripGid(category.id), category);

        const nameLower = category.name.toLowerCase();
        const fullNameLower = category.full_name.toLowerCase();
        (this.nameIndex.get(nameLower) ?? this.nameIndex.set(nameLower, []).get(nameLower)!).push(category);
        if (fullNameLower !== nameLower) {
          (this.nameIndex.get(fullNameLower) ?? this.nameIndex.set(fullNameLower, []).get(fullNameLower)!).push(category);
        }
      }
    }
  }

  getCategory(id: string): Category | undefined {
    return this.categoryIndex.get(id);
  }

  getVerticals(): Array<{ name: string; prefix: string; rootCategory: Category | undefined }> {
    if (!this.data) return [];
    return this.data.verticals.map(v => ({
      name: v.name,
      prefix: v.prefix,
      rootCategory: this.categoryIndex.get(toGid(v.prefix)),
    }));
  }

  getChildren(categoryId: string): Category[] {
    const category = this.getCategory(categoryId);
    if (!category) return [];
    return category.children
      .map(child => this.getCategory(child.id))
      .filter((c): c is Category => c !== undefined);
  }

  search(query: string, limit: number = 10): SearchResult[] {
    if (!this.data || !query) return [];

    const queryLower = query.toLowerCase().trim();
    const results: SearchResult[] = [];

    for (const category of this.nameIndex.get(queryLower) || []) {
      results.push({ category, score: 100, matchType: 'exact' });
    }

    for (const vertical of this.data.verticals) {
      for (const category of vertical.categories) {
        const nameLower = category.name.toLowerCase();
        const fullNameLower = category.full_name.toLowerCase();
        if (!nameLower.includes(queryLower) && !fullNameLower.includes(queryLower)) continue;
        if (results.some(r => r.category.id === category.id)) continue;

        let score = 50;
        if (nameLower.startsWith(queryLower)) score = 80;
        if (fullNameLower.includes(` > ${queryLower}`)) score = 70;
        if (fullNameLower.endsWith(queryLower)) score = 75;

        results.push({ category, score, matchType: 'partial' });
      }
    }

    // Higher score first, deeper categories preferred on ties (more specific match).
    results.sort((a, b) => b.score - a.score || b.category.level - a.category.level);
    return results.slice(0, limit);
  }

  getVersion(): string {
    return this.data?.version || 'unknown';
  }

  getTotalCategoryCount(): number {
    return this.totalCategoryCount;
  }
}
