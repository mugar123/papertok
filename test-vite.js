import { fetchPapers } from './src/services/arxivService.js';
fetchPapers(['quant-ph'], 0, 5)
  .then(res => {
    console.log('Fetched:', res.length);
    console.log('First:', res[0]?.title);
  })
  .catch(console.error);
