import type { PaperSubject } from '../../models/Paper.ts';

// Raw provider records; normalized results use Paper.
export interface OpenAlexWork {
  id?: string;
  title?: string;
  display_name?: string;
  language?: string;
  doi?: string | null;
  ids?: { doi?: string | null; pmid?: string | null; [key: string]: string | null | undefined };
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: Array<{ raw_author_name?: string; author?: { id?: string | null; display_name?: string }; institutions?: Array<{ id?: string; display_name?: string; ror?: string | null }> }>;
  publication_year?: number | null;
  publication_date?: string;
  type?: string;
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  locations?: OpenAlexLocation[];
  open_access?: { is_oa?: boolean; oa_url?: string | null; oa_status?: string };
  cited_by_count?: number | null;
  referenced_works?: string[];
  related_works?: string[];
  fwci?: number | null;
  concepts?: Array<PaperSubject & { display_name: string }>;
  topics?: Array<PaperSubject & { display_name: string }>;
  primary_topic?: PaperSubject | null;
}

export interface OpenAlexLocation {
  id?: string;
  pdf_url?: string | null;
  landing_page_url?: string | null;
  source?: { id?: string; display_name?: string; type?: string; host_organization_name?: string } | null;
  is_oa?: boolean;
  is_published?: boolean;
  license?: string | null;
}

export interface OpenAlexPage<T> { results?: T[]; meta?: { count?: number }; }

export interface EntityMetrics {
  works_count?: number | null;
  cited_by_count?: number | null;
  summary_stats?: { h_index?: number | null; '2yr_mean_citedness'?: number | null } | null;
  metrics_are_partial?: boolean;
}

export interface OpenAlexInstitution extends EntityMetrics {
  id: string;
  display_name: string;
  ror?: string | null;
  localized_names?: Record<string, string>;
  localizedNames?: Record<string, string>;
  aliases?: string[];
  acronyms?: string[];
  country_code?: string;
  type?: string;
  types?: string[];
  geo?: { city?: string; country?: string; country_code?: string; latitude?: number | null; longitude?: number | null };
  domains?: string[];
  established?: number | null;
  homepage_url?: string | null;
  wikipedia_url?: string | null;
  relationships?: Array<{ id?: string; rorId: string; label?: string; type?: string }>;
  status?: string;
  rorVerified?: boolean;
  _metadataSource?: string;
  _rorId?: string;
}

export interface OpenAlexAuthor extends EntityMetrics {
  source?: string;
  last_known_institution?: Partial<OpenAlexInstitution>;
  localizedInstitutionName?: string;
  id: string;
  display_name: string;
  h_index?: number | null;
  orcid?: string | null;
  institution?: string | null;
  institutionData?: Partial<OpenAlexInstitution>;
  last_known_institutions?: Array<Partial<OpenAlexInstitution>>;
  x_concepts?: PaperSubject[];
  concepts?: PaperSubject[];
  verified?: boolean;
}

export interface OpenAlexTopic extends Partial<PaperSubject>, EntityMetrics {
  id: string;
  display_name: string;
  label?: string;
  description?: string;
  hint?: string;
  categoryIds?: string[];
  subcategoryCount?: number;
  parent_display_name?: string;
  field_display_name?: string;
  keywords?: string[];
  _localTopic?: boolean;
}
