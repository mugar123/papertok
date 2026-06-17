import { fetchPapersByDois } from './src/services/openAlexService.js';
fetchPapersByDois(['10.1038/s41598-025-96882-y']).then(console.log).catch(console.error);
