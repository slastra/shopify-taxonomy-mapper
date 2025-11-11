import { Database } from 'bun:sqlite';
import type { CategoryMapping } from './types.js';

export class MappingCache {
  private db: Database | null = null;

  connect(dbPath: string = './data/mappings.db'): void {
    this.db = new Database(dbPath, { create: true });
    this.initializeSchema();
  }

  private initializeSchema(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS amazon_shopify_category_mappings (
        amazon_category TEXT PRIMARY KEY,
        shopify_category_id TEXT NOT NULL,
        shopify_category_gid TEXT NOT NULL,
        shopify_full_name TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK(confidence IN ('high', 'medium', 'low')),
        created_by TEXT NOT NULL CHECK(created_by IN ('llm', 'manual')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_shopify_category_id
      ON amazon_shopify_category_mappings(shopify_category_id)
    `);
  }

  async getMapping(amazonCategory: string): Promise<CategoryMapping | null> {
    if (!this.db) throw new Error('Database not connected');

    try {
      const query = this.db.query(`
        SELECT
          amazon_category,
          shopify_category_id,
          shopify_category_gid,
          shopify_full_name,
          confidence,
          created_by,
          created_at
        FROM amazon_shopify_category_mappings
        WHERE amazon_category = ?
        LIMIT 1
      `);

      const result = query.get(amazonCategory) as CategoryMapping | null;
      return result;
    } catch (error) {
      console.error('Error fetching mapping:', error);
      return null;
    }
  }

  async saveMapping(mapping: Omit<CategoryMapping, 'created_at'>): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');

    try {
      const query = this.db.query(`
        INSERT INTO amazon_shopify_category_mappings (
          amazon_category,
          shopify_category_id,
          shopify_category_gid,
          shopify_full_name,
          confidence,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (amazon_category)
        DO UPDATE SET
          shopify_category_id = excluded.shopify_category_id,
          shopify_category_gid = excluded.shopify_category_gid,
          shopify_full_name = excluded.shopify_full_name,
          confidence = excluded.confidence,
          updated_at = CURRENT_TIMESTAMP
      `);

      query.run(
        mapping.amazon_category,
        mapping.shopify_category_id,
        mapping.shopify_category_gid,
        mapping.shopify_full_name,
        mapping.confidence,
        mapping.created_by,
      );

      return true;
    } catch (error) {
      console.error('Error saving mapping:', error);
      return false;
    }
  }

  async getAllMappings(): Promise<CategoryMapping[]> {
    if (!this.db) throw new Error('Database not connected');

    try {
      const query = this.db.query(`
        SELECT
          amazon_category,
          shopify_category_id,
          shopify_category_gid,
          shopify_full_name,
          confidence,
          created_by,
          created_at
        FROM amazon_shopify_category_mappings
        ORDER BY created_at DESC
      `);

      const result = query.all() as CategoryMapping[];
      return result;
    } catch (error) {
      console.error('Error fetching all mappings:', error);
      return [];
    }
  }

  async deleteMapping(amazonCategory: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');

    try {
      const query = this.db.query(`
        DELETE FROM amazon_shopify_category_mappings
        WHERE amazon_category = ?
      `);

      query.run(amazonCategory);
      return true;
    } catch (error) {
      console.error('Error deleting mapping:', error);
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Get hierarchical mapping result (for API responses)
   * Returns simplified format for HTTP API
   */
  async getHierarchicalMapping(
    key: string,
  ): Promise<{ node_id: string; confidence: 'high' | 'medium' | 'low'; full_name: string } | null> {
    const mapping = await this.getMapping(key);
    if (!mapping) return null;

    return {
      node_id: mapping.shopify_category_id,
      confidence: mapping.confidence as 'high' | 'medium' | 'low',
      full_name: mapping.shopify_full_name,
    };
  }

  /**
   * Save hierarchical mapping result (from Nova drill-down)
   * Convenience method for HTTP API
   */
  async saveHierarchicalMapping(
    key: string,
    nodeId: string,
    confidence: 'high' | 'medium' | 'low',
    fullName: string,
  ): Promise<boolean> {
    const gid = `gid://shopify/TaxonomyCategory/${nodeId}`;

    return await this.saveMapping({
      amazon_category: key,
      shopify_category_id: nodeId,
      shopify_category_gid: gid,
      shopify_full_name: fullName,
      confidence,
      created_by: 'llm',
    });
  }

  // Get mapping statistics
  getStats(): { total: number; byConfidence: Record<string, number>; bySource: Record<string, number> } {
    if (!this.db) throw new Error('Database not connected');

    const totalQuery = this.db.query('SELECT COUNT(*) as count FROM amazon_shopify_category_mappings');
    const total = (totalQuery.get() as { count: number }).count;

    const confidenceQuery = this.db.query(`
      SELECT confidence, COUNT(*) as count
      FROM amazon_shopify_category_mappings
      GROUP BY confidence
    `);
    const confidenceResults = confidenceQuery.all() as Array<{ confidence: string; count: number }>;
    const byConfidence: Record<string, number> = {};
    for (const row of confidenceResults) {
      byConfidence[row.confidence] = row.count;
    }

    const sourceQuery = this.db.query(`
      SELECT created_by, COUNT(*) as count
      FROM amazon_shopify_category_mappings
      GROUP BY created_by
    `);
    const sourceResults = sourceQuery.all() as Array<{ created_by: string; count: number }>;
    const bySource: Record<string, number> = {};
    for (const row of sourceResults) {
      bySource[row.created_by] = row.count;
    }

    return { total, byConfidence, bySource };
  }
}
