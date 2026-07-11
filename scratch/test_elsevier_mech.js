import { ElsevierAdapter } from '../src/services/adapters/ElsevierAdapter.js';
import CATEGORIES from '../src/data/categories.js';

async function testMech() {
  const elsevierAdapter = new ElsevierAdapter();
  
  // "mech.dyn": "Dynamics & Robotics"
  // Let's test the query that gets built
  const elsevierQuery = '"Dynamics & Robotics"';
  
  console.log("Querying Elsevier for:", elsevierQuery);
  const res = await elsevierAdapter.search(elsevierQuery, 1);
  console.log("Papers found:", res.papers.length);
  console.log("Total:", res.total);
}

testMech().catch(console.error);
