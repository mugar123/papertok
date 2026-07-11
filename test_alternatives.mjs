async function testAlternativeAPIs() {
  // Test ROR for institutions
  const rorUrl = 'https://api.ror.org/organizations?query=mit';
  const rorRes = await fetch(rorUrl);
  if (rorRes.ok) {
    const rorData = await rorRes.json();
    console.log("ROR OK. First result:", rorData.items[0].name);
  } else {
    console.log("ROR Failed", rorRes.status);
  }

  // Test Semantic Scholar for Authors
  const s2AuthUrl = 'https://api.semanticscholar.org/graph/v1/author/search?query=einstein&limit=5&fields=name,url,paperCount,citationCount';
  const s2AuthRes = await fetch(s2AuthUrl);
  if (s2AuthRes.ok) {
    const s2Data = await s2AuthRes.json();
    console.log("S2 Authors OK. First result:", s2Data.data[0].name);
  } else {
    console.log("S2 Authors Failed", s2AuthRes.status);
  }

  // Test Semantic Scholar for Trending
  const s2TrendUrl = 'https://api.semanticscholar.org/graph/v1/paper/search?query=review&year=2024&limit=5&fields=title,authors,year,citationCount,openAccessPdf';
  const s2TrendRes = await fetch(s2TrendUrl);
  if (s2TrendRes.ok) {
    const s2Data = await s2TrendRes.json();
    console.log("S2 Trending OK. First result:", s2Data.data[0].title);
  } else {
    console.log("S2 Trending Failed", s2TrendRes.status);
  }
}
testAlternativeAPIs();
