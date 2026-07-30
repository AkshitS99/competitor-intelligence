/**
 * src/networkInterceptor.js
 * Enterprise Competitor Intelligence Platform
 * ---
 * Meta Ad Library Network Interceptor Module
 *
 * Sole responsibility: passively capture Meta Ad Library GraphQL/XHR
 * responses while Playwright browses the page, so callers get access to
 * exact pagination (cursor/endCursor/hasNextPage), raw GraphQL payloads,
 * and a way to debug DOM extraction failures against ground truth.
 *
 * This module is NOT a replacement for parser.js's DOM extraction. It is
 * a complementary, read-only observer of network traffic:
 *   - parser.js is the source of truth for rendered text, button labels,
 *     and anything not exposed in API responses.
 *   - networkInterceptor.js is the source of truth for pagination state,
 *     exact counts, and canonical structured metadata, where available.
 *
 * This module MUST NOT:
 *   - Navigate, click, type, or otherwise drive the page
 *   - Modify or replay requests
 *   - Throw — every failure is logged and the response is skipped
 *
 * Design notes:
 *   - URL matching is intentionally broad (graphql / api/graphql /
 *     ads_archive / ads/library) rather than a single hardcoded
 *     endpoint, since Meta's endpoint naming and doc_id values shift
 *     over time.
 *   - Every captured response is deduplicated by a SHA-256 hash of its
 *     URL + JSON payload, since GraphQL polling/pagination frequently
 *     repeats identical responses.
 *   - Pagination metadata (hasNextPage / endCursor / edges) is located
 *     via recursive object traversal rather than a fixed path, since
 *     Meta's GraphQL schema and nesting depth change frequently.
 *   - Hashing and page-info extraction each walk the payload exactly
 *     once per response — no repeated stringification of large payloads.
 *   - getCapturedResponses() returns a deep clone so callers can't
 *     mutate this module's internal state.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Internal utility: lightweight logger (console only — matches parser.js style)
// ---------------------------------------------------------------------------

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [networkInterceptor] [${level}] ${message}`;

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let capturedResponses = [];
let seenHashes = new Set();

// URL patterns for identifying likely Meta Ad Library GraphQL/XHR calls.
// Kept as a list (not a single regex) so new patterns can be appended
// without touching matching logic, as Meta's routing changes over time.
const GRAPHQL_URL_PATTERNS = [
  /graphql/i,
  /api\/graphql/i,
  /ads_archive/i,
  /ads\/library/i,
  /render_ad/i,
];

// ---------------------------------------------------------------------------
// Helper: isGraphQLResponse
// ---------------------------------------------------------------------------

/**
 * Flexible, pattern-based check for whether a response is likely a Meta
 * Ad Library GraphQL/XHR call. Deliberately broad rather than matching
 * one hardcoded endpoint, since Meta's internal routing shifts often.
 *
 * @param {import('playwright').Response} response
 * @returns {boolean}
 */
function isGraphQLResponse(response) {
  try {
    const url = response.url();
    return GRAPHQL_URL_PATTERNS.some((pattern) => pattern.test(url));
  } catch (err) {
    log('WARN', `isGraphQLResponse failed to read response URL: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: safeJson
// ---------------------------------------------------------------------------

/**
 * Attempts to parse a response body as JSON. Never throws — returns null
 * on any failure (non-JSON body, empty body, already-consumed stream,
 * closed response, etc.), so a single malformed response can never take
 * down the interceptor.
 *
 * @param {import('playwright').Response} response
 * @returns {Promise<object|null>}
 */
async function safeJson(response) {
  try {
    const json = await response.json();
    return json;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: safeStringify (circular-reference-safe JSON.stringify)
// ---------------------------------------------------------------------------

/**
 * JSON.stringify wrapper that tolerates circular references. Response
 * bodies parsed via response.json() come from JSON text and can never
 * actually contain cycles, but this guard makes hashing safe regardless
 * of payload origin.
 *
 * @param {*} value
 * @returns {string}
 */
function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch (err) {
    log('WARN', `safeStringify failed, falling back to String(): ${err.message}`);
    try {
      return String(value);
    } catch (fallbackErr) {
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: hashPayload
// ---------------------------------------------------------------------------

/**
 * Computes a stable SHA-256 hash from a response's URL + JSON payload.
 * Used to deduplicate identical GraphQL responses (polling/pagination
 * frequently re-returns the same payload). Computed once per response
 * and stored on the record — never recomputed.
 *
 * @param {string} url
 * @param {object} json
 * @returns {string}
 */
function hashPayload(url, json) {
  const basis = `${url}||${safeStringify(json)}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

// ---------------------------------------------------------------------------
// Helper: walkObject (generic recursive traversal, circular-safe)
// ---------------------------------------------------------------------------

/**
 * Generic recursive walk over a parsed JSON value, invoking `visitor` on
 * every object/array node encountered. Guards against circular
 * references via a `seen` WeakSet-backed Set of visited node references,
 * so a pathological payload can never cause infinite recursion.
 *
 * @param {*} node
 * @param {(node: object) => void} visitor
 * @param {Set<object>} [seen]
 * @returns {void}
 */
function walkObject(node, visitor, seen = new Set()) {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return; // circular reference guard
  seen.add(node);

  try {
    visitor(node);
  } catch (err) {
    log('WARN', `walkObject visitor threw on a node, skipping that node: ${err.message}`);
  }

  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    walkObject(child, visitor, seen);
  }
}

// ---------------------------------------------------------------------------
// Helper: extractPageInfo
// ---------------------------------------------------------------------------

/**
 * Locates hasNextPage / endCursor / edges (as an edge count) anywhere in
 * a GraphQL payload via recursive traversal, rather than a fixed path —
 * Meta's schema and nesting depth change frequently enough that a fixed
 * path breaks often. Takes the first occurrence of each field found
 * during traversal.
 *
 * @param {object} json
 * @returns {{ hasNextPage: boolean|null, endCursor: string|null, edgeCount: number|null }}
 */
function extractPageInfo(json) {
  const result = { hasNextPage: null, endCursor: null, edgeCount: null };

  try {
    walkObject(json, (node) => {
      if (Array.isArray(node)) return;

      if (result.hasNextPage === null && typeof node.hasNextPage === 'boolean') {
        result.hasNextPage = node.hasNextPage;
      }

      if (
        result.endCursor === null &&
        (typeof node.endCursor === 'string' || node.endCursor === null) &&
        Object.prototype.hasOwnProperty.call(node, 'endCursor')
      ) {
        result.endCursor = node.endCursor;
      }

      if (result.edgeCount === null && Array.isArray(node.edges)) {
        result.edgeCount = node.edges.length;
      }
    });
  } catch (err) {
    log('WARN', `extractPageInfo traversal failed: ${err.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: extractHeaders (version-tolerant across Playwright releases)
// ---------------------------------------------------------------------------

/**
 * Reads response headers in a way that tolerates different Playwright
 * versions: prefers the async `allHeaders()` (includes redirect-chain
 * headers) and falls back to the synchronous `headers()` if unavailable.
 *
 * @param {import('playwright').Response} response
 * @returns {Promise<object>}
 */
async function extractHeaders(response) {
  try {
    if (typeof response.allHeaders === 'function') {
      return await response.allHeaders();
    }
    return response.headers();
  } catch (err) {
    log('WARN', `Could not read response headers: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main export: attachNetworkInterceptor
// ---------------------------------------------------------------------------

/**
 * Registers a page.on("response") listener that captures likely Meta Ad
 * Library GraphQL/XHR responses into memory. Purely observational — does
 * not navigate, click, or otherwise interact with the page. Never
 * throws; every per-response failure is logged and that response is
 * skipped rather than aborting the listener.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function attachNetworkInterceptor(page) {
  if (!page) {
    log('ERROR', 'attachNetworkInterceptor called without a valid page instance.');
    return;
  }

  page.on('response', async (response) => {
    try {
      if (!isGraphQLResponse(response)) return;

      let url = null;
      try {
        url = response.url();
      } catch (urlErr) {
        log('WARN', `Could not read response URL, skipping: ${urlErr.message}`);
        return;
      }

      let status = null;
      try {
        status = response.status();
      } catch (statusErr) {
        log('WARN', `Could not read response status for ${url}: ${statusErr.message}`);
      }

      let method = 'UNKNOWN';
      try {
        method = response.request().method();
      } catch (methodErr) {
        log('WARN', `Could not read request method for ${url}: ${methodErr.message}`);
      }

      const json = await safeJson(response);
      if (json === null) {
        // Not JSON, empty body, or the stream was already consumed —
        // expected for a large share of non-data responses. Skip quietly.
        return;
      }

      const hash = hashPayload(url, json);
      if (seenHashes.has(hash)) {
        return; // duplicate payload — expected and frequent, skip silently
      }
      seenHashes.add(hash);

      const headers = await extractHeaders(response);
      const pageInfo = extractPageInfo(json);

      const record = {
        timestamp: new Date().toISOString(),
        url,
        status,
        method,
        headers,
        pageInfo,
        hash,
        payload: json,
      };

      capturedResponses.push(record);

      log(
        'INFO',
        `Captured GraphQL response (${status} ${method}) — ` +
          `edges: ${pageInfo.edgeCount ?? 'n/a'}, hasNextPage: ${pageInfo.hasNextPage ?? 'n/a'}, ` +
          `url: ${url}`
      );
    } catch (err) {
      // Catch-all: nothing inside this listener should ever crash Playwright.
      log('ERROR', `Failed to process a network response: ${err.message}`);
    }
  });

  log('INFO', 'Network interceptor attached to page.');
}

// ---------------------------------------------------------------------------
// Main export: getCapturedResponses
// ---------------------------------------------------------------------------

/**
 * Returns a deep clone of all captured responses so far, so callers
 * cannot mutate this module's internal state by editing the result.
 *
 * @returns {object[]}
 */
function getCapturedResponses() {
  try {
    return JSON.parse(safeStringify(capturedResponses));
  } catch (err) {
    log('WARN', `Failed to deep clone captured responses, returning a shallow copy: ${err.message}`);
    return capturedResponses.slice();
  }
}

// ---------------------------------------------------------------------------
// Main export: clearCapturedResponses
// ---------------------------------------------------------------------------

/**
 * Resets all captured responses and the dedup hash set. Call this
 * before scraping a new competitor so results don't bleed across runs.
 *
 * @returns {void}
 */
function clearCapturedResponses() {
  const previousCount = capturedResponses.length;
  capturedResponses = [];
  seenHashes = new Set();
  log('INFO', `Cleared captured network responses (previously held ${previousCount}).`);
}

module.exports = {
  attachNetworkInterceptor,
  getCapturedResponses,
  clearCapturedResponses,
};
