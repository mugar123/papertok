async function testProxy() {
  const apiKey = 'bdc404141006d6a4bb2964ed65547288';
  const query = `"Dynamics & Robotics" OR "Fluid Mechanics"`;
  const rawUrl = `https://api.elsevier.com/content/search/scopus?query=TITLE-ABS-KEY(${encodeURIComponent(query)})&start=0&count=25&apiKey=${apiKey}`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(rawUrl)}`;
  
  try {
    const res = await fetch(proxyUrl);
    console.log("Status:", res.status);
    const text = await res.text();
    if (text.length < 500) {
      console.log("Text:", text);
    } else {
      console.log("Success with 2 categories on allorigins!");
    }
  } catch (e) {
    console.error("Fetch error:", e);
  }
}
testProxy();
