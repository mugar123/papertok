async function testProxy() {
  const apiKey = 'bdc404141006d6a4bb2964ed65547288';
  const query = `"Dynamics & Robotics"`;
  const rawUrl = `https://api.elsevier.com/content/search/scopus?query=TITLE-ABS-KEY(${encodeURIComponent(query)})&start=0&count=25&apiKey=${apiKey}`;
  const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(rawUrl)}`;
  
  try {
    const res = await fetch(proxyUrl, {
      headers: {
        'Origin': 'https://mugar123.github.io',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response text length:", text.length);
    if (text.length < 500) {
      console.log("Text:", text);
    } else {
      console.log("Success with corsproxy.io!");
    }
  } catch (e) {
    console.error("Fetch error:", e);
  }
}

testProxy();
