import { fetchPapers } from './src/services/arxivService.js';
async function run() {
  try {
    const res = await fetchPapers(['cs.AI'], 0, 10, 'recent');
    console.log("Papers:", res.length);
  } catch (err) {
    console.error("Error:", err);
  }
}
run();
