/**
 * Lightweight TF-IDF Implementation for PaperTok
 * Used to extract keywords and compute similarity between paper abstracts.
 */

const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'can','need','must','it','its','this','that','these','those','i','me','my',
  'we','us','our','you','your','he','him','his','she','her','they','them',
  'their','what','which','who','whom','where','when','why','how','all','each',
  'every','both','few','more','most','other','some','such','no','not','only',
  'own','same','so','than','too','very','just','because','if','then','else',
  'also','about','up','out','into','over','after','before','between','under',
  'above','below','through','during','without','within','along','following',
  'across','behind','beyond','plus','except','since','until','against','among',
  'throughout','despite','towards','upon','concerning','however','therefore',
  'moreover','furthermore','although','though','while','whereas','nevertheless',
  'thus','hence','accordingly','meanwhile','besides','yet','still','already',
  'even','here','there','where','now','then','once','always','never','often',
  'sometimes','usually','generally','particularly','especially','specifically',
  'mainly','mostly','simply','actually','really','quite','rather','somewhat',
  'well','much','many','several','new','used','using','show','shows','shown',
  'based','proposed','results','method','approach','paper','study','model',
  'data','two','one','first','second','three','four','five','number','given',
  'present','use','different','important','large','small','high','low',
  'work','problem','set','case','time','provide','include','consider',
]);

/**
 * Tokenize text: lowercase, remove punctuation, filter stopwords and short tokens.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Compute term frequency for an array of tokens.
 * Returns a Map of term → normalized frequency.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
export function termFrequency(tokens) {
  const freq = new Map();
  if (tokens.length === 0) return freq;

  tokens.forEach((token) => {
    freq.set(token, (freq.get(token) || 0) + 1);
  });

  // Normalize by document length
  const maxFreq = Math.max(...freq.values());
  for (const [term, count] of freq) {
    freq.set(term, count / maxFreq);
  }

  return freq;
}

/**
 * Compute inverse document frequency across a corpus.
 * @param {string[][]} documents - Array of token arrays
 * @returns {Map<string, number>}
 */
export function inverseDocumentFrequency(documents) {
  const idf = new Map();
  const N = documents.length;
  if (N === 0) return idf;

  // Count how many documents contain each term
  const docFreq = new Map();
  documents.forEach((tokens) => {
    const uniqueTerms = new Set(tokens);
    uniqueTerms.forEach((term) => {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    });
  });

  // Compute IDF
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
  }

  return idf;
}

/**
 * Compute TF-IDF vector for a set of tokens given an IDF map.
 * @param {string[]} tokens
 * @param {Map<string, number>} idfMap
 * @returns {Map<string, number>}
 */
export function tfidfVector(tokens, idfMap) {
  const tf = termFrequency(tokens);
  const vector = new Map();

  for (const [term, tfScore] of tf) {
    const idfScore = idfMap.get(term) || 1;
    vector.set(term, tfScore * idfScore);
  }

  return vector;
}

/**
 * Compute cosine similarity between two vectors (Maps).
 * @param {Map<string, number>} vectorA
 * @param {Map<string, number>} vectorB
 * @returns {number} Similarity score between 0 and 1
 */
export function cosineSimilarity(vectorA, vectorB) {
  if (!vectorA || !vectorB || vectorA.size === 0 || vectorB.size === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, scoreA] of vectorA) {
    const scoreB = vectorB.get(term) || 0;
    dotProduct += scoreA * scoreB;
    normA += scoreA * scoreA;
  }

  for (const [, scoreB] of vectorB) {
    normB += scoreB * scoreB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Extract top N keywords from a single text using term frequency.
 * @param {string} text
 * @param {number} n - Number of keywords to return
 * @returns {Array<{term: string, score: number}>}
 */
export function extractTopKeywords(text, n = 20) {
  const tokens = tokenize(text);
  const tf = termFrequency(tokens);

  return Array.from(tf.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, score]) => ({ term, score }));
}

/**
 * Build a weighted keyword profile from multiple documents.
 * @param {Array<{text: string, weight: number}>} documents
 *   weight > 0 for liked papers, weight < 0 for not interested
 * @param {number} topN - Number of top keywords to return
 * @returns {Map<string, number>} Keyword → aggregate weighted score
 */
export function buildCorpusProfile(documents, topN = 50) {
  if (!documents || documents.length === 0) return new Map();

  // Tokenize all documents
  const allTokenArrays = documents.map((d) => tokenize(d.text));
  const idf = inverseDocumentFrequency(allTokenArrays);

  // Build weighted aggregate
  const aggregate = new Map();

  documents.forEach((doc, i) => {
    const vector = tfidfVector(allTokenArrays[i], idf);
    for (const [term, score] of vector) {
      aggregate.set(
        term,
        (aggregate.get(term) || 0) + score * doc.weight
      );
    }
  });

  // Sort and take top N (by absolute value, keeping sign)
  const sorted = Array.from(aggregate.entries())
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, topN);

  return new Map(sorted);
}
