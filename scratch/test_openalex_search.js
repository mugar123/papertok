async function searchOpenAlex() {
  const query = `"Dynamics & Robotics"`;
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5&mailto=papertok@example.com`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(data);
}
searchOpenAlex();
