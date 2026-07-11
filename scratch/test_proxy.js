async function testProxy() {
  const apiKey = 'bdc404141006d6a4bb2964ed65547288';
  const rawUrl = `https://api.elsevier.com/content/search/scopus?query=TITLE-ABS-KEY("Dynamics %26 Robotics")&start=0&count=25&apiKey=${apiKey}`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(rawUrl)}`;
  
  try {
    const res = await fetch(proxyUrl);
    
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response text length:", text.length);
    if (text.length < 500) {
      console.log("Text:", text);
    } else {
      const data = JSON.parse(text);
      if (data.contents) {
        const parsed = JSON.parse(data.contents);
        console.log("Results count:", parsed['search-results']?.entry?.length);
      } else {
        console.log("No contents:", data);
      }
    }
  } catch (e) {
    console.error("Fetch error:", e);
  }
}

testProxy();
