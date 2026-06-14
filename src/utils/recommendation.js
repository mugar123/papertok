/**
 * PaperTok Recommendation Engine
 * Scores and ranks papers based on user interactions.
 */

import { tokenize, buildCorpusProfile, tfidfVector, cosineSimilarity, inverseDocumentFrequency } from './tfidf';

/**
 * Build a user profile from their interaction history.
 * @param {Array<{paper: Object, liked: boolean, notInterested: boolean}>} interactions
 * @returns {Object} User profile with keywordVector, likedAuthors, categoryWeights
 */
export function buildUserProfile(interactions) {
  if (!interactions || interactions.length === 0) {
    return { keywordVector: new Map(), likedAuthors: new Set(), categoryWeights: new Map() };
  }

  // Build keyword profile from abstracts
  const documents = interactions
    .filter((i) => i.paper && (i.liked || i.notInterested))
    .map((i) => ({
      text: `${i.paper.title || ''} ${i.paper.summary || ''}`,
      weight: i.liked ? 1.0 : i.notInterested ? -0.5 : 0,
    }));

  const keywordVector = buildCorpusProfile(documents, 60);

  // Collect liked authors
  const likedAuthors = new Set();
  interactions
    .filter((i) => i.liked && i.paper?.authors)
    .forEach((i) => {
      i.paper.authors.forEach((author) => likedAuthors.add(author));
    });

  // Build category weights
  const categoryWeights = new Map();
  interactions.forEach((i) => {
    if (!i.paper?.primaryCategory) return;
    const cat = i.paper.primaryCategory;
    const current = categoryWeights.get(cat) || 0;
    if (i.liked) {
      categoryWeights.set(cat, current + 0.15);
    } else if (i.notInterested) {
      categoryWeights.set(cat, current - 0.1);
    }
  });

  return { keywordVector, likedAuthors, categoryWeights };
}

/**
 * Calculate days since a given date string.
 * @param {string} dateString - ISO date string
 * @returns {number}
 */
export function daysSince(dateString) {
  try {
    const date = new Date(dateString);
    const now = new Date();
    return Math.max(0, (now - date) / (1000 * 60 * 60 * 24));
  } catch {
    return 30;
  }
}

/**
 * Score a single paper against a user profile.
 * @param {Object} paper
 * @param {Object} userProfile
 * @returns {number} Score (higher = better match)
 */
export function scorePaper(paper, userProfile) {
  if (!userProfile || userProfile.keywordVector.size === 0) {
    return 0.5; // Neutral score if no profile
  }

  let score = 0;

  // Keyword matching (TF-IDF cosine similarity)
  const paperText = `${paper.title || ''} ${paper.summary || ''}`;
  const paperTokens = tokenize(paperText);

  // Create a simple IDF from the paper + profile
  const allDocs = [paperTokens, Array.from(userProfile.keywordVector.keys())];
  const idf = inverseDocumentFrequency(allDocs);
  const paperVector = tfidfVector(paperTokens, idf);

  const similarity = cosineSimilarity(paperVector, userProfile.keywordVector);
  score += similarity * 0.5; // Weight: 50% from keywords

  // Author boost
  if (paper.authors && userProfile.likedAuthors.size > 0) {
    const authorMatch = paper.authors.some((a) => userProfile.likedAuthors.has(a));
    if (authorMatch) {
      score += 0.3;
    }
  }

  // Recency bonus (newer papers get a boost)
  if (paper.published) {
    const days = daysSince(paper.published);
    score += Math.max(0, 1 - days / 30) * 0.15;
  }

  // Category preference weight
  if (paper.primaryCategory && userProfile.categoryWeights.has(paper.primaryCategory)) {
    score += userProfile.categoryWeights.get(paper.primaryCategory);
  }

  return Math.max(0, score);
}

/**
 * Rank an array of papers using the recommendation algorithm.
 * Applies diversity constraints and exploration mixing.
 * @param {Object[]} papers - Array of paper objects
 * @param {Object} userProfile - User profile from buildUserProfile
 * @returns {Object[]} Reordered array of papers
 */
export function rankPapers(papers, userProfile) {
  if (!papers || papers.length === 0) return [];

  // If no profile, return papers in original order (by date)
  if (!userProfile || userProfile.keywordVector.size === 0) {
    return papers;
  }

  // Score all papers
  const scored = papers.map((paper) => ({
    paper,
    score: scorePaper(paper, userProfile),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Split into top-scored and exploration pools
  const splitIndex = Math.ceil(scored.length * 0.8);
  const topPool = scored.slice(0, splitIndex);
  const explorationPool = scored.slice(splitIndex);

  // Shuffle exploration pool
  for (let i = explorationPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [explorationPool[i], explorationPool[j]] = [explorationPool[j], explorationPool[i]];
  }

  // Merge with diversity constraint: max 3 consecutive same category
  const result = [];
  let topIdx = 0;
  let exploIdx = 0;
  let consecutiveCategory = '';
  let consecutiveCount = 0;

  const total = papers.length;

  for (let i = 0; i < total; i++) {
    // Every 5th paper, try to insert an exploration paper
    let candidate = null;

    if (i % 5 === 4 && exploIdx < explorationPool.length) {
      candidate = explorationPool[exploIdx++];
    } else if (topIdx < topPool.length) {
      candidate = topPool[topIdx++];
    } else if (exploIdx < explorationPool.length) {
      candidate = explorationPool[exploIdx++];
    }

    if (!candidate) break;

    // Check diversity constraint
    const cat = candidate.paper.primaryCategory || '';
    if (cat === consecutiveCategory) {
      consecutiveCount++;
      if (consecutiveCount > 3) {
        // Try to swap with an exploration paper of different category
        let swapped = false;
        for (let j = exploIdx; j < explorationPool.length; j++) {
          if ((explorationPool[j].paper.primaryCategory || '') !== cat) {
            [explorationPool[exploIdx], explorationPool[j]] = [explorationPool[j], explorationPool[exploIdx]];
            candidate = explorationPool[exploIdx++];
            swapped = true;
            break;
          }
        }
        if (!swapped) {
          // No alternative found, just use it
        }
      }
    } else {
      consecutiveCategory = cat;
      consecutiveCount = 1;
    }

    result.push(candidate.paper);
  }

  return result;
}
