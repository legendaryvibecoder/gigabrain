/**
 * BM25 scoring module for memory recall ranking.
 *
 * Replaces naive Jaccard overlap with proper BM25 relevance scoring.
 * Includes a bilingual (EN + DE) stopword list and a simple tokenizer.
 *
 * @module bm25
 */

// ── Stopwords (EN + DE) ─────────────────────────────────────────────────────

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'not', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'between', 'through', 'during', 'before', 'after', 'above', 'below',
  'that', 'this', 'these', 'those', 'it', 'its', 'he', 'she', 'they',
  'them', 'his', 'her', 'their', 'we', 'you', 'i', 'me', 'my', 'your',
  'our', 'who', 'what', 'which', 'when', 'where', 'how', 'if', 'then',
  'than', 'so', 'no', 'just', 'also', 'very', 'too', 'only',
  // German
  'der', 'die', 'das', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'nicht', 'ist', 'sind', 'war', 'waren', 'sein',
  'haben', 'hat', 'hatte', 'wird', 'werden', 'kann', 'konnte', 'soll',
  'sollte', 'muss', 'darf', 'von', 'zu', 'mit', 'auf', 'für', 'an',
  'aus', 'bei', 'nach', 'über', 'unter', 'vor', 'zwischen', 'durch',
  'um', 'ohne', 'gegen', 'bis', 'seit', 'während', 'wegen',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mein', 'dein', 'sein',
  'unser', 'euer', 'sich', 'dem', 'den', 'des', 'im', 'am', 'als',
  'auch', 'noch', 'schon', 'nur', 'wenn', 'wie', 'was', 'wer', 'wo',
  'da', 'so', 'doch', 'ja', 'nein', 'hier', 'dort', 'dann', 'dass',
]);

// ── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * Tokenize text: lowercase, split on whitespace / punctuation, drop stopwords
 * and tokens shorter than 2 characters.
 *
 * @param {string} text
 * @returns {string[]}
 */
export const tokenize = (text) => {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
};

// ── Standalone BM25 score ───────────────────────────────────────────────────

/**
 * Compute BM25 score for a single document given pre-computed stats.
 *
 * @param {Object} opts
 * @param {string[]} opts.queryTokens  - tokenized query
 * @param {string[]} opts.docTokens    - tokenized document
 * @param {number}   opts.avgDl        - average document length in corpus
 * @param {number}   opts.docCount     - total number of documents (N)
 * @param {Object}   opts.df           - map of term -> number of docs containing term
 * @param {number}   [opts.k1=1.5]
 * @param {number}   [opts.b=0.75]
 * @returns {number}
 */
export const bm25Score = ({ queryTokens, docTokens, avgDl, docCount, df, k1 = 1.5, b = 0.75 }) => {
  const dl = docTokens.length;
  if (dl === 0 || avgDl === 0) return 0;

  // Build term-frequency map for the document
  const tf = Object.create(null);
  for (const t of docTokens) {
    tf[t] = (tf[t] || 0) + 1;
  }

  let score = 0;
  const N = docCount;

  for (const t of queryTokens) {
    const n = df[t] || 0;
    const f = tf[t] || 0;
    if (f === 0) continue;

    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    const tfNorm = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDl)));
    score += idf * tfNorm;
  }

  return score;
};

// ── BM25 Index ──────────────────────────────────────────────────────────────

export class BM25Index {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.k1=1.5]  - term-frequency saturation parameter
   * @param {number} [opts.b=0.75]  - length-normalization parameter
   */
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;

    /** @type {Map<string, {id: string, tokens: string[], tf: Record<string, number>}>} */
    this.docs = new Map();
    /** @type {Record<string, number>} document frequency per term */
    this.df = Object.create(null);
    /** @type {number} */
    this.avgDl = 0;
    /** @type {number} */
    this.N = 0;
  }

  /**
   * Build (or rebuild) the index from an array of documents.
   *
   * @param {{ id: string, text: string }[]} documents
   */
  buildIndex(documents) {
    this.docs.clear();
    this.df = Object.create(null);

    let totalLength = 0;

    for (const { id, text } of documents) {
      const tokens = tokenize(text);
      const tf = Object.create(null);
      const seen = new Set();

      for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1;
        seen.add(t);
      }

      // Update document frequency (each term counted once per doc)
      for (const t of seen) {
        this.df[t] = (this.df[t] || 0) + 1;
      }

      totalLength += tokens.length;
      this.docs.set(id, { id, tokens, tf });
    }

    this.N = documents.length;
    this.avgDl = this.N > 0 ? totalLength / this.N : 0;
  }

  /**
   * Return the IDF value for a single term.
   *
   * @param {string} term - already-lowercased term
   * @returns {number}
   */
  getIDF(term) {
    const n = this.df[term] || 0;
    return Math.log((this.N - n + 0.5) / (n + 0.5) + 1);
  }

  /**
   * Score a single indexed document against pre-tokenized query terms.
   *
   * @param {string}   docId
   * @param {string[]} queryTokens
   * @returns {number}  BM25 score (0 if docId not found)
   */
  scoreDocument(docId, queryTokens) {
    const doc = this.docs.get(docId);
    if (!doc) return 0;

    const dl = doc.tokens.length;
    if (dl === 0 || this.avgDl === 0) return 0;

    let score = 0;
    for (const t of queryTokens) {
      const f = doc.tf[t] || 0;
      if (f === 0) continue;

      const idf = this.getIDF(t);
      const tfNorm = (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (dl / this.avgDl)));
      score += idf * tfNorm;
    }

    return score;
  }

  /**
   * Score and rank all indexed documents against a query string.
   *
   * @param {string} query
   * @param {number} [limit=30]
   * @returns {{ id: string, score: number }[]}  sorted descending by score
   */
  rank(query, limit = 30) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const results = [];

    for (const [id] of this.docs) {
      const score = this.scoreDocument(id, queryTokens);
      if (score > 0) {
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
