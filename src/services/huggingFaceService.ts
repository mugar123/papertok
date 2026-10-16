import { PaperBuilder } from './PaperBuilder.ts';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 8_000;

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function resource(kind, id, title, url, metadata = {}) {
  const safeResourceUrl = safeUrl(url);
  if (!id || !safeResourceUrl) return null;
  return { kind, id: `${kind}:${id}`, title: cleanText(title || id), url: safeResourceUrl, ...metadata };
}

function uniqueResources(items) {
  const seen = new Set();
  return items.filter(Boolean).filter(item => {
    const key = `${item.kind}:${item.url}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mapHuggingFaceResources(payload) {
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

export function mapHuggingFacePaper(raw, requestedCategories = []) {
  const paper = raw?.paper || raw;
  const arxivId = cleanText(paper?.id || raw?.id).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
  const title = cleanText(paper?.title || raw?.title);
  if (!arxivId || !title) return null;

  const published = paper?.publishedAt || raw?.publishedAt || '';
  const keywords = [...new Set((paper?.ai_keywords || raw?.ai_keywords || []).map(cleanText).filter(Boolean))];
  const primaryCategory = requestedCategories[0] || '';
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
        name: cleanText(author?.name || author),
        ...(author?.user ? { id: String(author.user) } : {}),
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
    categories: primaryCategory ? [primaryCategory] : [],
    primaryCategory,
    researchResources,
    provider: 'huggingface',
  });
}

export async function getHuggingFaceResearchResources(arxivId) {
  const normalizedId = cleanText(arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
  if (!PAPER_API_BASE || !normalizedId) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(`${PAPER_API_BASE}/resources/huggingface`);
    url.searchParams.set('arxiv_id', normalizedId);
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return [];
    return mapHuggingFaceResources(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
