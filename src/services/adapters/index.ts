import type { Paper } from '../../models/paper.ts';

export interface PaperSearchFilters {
  type?: string;
  internalCategories?: string[];
  signal?: AbortSignal;
  priority?: boolean;
  types?: readonly string[];
  terms?: string[];
  limit?: number;
  sort?: string;
  typeahead?: boolean;
  /** Only records the provider holds an abstract for. */
  requireAbstract?: boolean;
}
export interface PaperSearchResult {
  papers: Paper[];
  total: number;
  unavailable?: boolean;
  quota?: unknown;
}

export { SemanticScholarAdapter } from './semantic-scholar-adapter.ts';
export { PubmedAdapter } from './pubmed-adapter.ts';
export { ScopusAdapter, isScopusEnabled } from './scopus-adapter.ts';
