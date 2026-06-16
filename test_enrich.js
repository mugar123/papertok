import { enrichPapersBatch } from './src/services/openAlexService.js';
enrichPapersBatch(['1502.01589', '1008.2026']).then(res => {
  console.log(JSON.stringify(res, null, 2));
}).catch(console.error);
