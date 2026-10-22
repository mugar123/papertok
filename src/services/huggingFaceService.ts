import { cleanText, mapHuggingFaceResources } from './huggingFaceRecords.ts';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 8_000;

export async function getHuggingFaceResearchResources(arxivId: unknown) {
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
