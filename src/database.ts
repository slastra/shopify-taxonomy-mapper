import { Database, Statement } from 'bun:sqlite';
import type { Alternative, Confidence, StoredMapping } from './types.js';
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
  feedback: number;
}

interface MappingRow {
  shopify_category_id: string;
  shopify_full_name: string;
  confidence: Confidence;
  score: number | null;
  alternatives: string | null;
  created_by: StoredMapping['source'];
  model: string | null;
  mapper_version: string | null;
}

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS amazon_shopify_category_mappings (
    amazon_category TEXT PRIMARY KEY,
    shopify_category_id TEXT NOT NULL,
    shopify_category_gid TEXT NOT NULL,
    shopify_full_name TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK(confidence IN ('high', 'medium', 'low')),
    score REAL,
    created_by TEXT NOT NULL CHECK(created_by IN ('llm', 'jev', 'manual')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    alternatives TEXT,
    model TEXT,
    mapper_version TEXT
  )
`;
const INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_shopify_category_id
  ON amazon_shopify_category_mappings(shopify_category_id)
`;
// Every correction a person submits, kept as labels for evaluation and calibration.
const FEEDBACK_DDL = `
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input_key TEXT NOT NULL,
    node_id TEXT NOT NULL,
    previous_node_id TEXT,
    item TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

export class MappingCache {
  private db: Database | null = null;
  private getStmt!: Statement<MappingRow, [string]>;
  private upsertStmt!: Statement<unknown, [string, string, string, string, Confidence, number | null, string, string, string | null, string | null]>;
  private feedbackStmt!: Statement<unknown, [string, string, string | null, string]>;
  private statsTotal!: Statement<{ count: number }, []>;
  private statsByConfidence!: Statement<{ confidence: string; count: number }, []>;
  private statsBySource!: Statement<{ created_by: string; count: number }, []>;
  private statsFeedback!: Statement<{ count: number }, []>;

  connect(dbPath: string = './data/mappings.db'): void {
    this.db = new Database(dbPath, { create: true });
    this.initializeSchema();
    this.runMigrations();
    this.prepareStatements();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  get(key: string): StoredMapping | null {
    if (!this.db) throw new Error('Database not connected');
    const row = this.getStmt.get(normalizeKey(key));
    if (!row) return null;
    return {
      node_id: row.shopify_category_id,
      full_name: row.shopify_full_name,
      confidence: row.confidence,
      score: row.score,
      alternatives: row.alternatives ? JSON.parse(row.alternatives) as Alternative[] : [],
      source: row.created_by,
      model: row.model,
      mapper_version: row.mapper_version,
    };
  }

  save(key: string, mapping: StoredMapping): boolean {
    if (!this.db) throw new Error('Database not connected');
    try {
      this.upsertStmt.run(
        normalizeKey(key),
        mapping.node_id,
        toGid(mapping.node_id),
        mapping.full_name,
        mapping.confidence,
        mapping.score,
        mapping.source,
        JSON.stringify(mapping.alternatives),
        mapping.model,
        mapping.mapper_version,
      );
      return true;
    } catch (error) {
      console.error('Error saving mapping:', error);
      return false;
    }
  }

  recordFeedback(key: string, nodeId: string, previousNodeId: string | null, item: unknown): void {
    if (!this.db) throw new Error('Database not connected');
    this.feedbackStmt.run(normalizeKey(key), nodeId, previousNodeId, JSON.stringify(item));
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
    return { total, byConfidence, bySource, feedback: this.statsFeedback.get()?.count ?? 0 };
  }

  private initializeSchema(): void {
    if (!this.db) return;
    this.db.run(TABLE_DDL);
    this.db.run(INDEX_DDL);
    this.db.run(FEEDBACK_DDL);
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
      {
        name: '2026-10_jev_source_and_score',
        up: () => {
          // Mappings now come from Jev. SQLite can't alter a CHECK constraint, so
          // rebuild the table to allow created_by='jev' and add the path score.
          // Existing rows keep created_by='llm' (Nova-era) so they can be told
          // apart or flushed selectively.
          const db = this.db!;
          db.transaction(() => {
            db.run('ALTER TABLE amazon_shopify_category_mappings RENAME TO mappings_pre_jev');
            db.run(TABLE_DDL);
            db.run(`
              INSERT INTO amazon_shopify_category_mappings
                (amazon_category, shopify_category_id, shopify_category_gid, shopify_full_name,
                 confidence, score, created_by, created_at, updated_at)
              SELECT amazon_category, shopify_category_id, shopify_category_gid, shopify_full_name,
                     confidence, NULL, created_by, created_at, updated_at
              FROM mappings_pre_jev
            `);
            db.run('DROP TABLE mappings_pre_jev');
            db.run(INDEX_DDL);
          })();
        },
      },
      {
        name: '2026-10_alternatives_and_provenance',
        up: () => {
          // Runner-up categories, plus which model and mapper version produced a
          // row, so a later upgrade can re-map just the rows it would change.
          // Tables created from the current TABLE_DDL already have these columns.
          const db = this.db!;
          const existing = new Set(
            db.query<{ name: string }, []>('PRAGMA table_info(amazon_shopify_category_mappings)').all().map(c => c.name),
          );
          for (const column of ['alternatives', 'model', 'mapper_version']) {
            if (!existing.has(column)) db.run(`ALTER TABLE amazon_shopify_category_mappings ADD COLUMN ${column} TEXT`);
          }
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
      SELECT shopify_category_id, shopify_full_name, confidence, score,
             alternatives, created_by, model, mapper_version
      FROM amazon_shopify_category_mappings
      WHERE amazon_category = ?
      LIMIT 1
    `);
    this.upsertStmt = this.db.query(`
      INSERT INTO amazon_shopify_category_mappings
        (amazon_category, shopify_category_id, shopify_category_gid,
         shopify_full_name, confidence, score, created_by,
         alternatives, model, mapper_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (amazon_category) DO UPDATE SET
        shopify_category_id = excluded.shopify_category_id,
        shopify_category_gid = excluded.shopify_category_gid,
        shopify_full_name = excluded.shopify_full_name,
        confidence = excluded.confidence,
        score = excluded.score,
        created_by = excluded.created_by,
        alternatives = excluded.alternatives,
        model = excluded.model,
        mapper_version = excluded.mapper_version,
        updated_at = CURRENT_TIMESTAMP
    `);
    this.feedbackStmt = this.db.query(
      'INSERT INTO feedback (input_key, node_id, previous_node_id, item) VALUES (?, ?, ?, ?)',
    );
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
    this.statsFeedback = this.db.query('SELECT COUNT(*) as count FROM feedback');
  }
}
