export interface CategoryReference {
  id: string;
  name: string;
}

export interface TaxonomyAttribute {
  id: string;
  name: string;
}

export interface Category {
  id: string;
  level: number;
  name: string;
  full_name: string;
  parent_id: string | null;
  attributes: TaxonomyAttribute[];
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

export interface SearchResult {
  category: Category;
  score: number;
  matchType: 'exact' | 'partial' | 'fuzzy';
}

export interface CategoryMetadata {
  id: string;
  name: string;
  full_name: string;
  level: number;
  is_leaf: boolean;
  children_count: number;
  parent_id: string | null;
}

export interface CategoryMapping {
  amazon_category: string;
  shopify_category_id: string;
  shopify_category_gid: string;
  shopify_full_name: string;
  confidence: 'high' | 'medium' | 'low';
  created_by: 'llm' | 'manual';
  created_at: Date;
}
