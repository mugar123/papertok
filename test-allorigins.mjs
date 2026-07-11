const query = 'cat:quant-ph OR cat:cond-mat.supr-con OR cat:cond-mat.str-el OR cat:cond-mat.mtrl-sci OR cat:cond-mat.mes-hall OR cat:cond-mat.stat-mech OR cat:cond-mat.soft OR cat:cond-mat.quant-gas OR cat:hep-th OR cat:hep-ph OR cat:hep-ex OR cat:astro-ph.CO OR cat:astro-ph.GA OR cat:astro-ph.SR OR cat:astro-ph.HE OR cat:astro-ph.EP OR cat:gr-qc OR cat:math-ph OR cat:nucl-th OR cat:nucl-ex OR cat:physics.optics OR cat:physics.atom-ph OR cat:physics.flu-dyn OR cat:physics.plasm-ph OR cat:physics.bio-ph OR cat:physics.comp-ph';
const params = new URLSearchParams({
  search_query: query,
  start: 0,
  max_results: 5,
  sortBy: 'submittedDate',
  sortOrder: 'descending'
});
const url = `https://export.arxiv.org/api/query?${params.toString()}`;
const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
console.log('Proxy URL length:', proxyUrl.length);

fetch(proxyUrl)
  .then(res => res.json())
  .then(json => {
     if (json.contents) {
        console.log('Success, length:', json.contents.length);
        console.log(json.contents.substring(0, 100));
     } else {
        console.log('No contents', json);
     }
  })
  .catch(console.error);
