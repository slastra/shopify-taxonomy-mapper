import { Database, Statement } from 'bun:sqlite';
import type { CategoryMapping } from './types.js';
import { toGid } from './ids.js';

// Casing/whitespace variants share cache entries:
// "Apple AirPods Pro" and "  apple   airpods   pro " resolve to the same row.
function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface Stats {
  total: number;
  byConfidence: Record<string, number>;
  bySource: Record<string, number>;
}

interface MappingResult {
  node_id: string;
  confidence: 'high' | 'medium' | 'low';
  full_name: string;
}

export class MappingCache {
  private db: Database | null = null;
  private getStmt!: Statement<CategoryMapping, [string]>;
  private upsertStmt!: Statement<unknown, [string, string, string, string, string, string]>;
  private statsTotal!: Statement<{ count: number }, []>;
  private statsByConfidence!: Statement<{ confidence: string; count: number }, []>;
  private statsBySource!: Statement<{ created_by: string; count: number }, []>;

  connect(dbPath: string = './data/mappings.db'): void {
    this.db = new Database(dbPath, { create: true });
    this.initializeSchema();
    this.runMigrations();
    this.prepareStatements();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async getHierarchicalMapping(key: string): Promise<MappingResult | null> {
    if (!this.db) throw new Error('Database not connected');
    const row = this.getStmt.get(normalizeKey(key));
    if (!row) return null;
    return {
      node_id: row.shopify_category_id,
      confidence: row.confidence as 'high' | 'medium' | 'low',
      full_name: row.shopify_full_name,
    };
  }

  async saveHierarchicalMapping(
    key: string,
    nodeId: string,
    confidence: 'high' | 'medium' | 'low',
    fullName: string,
  ): Promise<boolean> {
    if (!this.db) throw new Error('Database not connected');
    try {
      this.upsertStmt.run(
        normalizeKey(key),
        nodeId,
        toGid(nodeId),
        fullName,
        confidence,
        'llm',
      );
      return true;
    } catch (error) {
      console.error('Error saving mapping:', error);
      return false;
    }
  }

  getStats(): Stats {
    if (!this.db) throw new Error('Database not connected');
    const total = this.statsTotal.get()?.count ?? 0;
    const byConfidence: Record<string, number> = {};
    for (const row of this.statsByConfidence.all()) {
      byConfidence[row.confidence] = row.count;
    }
    const bySource: Record<string, number> = {};
    for (const row of this.statsBySource.all()) {
      bySource[row.created_by] = row.count;
    }
    return { total, byConfidence, bySource };
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
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_shopify_category_id
      ON amazon_shopify_category_mappings(shopify_category_id)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  private runMigrations(): void {
    if (!this.db) return;
    const migrations: Array<{ name: string; up: () => void }> = [
      {
        name: '2026-05_normalize_cache_keys',
        up: () => {
          // Cache keys now normalized (lower/trim/collapse whitespace) before insert,
          // and stale entries from prior runs include known-wrong outputs surfaced by
          // eval. Cleanest path: flush. New entries will be re-computed correctly.
          this.db!.run('DELETE FROM amazon_shopify_category_mappings');
        },
      },
    ];

    const isApplied = this.db.query<{ name: string }, [string]>(
      'SELECT name FROM schema_migrations WHERE name = ?',
    );
    const recordApplied = this.db.query(
      'INSERT INTO schema_migrations (name) VALUES (?)',
    );

    for (const m of migrations) {
      if (isApplied.get(m.name)) continue;
      console.log(`Running migration: ${m.name}`);
      m.up();
      recordApplied.run(m.name);
    }
  }

  private prepareStatements(): void {
    if (!this.db) return;
    this.getStmt = this.db.query(`
      SELECT amazon_category, shopify_category_id, shopify_category_gid,
             shopify_full_name, confidence, created_by, created_at
      FROM amazon_shopify_category_mappings
      WHERE amazon_category = ?
      LIMIT 1
    `);
    this.upsertStmt = this.db.query(`
      INSERT INTO amazon_shopify_category_mappings
        (amazon_category, shopify_category_id, shopify_category_gid,
         shopify_full_name, confidence, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (amazon_category) DO UPDATE SET
        shopify_category_id = excluded.shopify_category_id,
        shopify_category_gid = excluded.shopify_category_gid,
        shopify_full_name = excluded.shopify_full_name,
        confidence = excluded.confidence,
        updated_at = CURRENT_TIMESTAMP
    `);
    this.statsTotal = this.db.query(
      'SELECT COUNT(*) as count FROM amazon_shopify_category_mappings',
    );
    this.statsByConfidence = this.db.query(`
      SELECT confidence, COUNT(*) as count
      FROM amazon_shopify_category_mappings
      GROUP BY confidence
    `);
    this.statsBySource = this.db.query(`
      SELECT created_by, COUNT(*) as count
      FROM amazon_shopify_category_mappings
      GROUP BY created_by
    `);
  }
}
