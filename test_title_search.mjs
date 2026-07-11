async function testOpenAlex() {
  const url = 'https://api.openalex.org/works?filter=title.search:physics,type:article|proceedings-article&page=1&per-page=5';
  const response = await fetch(url);
  const data = await response.json();
  console.log("Status:", response.status);
  if (!response.ok) {
    console.log("Error data:", data);
  } else {
    console.log("Found:", data.meta.count);
    console.log("First paper:", data.results[0].title);
  }
}
testOpenAlex();
