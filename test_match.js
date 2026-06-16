function matchAuthor(reqName, oaName) {
  const reqParts = reqName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  const oaParts = oaName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  
  // If all parts of one are present in the other
  const reqInOa = reqParts.every(p => oaParts.some(o => o.includes(p) || p.includes(o)));
  const oaInReq = oaParts.every(o => reqParts.some(p => p.includes(o) || o.includes(p)));
  
  return reqInOa || oaInReq;
}

console.log(matchAuthor("K. M. Bekarian", "Bekarian, K. M."));
console.log(matchAuthor("M. K. Mak", "Mak M.K."));
console.log(matchAuthor("Jane Doe", "Doe, Jane E."));
console.log(matchAuthor("Jane Doe", "Smith, John"));
