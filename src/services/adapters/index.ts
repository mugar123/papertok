import type { Paper } from '../../models/Paper.ts';

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

export { SemanticScholarAdapter } from './SemanticScholarAdapter.ts';
export { PubmedAdapter } from './PubmedAdapter.ts';
export { ScopusAdapter, isScopusEnabled } from './ScopusAdapter.ts';
