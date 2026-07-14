const url = 'https://api.openalex.org/works?filter=has_doi:true,authorships.institutions.country_code:es&per-page=1&mailto=app@papertok.io';
fetch(url)
  .then(r => r.json())
  .then(d => console.log('Country filter ES count:', d.meta.count))
  .catch(console.error);

const url2 = 'https://api.openalex.org/works?filter=has_doi:true,institutions.country_code:es&per-page=1&mailto=app@papertok.io';
fetch(url2)
  .then(r => r.json())
  .then(d => console.log('Country filter (institutions) ES count:', d.meta.count))
  .catch(console.error);
