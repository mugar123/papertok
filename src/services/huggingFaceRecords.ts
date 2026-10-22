import type { Paper, PaperResearchResource } from '../models/Paper.ts';
export interface HuggingFaceResources {
  linkedModels?: Array<{ id: string; downloads?: number; likes?: number }>;
  linkedDatasets?: Array<{ id: string; downloads?: number; likes?: number }>;
  githubRepo?: string; projectPage?: string;
}
export interface HuggingFaceRecord extends HuggingFaceResources {
  paper?: HuggingFaceRecord; id?: string; title?: string; publishedAt?: string; summary?: string;
  ai_keywords?: string[]; upvotes?: number;
  authors?: Array<string | { name?: string; user?: string }>;
}

import { PaperBuilder } from './PaperBuilder.ts';

// Hugging Face's papers and linked resources as the app's, for the browser and
// the Worker's paper store alike.

export function cleanText(value: unknown) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function resource(kind: string, id: string, title: string, url: string, metadata: Pick<PaperResearchResource, 'downloads' | 'likes'> = {}): PaperResearchResource | null {
  const safeResourceUrl = safeUrl(url);
  if (!id || !safeResourceUrl) return null;
  return { kind, id: `${kind}:${id}`, title: cleanText(title || id), url: safeResourceUrl, ...metadata };
}

function uniqueResources(items: Array<PaperResearchResource | null>): PaperResearchResource[] {
  const seen = new Set<string>();
  return (items.filter(Boolean) as PaperResearchResource[]).filter(item => {
    const key = `${item.kind}:${item.url}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mapHuggingFaceResources(payload: HuggingFaceResources | null) {
  const models = (payload?.linkedModels || []).map(item => resource(
    'model',
    item.id,
    item.id,
    `https://huggingface.co/${item.id}`,
    { downloads: Number(item.downloads) || 0, likes: Number(item.likes) || 0 },
  ));
  const datasets = (payload?.linkedDatasets || []).map(item => resource(
    'dataset',
    item.id,
    item.id,
    `https://huggingface.co/datasets/${item.id}`,
    { downloads: Number(item.downloads) || 0, likes: Number(item.likes) || 0 },
  ));
  const github = payload?.githubRepo
    ? resource('software', payload.githubRepo, 'GitHub', payload.githubRepo)
    : null;
  const projectPage = payload?.projectPage
    ? resource('material', payload.projectPage, 'Project page', payload.projectPage)
    : null;
  return uniqueResources([...models, ...datasets, github, projectPage]).slice(0, 8);
}

export function mapHuggingFacePaper(raw: HuggingFaceRecord, requestedCategories: string[] = []): Paper | null {
  const paper = raw?.paper || raw;
  const arxivId = cleanText(paper?.id || raw?.id).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
  const title = cleanText(paper?.title || raw?.title);
  if (!arxivId || !title) return null;

  const published = paper?.publishedAt || raw?.publishedAt || '';
  const keywords = [...new Set((paper?.ai_keywords || raw?.ai_keywords || []).map(cleanText).filter(Boolean))];
  const researchResources = mapHuggingFaceResources({
    githubRepo: paper?.githubRepo || raw?.githubRepo,
    projectPage: paper?.projectPage || raw?.projectPage,
  });

  return PaperBuilder.create({
    id: `arxiv:${arxivId}`,
    sources: { primary: 'huggingface', enrichedBy: [] },
    title,
    abstract: cleanText(paper?.summary || raw?.summary),
    authors: (paper?.authors || raw?.authors || [])
      .map(author => ({
        name: cleanText((author as { name?: string })?.name || author),
        ...((author as { user?: string })?.user ? { id: String((author as { user?: string }).user) } : {}),
      }))
      .filter(author => author.name),
    arxivId,
    huggingFaceId: arxivId,
    huggingFaceUrl: `https://huggingface.co/papers/${encodeURIComponent(arxivId)}`,
    huggingFaceUpvotes: Number(paper?.upvotes ?? raw?.upvotes) || 0,
    year: published ? new Date(published).getUTCFullYear() : new Date().getUTCFullYear(),
    published,
    publicationType: 'preprint',
    publicationStatus: 'preprint',
    peerReviewed: false,
    openAccess: true,
    pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
    landingPageUrl: `https://arxiv.org/abs/${arxivId}`,
    keywords,
    concepts: keywords.map((keyword, index) => ({
      id: `huggingface:${arxivId}:keyword:${index}`,
      display_name: keyword,
      level: 2,
    })),
    // Hugging Face lists no arXiv category; the searched one is only why the
    // paper was fetched.
    _fetchedFor: requestedCategories,
    researchResources,
    provider: 'huggingface',
  });
}

