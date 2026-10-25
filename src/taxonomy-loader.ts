import { readFile } from 'fs/promises';
import { join } from 'path';
import type { TaxonomyData, Category } from './types.js';
import { stripGid, toGid } from './ids.js';

// Words that carry no category meaning in names or listings.
const KEYWORD_STOPWORDS = new Set([
  'and', 'for', 'the', 'with', 'of', 'in', 'to', 'pack', 'oz', 'set', 'other',
  'accessory', 'accessories', 'supply', 'supplies', 'product',
]);
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Lowercase word tokens with light plural folding ("watches" → "watch", "batteries" → "battery"). */
function keywordTokens(text: string): string[] {
  return text.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/)
    .filter(w => w.length > 1)
    .map(w => w.replace(/ies$/, 'y').replace(/(ch|sh|x|ss|z)es$/, '$1').replace(/(?<![su])s$/, ''))
    .filter(w => !KEYWORD_STOPWORDS.has(w));
}

export class TaxonomyLoader {
  private data: TaxonomyData | null = null;
  private categoryIndex: Map<string, Category> = new Map();
  private totalCategoryCount = 0;
  // BM25 index over category names, for keywordSearch().
  private keywordDocs: Array<{ category: Category; tokens: string[] }> = [];
  private keywordDocFrequency: Map<string, number> = new Map();
  private keywordAvgLength = 0;

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

        const tokens = keywordTokens(category.name);
        this.keywordDocs.push({ category, tokens });
        for (const token of new Set(tokens)) {
          this.keywordDocFrequency.set(token, (this.keywordDocFrequency.get(token) ?? 0) + 1);
        }
      }
    }
    this.keywordAvgLength = this.keywordDocs.reduce((sum, d) => sum + d.tokens.length, 0) / (this.keywordDocs.length || 1);
  }

  /**
   * BM25 ranking of categories whose names share words with `text`. Matches
   * individual words, so it works on long listing titles as well as short
   * queries. Ties prefer deeper (more specific) categories.
   */
  keywordSearch(text: string, limit: number): Category[] {
    const queryTokens = [...new Set(keywordTokens(text))];
    if (queryTokens.length === 0) return [];
    const docCount = this.keywordDocs.length;

    const scored: Array<{ category: Category; score: number }> = [];
    for (const { category, tokens } of this.keywordDocs) {
      let score = 0;
      for (const token of queryTokens) {
        const tf = tokens.filter(t => t === token).length;
        if (tf === 0) continue;
        const df = this.keywordDocFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * tokens.length / this.keywordAvgLength));
      }
      if (score > 0) scored.push({ category, score });
    }
    scored.sort((a, b) => b.score - a.score || b.category.level - a.category.level);
    return scored.slice(0, limit).map(s => s.category);
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

  getVersion(): string {
    return this.data?.version || 'unknown';
  }

  getTotalCategoryCount(): number {
    return this.totalCategoryCount;
  }
}
