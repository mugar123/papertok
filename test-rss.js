async function run() {
  const cats = [
    'astro-ph.GA', 'astro-ph.CO', 'astro-ph.EP', 'astro-ph.HE', 'astro-ph.IM', 'astro-ph.SR',
    'cond-mat.dis-nn', 'cond-mat.mes-hall', 'cond-mat.mtrl-sci', 'cond-mat.other', 'cond-mat.quant-gas',
    'cond-mat.soft', 'cond-mat.stat-mech', 'cond-mat.str-el', 'cond-mat.supr-con',
    'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'math-ph',
    'nlin.AO', 'nlin.CG', 'nlin.CD', 'nlin.SI', 'nlin.PS',
    'nucl-ex', 'nucl-th',
    'physics.acc-ph', 'physics.ao-ph', 'physics.app-ph', 'physics.atm-clus', 'physics.atom-ph',
    'physics.bio-ph', 'physics.chem-ph', 'physics.class-ph', 'physics.comp-ph', 'physics.data-an',
    'physics.flu-dyn', 'physics.gen-ph', 'physics.geo-ph', 'physics.hist-ph', 'physics.ins-det',
    'physics.med-ph', 'physics.optics', 'physics.ed-ph', 'physics.soc-ph', 'physics.pop-ph', 'physics.space-ph',
    'quant-ph'
  ];

  const searchQuery = `(${cats.map(c => `cat:${c}`).join(' OR ')})`;
  const params = new URLSearchParams({ search_query: searchQuery, start: '0', max_results: '15', sortBy: 'submittedDate', sortOrder: 'descending' });
  const arxivUrl = `https://export.arxiv.org/api/query?${params.toString()}`;
  
  const cleanUrl = arxivUrl.replace(/[\(\)]/g, '');
  const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(cleanUrl)}`;
  const res = await fetch(proxyUrl);
  const data = await res.json();
  console.log("Status from rss2json:", data.status);
  if (data.status === 'ok') {
     console.log("Items count:", data.items.length);
     if (data.items.length > 0) {
        console.log("First item cat:", data.items[0].categories);
     }
  } else {
     console.log("Message:", data.message);
  }
}
run();
