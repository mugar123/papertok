import { fetchPapers } from './src/services/arxivService.js';

async function run() {
  const prefs = ['physics.optics', 'physics.app-ph'];
  console.log("Fetching papers for physics.optics, physics.app-ph...");
  const res = await fetchPapers(prefs, 0, 15, 'relevance');
  console.log("Found:", res.length);
  if (res.length > 0) {
     console.log("First:", res[0].title);
     console.log("Cats:", res[0].allCategories);
  }
}
run();
