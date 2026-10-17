import { fetchPapersByIds } from '../../src/services/arxivService.ts';
fetchPapersByIds([
  '1008.2026',        'arxiv.1207.7214',
  '1502.01589',       '0611399'
]).then(console.log).catch(console.error);
