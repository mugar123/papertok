import { getPapersByProject } from './src/services/openAireService.js';
import { fetchPapersByIds } from './src/services/arxivService.js';
import { fetchPapersByDois } from './src/services/openAlexService.js';

async function test() {
  const { arxivIds, dois, total } = await getPapersByProject('101079773', 1);
  console.log('Arxiv IDs:', arxivIds);
  console.log('DOIs:', dois);
  
  if (arxivIds.length > 0) {
    const arxivPapers = await fetchPapersByIds(arxivIds);
    console.log(`Fetched ${arxivPapers.length} arXiv papers.`);
  }
  if (dois.length > 0) {
    const doiPapers = await fetchPapersByDois(dois);
    console.log(`Fetched ${doiPapers.length} DOI papers.`);
  }
}
test().catch(console.error);
