import { JSDOM } from 'jsdom';
const dom = new JSDOM();
global.DOMParser = dom.window.DOMParser;
global.window = dom.window;

import { getScientificReport } from './src/services/scientificReportService.js';

async function run() {
  console.log("Fetching page 1...");
  const report1 = await getScientificReport('7d', 1, {});
  const papers1 = [report1.mainDiscovery, ...report1.highlights].filter(Boolean);
  console.log(`Page 1 fetched: ${papers1.length} papers`);
  papers1.slice(0, 3).forEach((p, i) => console.log(`  ${i+1}. ${p.title.substring(0, 60)} (${p.citationCount} citations)`));

  console.log("\nFetching page 2...");
  const report2 = await getScientificReport('7d', 2, {});
  const papers2 = [report2.mainDiscovery, ...report2.highlights].filter(Boolean);
  console.log(`Page 2 fetched: ${papers2.length} papers`);
  papers2.slice(0, 3).forEach((p, i) => console.log(`  ${i+1}. ${p.title.substring(0, 60)} (${p.citationCount} citations)`));

  // Check overlap
  const ids1 = new Set(papers1.map(p => p.id));
  const overlap = papers2.filter(p => ids1.has(p.id));
  console.log(`\nOverlap between Page 1 and Page 2: ${overlap.length} papers`);
  if (overlap.length > 0) {
    console.log("Overlap IDs:", overlap.map(p => p.id));
  } else {
    console.log("SUCCESS: Page 1 and Page 2 have completely different papers.");
  }
}

run().catch(console.error);
