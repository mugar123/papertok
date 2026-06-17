import { fetchPapersByIds } from './src/services/arxivService.js';
fetchPapersByIds([2507.18226, 2507.11219, 2410.06684]).then(console.log).catch(console.error);
