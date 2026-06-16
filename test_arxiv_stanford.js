global.import = { meta: { env: { DEV: false } } };
import { fetchPapersByIds } from './src/services/arxivService.js';
import { getWorksByEntity } from './src/services/openAlexService.js';

getWorksByEntity('institution', 'I97018004').then(arxivIds => {
  console.log("Fetched IDs from OpenAlex:", arxivIds);
  fetchPapersByIds(arxivIds).then(papers => {
    console.log("Successfully fetched papers:", papers.length);
  }).catch(err => {
    console.error("Error fetching papers:", err);
  });
});
