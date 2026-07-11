async function testProxy() {
  const apiKey = 'bdc404141006d6a4bb2964ed65547288';
  const query = `"Dynamics & Robotics" OR "Fluid Mechanics" OR "Thermodynamics" OR "Solid Mechanics" OR "Aerospace Engineering" OR "Manufacturing" OR "CAD & Simulation" OR "Automotive Engineering" OR "Acoustics & Vibrations" OR "Structural Engineering" OR "Geotechnical Engineering" OR "Hydraulic Engineering" OR "Transportation" OR "Earthquake Engineering" OR "Environmental Engineering" OR "Construction Materials" OR "Urban Planning" OR "Chemical Processes & Catalysis" OR "Polymer Engineering" OR "Nanotechnology" OR "Energy & Batteries" OR "Bioengineering" OR "Metallurgy" OR "Ceramics & Composites" OR "Separation Technologies"`;
  const rawUrl = `https://api.elsevier.com/content/search/scopus?query=TITLE-ABS-KEY(${query})&start=0&count=25&apiKey=${apiKey}`;
  const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(rawUrl)}`;
  
  try {
    const res = await fetch(proxyUrl);
    
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
