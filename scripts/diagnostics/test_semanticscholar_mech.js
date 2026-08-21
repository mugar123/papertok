import { SemanticScholarAdapter } from '../../src/services/adapters/SemanticScholarAdapter.js';

async function testMech() {
  const semanticScholarAdapter = new SemanticScholarAdapter();

  // "mech.dyn": "Dynamics & Robotics"
  // Let's test the query that gets built
  const query = '"Dynamics & Robotics"';

  console.log("Querying Semantic Scholar for:", query);
  const res = await semanticScholarAdapter.search(query, 1);
  console.log("Papers found:", res.papers.length);
  console.log("Total:", res.total);
}

testMech().catch(console.error);
