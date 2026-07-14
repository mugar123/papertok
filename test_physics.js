import { getScientificReport } from './src/services/scientificReportService.js';
async function test() {
  console.log("Fetching physics 7d...");
  const report = await getScientificReport('7d', 1, { categories: ['physics'] });
  console.log(report.mainDiscovery ? `Main discovery: ${report.mainDiscovery.title}` : 'No main discovery');
  console.log(report.highlights ? `Highlights: ${report.highlights.length}` : 'No highlights');
  console.log(report.trends ? `Trends length: ${report.trends.length}` : 'No trends');
}
test().catch(console.error);
