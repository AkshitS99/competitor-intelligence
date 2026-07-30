/**
 * src/dataMerger.js
 * Enterprise Competitor Intelligence Platform
 * ---
 * Data Merger Module
 *
 * Sole responsibility: merge DOM-extracted ads (from parser.js) with
 * GraphQL-extracted ads (from networkInterceptor.js) into one canonical
 * dataset. Pure data processing only — no Playwright code, no browser
 * interaction, no filesystem writes, no logging framework dependency.
 * Does not modify, import, or depend on scraper.js, parser.js,
 * metaAdLibrary.js, or networkInterceptor.js.
 *
 * Design notes:
 *   - Matching runs as a sequence of tiers, most confident first. Each
 *     tier only considers records left unmatched by the previous tier,
 *     so a high-confidence match (e.g. exact Library ID) is never
 *     second-guessed by a lower-confidence one (e.g. text similarity).
 *   - Tiers 1–3 (Library ID, Ad ID, destination URL) are exact-match
 *     tiers and run in O(n + m) via a lookup map, not O(n × m).
 *   - Tiers 4–5 (headline / primary-text similarity) are best-match
 *     tiers: each remaining DOM ad is compared against every remaining
 *     GraphQL ad, and only the highest-scoring candidate above the
 *     similarity threshold is matched. This is O(n × m) against the
 *     remaining pool, which is acceptable at per-competitor scale.
 *   - IMPORTANT DATA-MODEL NOTE: the GraphQL ad shape this module was
 *     given (libraryId, adId, status, startDate, endDate, countries,
 *     destinationUrl, pageInfo, mediaType) has no headline or
 *     primaryText field. Tiers 4–5 are implemented in full per spec and
 *     will activate automatically if a future GraphQL payload nests
 *     creative/preview text (checked defensively via optional chaining),
 *     but against the documented shape as given, tiers 4–5 will not
 *     fire — only tiers 1–3 apply in practice today. This is a gap in
 *     the input data model, not a bug in the matching logic.
 *   - Similarity thresholds (0.6 for headline, 0.5 for primary text) are
 *     a reasonable starting heuristic, not a tuned constant — revisit
 *     once real match/no-match examples are available.
 *   - Merge strategy: creative fields (advertiser, headline, primaryText,
 *     description, cta, images, videos) prefer DOM; metadata fields
 *     (adId, status, startDate, endDate, countries, destinationUrl as a
 *     fallback) prefer GraphQL. A populated value is never overwritten
 *     by null/empty from the other source.
 *   - Unmatched DOM-only and GraphQL-only ads are preserved in the
 *     output (not dropped), with `source.dom` / `source.graphql` marking
 *     which side(s) contributed.
 *   - Deduplication runs after merging, keyed on Library ID, then Ad ID,
 *     then a SHA-256 hash of headline + primaryText. A record with none
 *     of those (no identifying info at all) is kept rather than risking
 *     an incorrect drop.
 *   - Every public entry point is wrapped so a fatal, unexpected failure
 *     returns `{ ads: [], stats: {} }` rather than throwing.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Confidence assigned to a merged ad based on which tier matched it. */
const MATCH_CONFIDENCE = {
  LIBRARY_ID: 100,
  AD_ID: 95,
  DESTINATION_URL: 85,
  HEADLINE_SIMILARITY: 70,
  PRIMARY_TEXT_SIMILARITY: 60,
};

/** Confidence for a record that only exists in one source (no cross-match). */
const UNMATCHED_CONFIDENCE = 0;

/**
 * Minimum Jaccard similarity score required for a similarity-tier match.
 * Starting heuristics — see module header note.
 */
const SIMILARITY_THRESHOLDS = {
  HEADLINE: 0.6,
  PRIMARY_TEXT: 0.5,
};

/** Query parameter name fragments treated as tracking noise during URL normalization. */
const TRACKING_PARAM_PATTERNS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^ref$/i, /^source$/i, /tracking/i];

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
// All normalize* functions are for COMPARISON purposes only (matching,
// similarity scoring, dedup keys). The final merged output always uses
// the original, un-normalized source values, per spec ("preserve original
// casing in final output").

/**
 * General-purpose text normalizer used as the basis for the field-
 * specific normalizers below: trims, collapses internal whitespace,
 * lowercases, and strips punctuation.
 *
 * @param {*} value
 * @returns {string} Normalized text, or '' if the input isn't usable text.
 */
function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
}

/**
 * Normalizes a headline for similarity comparison.
 * @param {*} value
 * @returns {string}
 */
function normalizeHeadline(value) {
  return normalizeText(value);
}

/**
 * Normalizes primary/body text for similarity comparison.
 * @param {*} value
 * @returns {string}
 */
function normalizePrimaryText(value) {
  return normalizeText(value);
}

/**
 * Normalizes a call-to-action label for comparison.
 * @param {*} value
 * @returns {string}
 */
function normalizeCTA(value) {
  return normalizeText(value);
}

/**
 * Normalizes an advertiser/page name for comparison.
 * @param {*} value
 * @returns {string}
 */
function normalizeAdvertiser(value) {
  return normalizeText(value);
}

/**
 * Normalizes a URL for equality comparison: strips tracking query
 * parameters (utm_*, fbclid, gclid, ref, source, and anything containing
 * "tracking"), removes a trailing slash from the path, and lowercases
 * the host/path. Falls back to a lowercased/trimmed string compare if
 * the value isn't a parseable absolute URL, rather than discarding it.
 *
 * @param {*} value
 * @returns {string|null} Normalized URL string, or null if unusable.
 */
function normalizeUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    const parsed = new URL(trimmed);
    const params = parsed.searchParams;

    const keysToRemove = [];
    for (const key of params.keys()) {
      if (TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(key))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => params.delete(key));
    params.sort();

    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    const search = params.toString();
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}${search ? `?${search}` : ''}`;
  } catch (err) {
    // Not a parseable absolute URL — fall back to a plain normalized
    // string compare rather than treating the value as unusable.
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Normalizes an identifier (Library ID / Ad ID) for equality comparison:
 * coerces to a trimmed string, treating empty/whitespace-only values as
 * absent.
 *
 * @param {*} value
 * @returns {string|null}
 */
function normalizeId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

// ---------------------------------------------------------------------------
// Similarity scoring
// ---------------------------------------------------------------------------

/**
 * Computes Jaccard similarity (|intersection| / |union|) between two
 * already-normalized, whitespace-tokenized strings. Pure set comparison,
 * no external packages.
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {number} Score between 0 and 1.
 */
function computeJaccardSimilarity(textA, textB) {
  if (!textA || !textB) return 0;

  const setA = new Set(textA.split(' ').filter(Boolean));
  const setB = new Set(textB.split(' ').filter(Boolean));

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) intersectionSize += 1;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// Defensive GraphQL creative-text accessors (see module header note)
// ---------------------------------------------------------------------------

/**
 * Attempts to read a headline-like field off a GraphQL ad. The
 * documented GraphQL ad shape has no such field; this checks a couple of
 * plausible nested locations defensively so tiers 4 activates
 * automatically if the upstream shape ever gains one, without requiring
 * a change to this module.
 *
 * @param {object|null|undefined} graphqlAd
 * @returns {string|null}
 */
function extractGraphqlHeadline(graphqlAd) {
  if (!graphqlAd || typeof graphqlAd !== 'object') return null;
  return graphqlAd.headline || graphqlAd?.creative?.headline || graphqlAd?.snapshot?.headline || null;
}

/**
 * Attempts to read a primary-text/body-like field off a GraphQL ad. See
 * extractGraphqlHeadline for why this is defensive rather than direct.
 *
 * @param {object|null|undefined} graphqlAd
 * @returns {string|null}
 */
function extractGraphqlPrimaryText(graphqlAd) {
  if (!graphqlAd || typeof graphqlAd !== 'object') return null;
  return graphqlAd.primaryText || graphqlAd?.creative?.body || graphqlAd?.snapshot?.body || null;
}

// ---------------------------------------------------------------------------
// Matching: exact-key tiers (Library ID, Ad ID, destination URL)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ ad: object, idx: number }} PoolEntry
 */

/**
 * Runs one exact-match tier: builds a lookup map of the GraphQL pool
 * keyed by graphqlKeyFn, then for each DOM entry looks up a candidate by
 * domKeyFn and consumes the first available match. O(n + m) rather than
 * O(n × m).
 *
 * @param {PoolEntry[]} domList
 * @param {PoolEntry[]} graphqlList
 * @param {{
 *   confidence: number,
 *   matchedOn: string,
 *   domKeyFn: (ad: object) => string|null,
 *   graphqlKeyFn: (ad: object) => string|null
 * }} options
 * @returns {{ matches: object[], remainingDom: PoolEntry[], remainingGraphql: PoolEntry[] }}
 */
function extractExactMatches(domList, graphqlList, options) {
  const { confidence, matchedOn, domKeyFn, graphqlKeyFn } = options;

  const graphqlByKey = new Map();
  for (const entry of graphqlList) {
    const key = graphqlKeyFn(entry.ad);
    if (key === null) continue;
    if (!graphqlByKey.has(key)) graphqlByKey.set(key, []);
    graphqlByKey.get(key).push(entry);
  }

  const matches = [];
  const matchedDomIdx = new Set();
  const matchedGraphqlIdx = new Set();

  for (const domEntry of domList) {
    const key = domKeyFn(domEntry.ad);
    if (key === null) continue;

    const candidates = graphqlByKey.get(key);
    if (!candidates || candidates.length === 0) continue;

    const graphqlEntry = candidates.shift();
    matches.push({ dom: domEntry, graphql: graphqlEntry, confidence, matchedOn });
    matchedDomIdx.add(domEntry.idx);
    matchedGraphqlIdx.add(graphqlEntry.idx);
  }

  return {
    matches,
    remainingDom: domList.filter((entry) => !matchedDomIdx.has(entry.idx)),
    remainingGraphql: graphqlList.filter((entry) => !matchedGraphqlIdx.has(entry.idx)),
  };
}

// ---------------------------------------------------------------------------
// Matching: similarity-scored tiers (headline, primary text)
// ---------------------------------------------------------------------------

/**
 * Runs one similarity-match tier: for each remaining DOM entry, finds
 * the highest-scoring remaining GraphQL candidate (via domTextFn /
 * graphqlTextFn + computeJaccardSimilarity) and matches it only if the
 * score meets `threshold`.
 *
 * @param {PoolEntry[]} domList
 * @param {PoolEntry[]} graphqlList
 * @param {{
 *   confidence: number,
 *   matchedOn: string,
 *   threshold: number,
 *   domTextFn: (ad: object) => string,
 *   graphqlTextFn: (ad: object) => string
 * }} options
 * @returns {{ matches: object[], remainingDom: PoolEntry[], remainingGraphql: PoolEntry[] }}
 */
function extractSimilarityMatches(domList, graphqlList, options) {
  const { confidence, matchedOn, threshold, domTextFn, graphqlTextFn } = options;

  const matches = [];
  const matchedGraphqlIdx = new Set();
  const remainingDom = [];

  for (const domEntry of domList) {
    const domText = domTextFn(domEntry.ad);

    if (!domText) {
      remainingDom.push(domEntry);
      continue;
    }

    let bestScore = 0;
    let bestGraphqlEntry = null;

    for (const graphqlEntry of graphqlList) {
      if (matchedGraphqlIdx.has(graphqlEntry.idx)) continue;

      const graphqlText = graphqlTextFn(graphqlEntry.ad);
      if (!graphqlText) continue;

      const score = computeJaccardSimilarity(domText, graphqlText);
      if (score > bestScore) {
        bestScore = score;
        bestGraphqlEntry = graphqlEntry;
      }
    }

    if (bestGraphqlEntry && bestScore >= threshold) {
      matches.push({ dom: domEntry, graphql: bestGraphqlEntry, confidence, matchedOn });
      matchedGraphqlIdx.add(bestGraphqlEntry.idx);
    } else {
      remainingDom.push(domEntry);
    }
  }

  return {
    matches,
    remainingDom,
    remainingGraphql: graphqlList.filter((entry) => !matchedGraphqlIdx.has(entry.idx)),
  };
}

// ---------------------------------------------------------------------------
// Merge: build the canonical output object for one (matched or unmatched) ad
// ---------------------------------------------------------------------------

/**
 * Returns the first value in `values` that is neither null, undefined,
 * nor an empty string.
 *
 * @param {...*} values
 * @returns {*|null}
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

/**
 * Builds one canonical merged ad object per the required output schema.
 * Creative fields prefer DOM; metadata fields prefer GraphQL. A
 * populated value from either source is never overwritten by a
 * null/empty value from the other. Either `domAd` or `graphqlAd` (but
 * not both) may be null for an unmatched, single-source record.
 *
 * @param {object|null} domAd
 * @param {object|null} graphqlAd
 * @param {number} confidence
 * @returns {object}
 */
function buildMergedAd(domAd, graphqlAd, confidence) {
  const rawLibraryId = firstNonEmpty(domAd?.libraryId, graphqlAd?.libraryId);
  const rawAdId = firstNonEmpty(graphqlAd?.adId);
  const rawDestinationUrl = firstNonEmpty(domAd?.destinationUrl, graphqlAd?.destinationUrl);

  return {
    libraryId: rawLibraryId === null ? '' : String(rawLibraryId),
    adId: rawAdId === null ? '' : String(rawAdId),
    advertiser: domAd?.advertiser || '',
    headline: domAd?.headline || '',
    primaryText: domAd?.primaryText || '',
    description: domAd?.description || '',
    cta: domAd?.cta || '',
    status: graphqlAd?.status || '',
    startDate: graphqlAd?.startDate ?? null,
    endDate: graphqlAd?.endDate ?? null,
    countries: Array.isArray(graphqlAd?.countries) ? [...graphqlAd.countries] : [],
    destinationUrl: rawDestinationUrl === null ? '' : String(rawDestinationUrl),
    images: Array.isArray(domAd?.images) ? [...domAd.images] : [],
    videos: Array.isArray(domAd?.videos) ? [...domAd.videos] : [],
    confidence,
    source: {
      dom: Boolean(domAd),
      graphql: Boolean(graphqlAd),
    },
  };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Builds a dedup key for a merged ad: Library ID first, then Ad ID, then
 * a SHA-256 hash of headline + primaryText. Returns null if none of
 * those yield anything usable, signaling "keep this record regardless"
 * rather than risk dropping a legitimately unique ad with no identifying
 * information.
 *
 * @param {object} mergedAd
 * @returns {string|null}
 */
function buildDedupKey(mergedAd) {
  if (mergedAd.libraryId) return `libraryId:${mergedAd.libraryId}`;
  if (mergedAd.adId) return `adId:${mergedAd.adId}`;

  const basis = `${mergedAd.headline || ''}||${mergedAd.primaryText || ''}`.trim().toLowerCase();
  if (basis.replace(/\|/g, '').trim().length === 0) return null;

  return `hash:${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

/**
 * Removes duplicate merged ads, keyed via buildDedupKey. Records with no
 * usable key are always kept (never deduped away).
 *
 * @param {object[]} mergedAds
 * @returns {{ deduped: object[], duplicateCount: number }}
 */
function deduplicateMergedAds(mergedAds) {
  const seen = new Set();
  const deduped = [];
  let duplicateCount = 0;

  for (const ad of mergedAds) {
    const key = buildDedupKey(ad);

    if (key === null) {
      deduped.push(ad);
      continue;
    }

    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    deduped.push(ad);
  }

  return { deduped, duplicateCount };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * @param {object[]} mergedAds
 * @returns {number}
 */
function computeAverageConfidence(mergedAds) {
  if (!Array.isArray(mergedAds) || mergedAds.length === 0) return 0;
  const total = mergedAds.reduce(
    (sum, ad) => sum + (typeof ad.confidence === 'number' ? ad.confidence : 0),
    0
  );
  return Math.round((total / mergedAds.length) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main export: mergeAds
// ---------------------------------------------------------------------------

/**
 * Merges DOM-extracted ads and GraphQL-extracted ads into one canonical
 * dataset. Never throws — returns `{ ads: [], stats: {} }` on any fatal,
 * unexpected failure.
 *
 * @param {object[]} domAds - Ads from parser.js, shaped like:
 *   { libraryId, advertiser, headline, primaryText, description, cta,
 *     destinationUrl, images, videos, confidence }
 * @param {object[]} graphqlAds - Ads from networkInterceptor.js, shaped like:
 *   { libraryId, adId, status, startDate, endDate, countries,
 *     destinationUrl, pageInfo, mediaType }
 * @returns {{ ads: object[], stats: object }}
 */
function mergeAds(domAds, graphqlAds) {
  try {
    const safeDomAds = (Array.isArray(domAds) ? domAds : []).filter(
      (ad) => ad !== null && typeof ad === 'object'
    );
    const safeGraphqlAds = (Array.isArray(graphqlAds) ? graphqlAds : []).filter(
      (ad) => ad !== null && typeof ad === 'object'
    );

    let domList = safeDomAds.map((ad, idx) => ({ ad, idx }));
    let graphqlList = safeGraphqlAds.map((ad, idx) => ({ ad, idx }));

    const allMatches = [];

    // Tier 1: Library ID exact match.
    let tierResult = extractExactMatches(domList, graphqlList, {
      confidence: MATCH_CONFIDENCE.LIBRARY_ID,
      matchedOn: 'libraryId',
      domKeyFn: (ad) => normalizeId(ad.libraryId),
      graphqlKeyFn: (ad) => normalizeId(ad.libraryId),
    });
    allMatches.push(...tierResult.matches);
    domList = tierResult.remainingDom;
    graphqlList = tierResult.remainingGraphql;

    // Tier 2: Ad ID. Meta's Library ID and Ad ID commonly refer to the
    // same underlying identifier, so this catches cases where one source
    // populated libraryId and the other only populated adId.
    tierResult = extractExactMatches(domList, graphqlList, {
      confidence: MATCH_CONFIDENCE.AD_ID,
      matchedOn: 'adId',
      domKeyFn: (ad) => normalizeId(ad.libraryId),
      graphqlKeyFn: (ad) => normalizeId(ad.adId),
    });
    allMatches.push(...tierResult.matches);
    domList = tierResult.remainingDom;
    graphqlList = tierResult.remainingGraphql;

    // Tier 3: destination URL, tracking parameters stripped before compare.
    tierResult = extractExactMatches(domList, graphqlList, {
      confidence: MATCH_CONFIDENCE.DESTINATION_URL,
      matchedOn: 'destinationUrl',
      domKeyFn: (ad) => normalizeUrl(ad.destinationUrl),
      graphqlKeyFn: (ad) => normalizeUrl(ad.destinationUrl),
    });
    allMatches.push(...tierResult.matches);
    domList = tierResult.remainingDom;
    graphqlList = tierResult.remainingGraphql;

    // Tier 4: headline similarity (see module header note on GraphQL
    // ads not carrying a headline field in the documented shape).
    tierResult = extractSimilarityMatches(domList, graphqlList, {
      confidence: MATCH_CONFIDENCE.HEADLINE_SIMILARITY,
      matchedOn: 'headlineSimilarity',
      threshold: SIMILARITY_THRESHOLDS.HEADLINE,
      domTextFn: (ad) => normalizeHeadline(ad.headline),
      graphqlTextFn: (ad) => normalizeHeadline(extractGraphqlHeadline(ad)),
    });
    allMatches.push(...tierResult.matches);
    domList = tierResult.remainingDom;
    graphqlList = tierResult.remainingGraphql;

    // Tier 5: primary text similarity (same caveat as tier 4).
    tierResult = extractSimilarityMatches(domList, graphqlList, {
      confidence: MATCH_CONFIDENCE.PRIMARY_TEXT_SIMILARITY,
      matchedOn: 'primaryTextSimilarity',
      threshold: SIMILARITY_THRESHOLDS.PRIMARY_TEXT,
      domTextFn: (ad) => normalizePrimaryText(ad.primaryText),
      graphqlTextFn: (ad) => normalizePrimaryText(extractGraphqlPrimaryText(ad)),
    });
    allMatches.push(...tierResult.matches);
    domList = tierResult.remainingDom;
    graphqlList = tierResult.remainingGraphql;

    // Build canonical output objects: matched pairs, then leftover
    // single-source ads from each side.
    const mergedFromMatches = allMatches.map((match) =>
      buildMergedAd(match.dom.ad, match.graphql.ad, match.confidence)
    );
    const domOnlyMerged = domList.map((entry) => buildMergedAd(entry.ad, null, UNMATCHED_CONFIDENCE));
    const graphqlOnlyMerged = graphqlList.map((entry) =>
      buildMergedAd(null, entry.ad, UNMATCHED_CONFIDENCE)
    );

    const combined = [...mergedFromMatches, ...domOnlyMerged, ...graphqlOnlyMerged];
    const { deduped, duplicateCount } = deduplicateMergedAds(combined);

    const stats = {
      totalDOMAds: safeDomAds.length,
      totalGraphQLAds: safeGraphqlAds.length,
      mergedAds: deduped.length,
      domOnly: domOnlyMerged.length,
      graphqlOnly: graphqlOnlyMerged.length,
      duplicateCount,
      averageConfidence: computeAverageConfidence(deduped),
    };

    return { ads: deduped, stats };
  } catch (err) {
    return { ads: [], stats: {} };
  }
}

module.exports = {
  mergeAds,
};
