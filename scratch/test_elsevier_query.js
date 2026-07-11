import CATEGORIES from '../src/data/categories.js';

const allCategories = Object.values(CATEGORIES).flatMap(a => 
  Object.entries(a.subcategories || {}).map(([id, label]) => ({ id, labelEn: label.labelEn }))
);

let allEngCats = [];
for (const key of Object.keys(CATEGORIES)) {
  if (key === 'engineering' || key === 'elec' || key === 'mech' || key === 'civil' || key === 'chemeng') {
     allEngCats = allEngCats.concat(Object.keys(CATEGORIES[key].subcategories || {}));
  }
}

const elsevierQuery = allEngCats.map(c => {
  const cat = allCategories.find(x => x.id === c);
  return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
}).join(' OR ');

console.log("Query Length:", elsevierQuery.length);
console.log("Query:", elsevierQuery);

const encoded = encodeURIComponent(`TITLE-ABS-KEY(${elsevierQuery})`);
console.log("Encoded length:", encoded.length);
