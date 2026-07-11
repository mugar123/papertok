import { fetchPapers } from './src/services/arxivService.js';
import { CATEGORIES } from './src/data/categories.js';

const physicsCats = Object.keys(CATEGORIES.physics.subcategories);
console.log("Fetching for:", physicsCats);

fetchPapers(physicsCats, 0, 5, 'recent', 'submittedDate').then(papers => {
  console.log("Papers found:", papers.length);
  if (papers.length > 0) {
    console.log("First paper:", papers[0].title);
  } else {
    console.log("NO PAPERS FOUND.");
  }
}).catch(err => {
  console.error("Error fetching:", err);
});
