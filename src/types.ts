export interface CategoryReference {
  id: string;
  name: string;
}

export interface Category {
  id: string;
  level: number;
  name: string;
  full_name: string;
  parent_id: string | null;
  children: CategoryReference[];
  ancestors: CategoryReference[];
}

export interface Vertical {
  name: string;
  prefix: string;
  categories: Category[];
}

export interface TaxonomyData {
  version: string;
  verticals: Vertical[];
}

export type Confidence = 'high' | 'medium' | 'low';

/** A runner-up category from the final comparison. */
export interface Alternative {
  node_id: string;
  full_name: string;
  score: number;
}

/** A mapping as stored in (and read back from) the result cache. */
export interface StoredMapping {
  node_id: string;
  full_name: string;
  confidence: Confidence;
  score: number | null;
  alternatives: Alternative[];
  /** llm: Nova-era row; jev: computed by the mapper; manual: a person's correction. */
  source: 'llm' | 'jev' | 'manual';
  model: string | null;
  mapper_version: string | null;
}
