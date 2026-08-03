/**
 * src/scraper.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Orchestration Module
 *
 * Pipeline (per competitor):
 *   Reset network capture
 *     -> Close popups
 *     -> Select Country -> India
 *     -> Select Ad Category -> All ads
 *     -> Search competitor name
 *     -> Wait for results
 *     -> Scroll until stable
 *     -> Parser -> DOM ads
 *     -> NetworkInterceptor -> GraphQL ads
 *     -> dataMerger.js
 *     -> downloader.js
 *     -> Save output
 *
 * Country and Ad Category are re-applied on every competitor iteration
 * (not just once at session start), since Meta can reset these filters
 * between searches.
 *
 * This module intentionally contains NO Meta Ad Library navigation logic
 * and NO DOM parsing logic. All page-level interaction (launch, cookies,
 * country/category selection, search, waiting for ads, scrolling, popups)
 * lives in ./metaAdLibrary; all DOM extraction lives in ./parser; all
 * GraphQL/XHR capture lives in ./networkInterceptor; all dataset merging
 * lives in ./dataMerger; all asset downloading lives in ./downloader.
 * This module only wires them together.
 *
 * Usage:
 * node src/scraper.js
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { chromium } = require('playwright');

const metaAdLibrary = require('./metaAdLibrary');
const parser = require('./parser');
const dataMerger = require('./dataMerger');
const downloader = require('./downloader');
const {
  attachNetworkInterceptor,
  getCapturedResponses,
  clearCapturedResponses,
  // Optional: if ./networkInterceptor exports its own extraction function,
  // it is preferred over the local extractGraphQLAds() fallback below.
  // Destructuring an export that doesn't exist simply yields `undefined`
  // here — it does not throw — so this stays safe either way.
  extractAdsFromResponses: networkInterceptorExtractAdsFromResponses,
} = require('./networkInterceptor');

// ---------------------------------------------------------------------------
// Constants & Paths
// ---------------------------------------------------------------------------

const ROOT_DIR = path.join(__dirname, '..');

const PATHS = {
  config: path.join(ROOT_DIR, 'config', 'competitors.json'),
  output: path.join(ROOT_DIR, 'output'),
  logs: path.join(ROOT_DIR, 'logs'),
  assets: path.join(ROOT_DIR, 'assets'),
  reports: path.join(ROOT_DIR, 'reports'),
  network: path.join(ROOT_DIR, 'output', 'network'),
  adsJson: path.join(ROOT_DIR, 'output', 'ads.json'),
  logFile: path.join(ROOT_DIR, 'logs', 'scraper.log'),
};

const DEFAULT_COUNTRY = 'India';
const DEFAULT_AD_CATEGORY = 'All ads';

const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
// Lightweight production-style logger that writes to console and to a
// persistent log file under logs/. Avoids external dependencies to keep
// the module self-contained.

const Logger = {
  /**
   * Format a single log line with timestamp and level.
   * @param {'INFO'|'WARN'|'ERROR'} level
   * @param {string} message
   * @returns {string}
   */
  format(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  },

  /**
   * Write a formatted line to both stdout/stderr and the log file.
   * @param {'INFO'|'WARN'|'ERROR'} level
   * @param {string} message
   */
  async write(level, message) {
    const line = Logger.format(level, message);

    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }

    try {
      await fs.appendFile(PATHS.logFile, `${line}\n`);
    } catch (err) {
      // Do not let logging failures crash the scraper; report to console only.
      console.error(`[${new Date().toISOString()}] [ERROR] Failed to write log file: ${err.message}`);
    }
  },

  info(message) {
    return Logger.write('INFO', message);
  },

  warn(message) {
    return Logger.write('WARN', message);
  },

  error(message) {
    return Logger.write('ERROR', message);
  },
};

// ---------------------------------------------------------------------------
// Internal utility: filesystem-safe slug for per-competitor network files
// ---------------------------------------------------------------------------

/**
 * @param {string} value
 * @returns {string}
 */
function toSlug(value) {
  if (!value) return 'unknown';
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'unknown'
  );
}

// ---------------------------------------------------------------------------
// Bootstrap: ensure required project directories exist
// ---------------------------------------------------------------------------

/**
 * Ensures all directories required by the platform exist before the
 * scraper runs. Safe to call repeatedly (idempotent).
 */
async function ensureDirectories() {
  const requiredDirs = [PATHS.output, PATHS.logs, PATHS.assets, PATHS.reports, PATHS.network];

  for (const dir of requiredDirs) {
    await fs.ensureDir(dir);
  }

  await Logger.info('Verified/created required directories: output/, logs/, assets/, reports/, output/network/');
}

// ---------------------------------------------------------------------------
// Bootstrap: initialize output/ads.json placeholder
// ---------------------------------------------------------------------------

/**
 * Creates (or resets) output/ads.json with a placeholder structure
 * indicating the scraper has been initialized but has not yet collected
 * ad data.
 */
async function initializeAdsOutput() {
  const placeholder = {
    timestamp: new Date().toISOString(),
    status: 'initialized',
    competitors: [],
  };

  try {
    await fs.writeJson(PATHS.adsJson, placeholder, { spaces: 2 });
    await Logger.info(`Initialized output file at ${PATHS.adsJson}`);
  } catch (err) {
    await Logger.error(`Failed to initialize output/ads.json: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output: update ads.json with the latest run status and per-competitor results
// ---------------------------------------------------------------------------

/**
 * Overwrites output/ads.json with the current run status and the
 * accumulated per-competitor results (search/ad-detection status, merged
 * ad data, plus a lightweight network-capture summary — raw GraphQL
 * payloads themselves live under output/network/, not inline in ads.json).
 *
 * @param {'initialized'|'running'|'completed'|'failed'} status
 * @param {Array<{ competitor: string, success: boolean, ads?: object[], error?: string, network?: object }>} competitors
 */
async function updateAdsOutput(status, competitors) {
  const payload = {
    timestamp: new Date().toISOString(),
    status,
    competitors,
  };

  try {
    await fs.writeJson(PATHS.adsJson, payload, { spaces: 2 });
    await Logger.info(`Updated output/ads.json with status "${status}"`);
  } catch (err) {
    await Logger.error(`Failed to update output/ads.json: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Config: load competitor list (and target country) from competitors.json
// ---------------------------------------------------------------------------

/**
 * Loads and validates competitor configuration from config/competitors.json.
 * Supports:
 *   - a flat array of strings: ["Brand A", "Brand B"]
 *   - an object: { country: "India", competitors: ["Brand A", "Brand B"] }
 *
 * @returns {Promise<{ country: string, competitors: string[] }>}
 */
async function loadCompetitorConfig() {
  try {
    const exists = await fs.pathExists(PATHS.config);
    if (!exists) {
      throw new Error(`Config file not found at ${PATHS.config}`);
    }

    const data = await fs.readJson(PATHS.config);
    const rawList = Array.isArray(data) ? data : data.competitors;
    const country = (!Array.isArray(data) && data.country) || DEFAULT_COUNTRY;

    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new Error('competitors.json must contain a non-empty array of competitor names');
    }

    const competitors = rawList
      .map((entry) => (typeof entry === 'string' ? entry.trim() : entry?.name?.trim()))
      .filter(Boolean);

    if (competitors.length === 0) {
      throw new Error('No valid competitor names could be parsed from competitors.json');
    }

    await Logger.info(
      `Loaded ${competitors.length} competitor(s) from config/competitors.json (country: "${country}")`
    );

    return { country, competitors };
  } catch (err) {
    await Logger.error(`Failed to load competitor config: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser: launch Chromium with realistic desktop settings
// ---------------------------------------------------------------------------

/**
 * Launches a Chromium browser instance configured to resemble a real
 * desktop user (headless, but with a realistic viewport and UA applied
 * at the context level).
 *
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser() {
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    await Logger.info('Launched Chromium browser instance');
    return browser;
  } catch (err) {
    await Logger.error(`Failed to launch Chromium: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser: create a realistic desktop browser context
// ---------------------------------------------------------------------------

/**
 * Creates a single browser context configured with a realistic desktop
 * user agent, viewport, locale, and timezone to reduce the likelihood of
 * being flagged as an automated client.
 *
 * @param {import('playwright').Browser} browser
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function createBrowserContext(browser) {
  try {
    const context = await browser.newContext({
      userAgent: REALISTIC_USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    });

    await Logger.info('Created browser context with realistic desktop fingerprint');
    return context;
  } catch (err) {
    await Logger.error(`Failed to create browser context: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Browser: create a single reusable page
// ---------------------------------------------------------------------------

/**
 * Creates a single page within the given context, to be reused across
 * all competitor searches.
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>}
 */
async function createPage(context) {
  try {
    const page = await context.newPage();
    await Logger.info('Created new page for scraping session');
    return page;
  } catch (err) {
    await Logger.error(`Failed to create page: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Network: attach the interceptor once per page
// ---------------------------------------------------------------------------

/**
 * Attaches ./networkInterceptor to the page exactly once, before any
 * navigation happens, so it captures GraphQL/XHR traffic from the very
 * first request onward. Never throws — network capture is a diagnostic
 * aid, not a critical-path dependency, so a failure here should not
 * abort the scraper run.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function attachNetworkCapture(page) {
  try {
    await attachNetworkInterceptor(page);
    await Logger.info('Network interceptor attached (capturing Meta Ad Library GraphQL/XHR traffic)');
  } catch (err) {
    await Logger.warn(`Failed to attach network interceptor — continuing without network capture: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Network: persist whatever was captured for the current competitor
// ---------------------------------------------------------------------------

/**
 * Reads back everything captured since the last clearCapturedResponses()
 * call, writes the raw payloads to output/network/<competitor-slug>.json
 * (kept separate from ads.json so raw GraphQL payloads don't bloat the
 * main output file), and returns a lightweight summary for inclusion in
 * ads.json. Never throws — a network-capture failure should never fail
 * the competitor's overall result.
 *
 * @param {string} competitor
 * @returns {Promise<{ responseCount: number, edgeCount: number, hasNextPage: boolean|null, rawFile: string|null }>}
 */
async function captureNetworkForCompetitor(competitor) {
  const fallbackSummary = { responseCount: 0, edgeCount: 0, hasNextPage: null, rawFile: null };

  try {
    const responses = getCapturedResponses();

    const edgeCount = responses.reduce((sum, r) => sum + (r.pageInfo?.edgeCount || 0), 0);
    const lastPageInfo = responses.length > 0 ? responses[responses.length - 1].pageInfo : null;
    const hasNextPage = lastPageInfo ? lastPageInfo.hasNextPage : null;

    const rawFile = path.join(PATHS.network, `${toSlug(competitor)}.json`);

    await fs.writeJson(
      rawFile,
      {
        competitor,
        capturedAt: new Date().toISOString(),
        responseCount: responses.length,
        responses,
      },
      { spaces: 2 }
    );

    await Logger.info(
      `Persisted ${responses.length} network response(s) for "${competitor}" ` +
        `(edges: ${edgeCount}, hasNextPage: ${hasNextPage ?? 'n/a'}) -> ${rawFile}`
    );

    return { responseCount: responses.length, edgeCount, hasNextPage, rawFile };
  } catch (err) {
    await Logger.warn(`Failed to persist network capture for "${competitor}": ${err.message}`);
    return fallbackSummary;
  }
}

// ---------------------------------------------------------------------------
// GraphQL extraction (local fallback): recursively walk captured network
// payloads and normalize any Meta-Ad-shaped object found within them.
//
// This is used ONLY if ./networkInterceptor does not export its own
// extractAdsFromResponses(). If it does, that implementation is preferred
// (see processCompetitor below) since GraphQL parsing conceptually
// belongs to the module that captured the traffic in the first place.
// ---------------------------------------------------------------------------

/**
 * Heuristically identifies whether a plain object "looks like" a Meta ad
 * object, based on the presence of any of the known identifying fields.
 * Meta's GraphQL response shapes vary across endpoints/versions, so this
 * is intentionally permissive — false positives are filtered out later
 * by normalizeGraphQLAd() returning null for objects that don't yield
 * any usable fields. Never throws.
 *
 * @param {*} node
 * @returns {boolean}
 */
function looksLikeAdObject(node) {
  try {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;

    return (
      node.libraryId !== undefined ||
      node.ad_archive_id !== undefined ||
      node.adId !== undefined ||
      node.ad_archive !== undefined ||
      node.snapshot !== undefined ||
      node.creative !== undefined
    );
  } catch (e) {
    return false;
  }
}

/**
 * Pulls a best-effort list of media URLs out of a variety of shapes Meta
 * may use to represent images/videos (array of strings, array of objects
 * with url/src/original_image_url, or a single string). Never throws.
 *
 * @param {*} source
 * @returns {string[]}
 */
function collectMediaUrls(source) {
  try {
    if (!source) return [];

    if (typeof source === 'string') return [source];

    if (Array.isArray(source)) {
      return source
        .map((item) => {
          if (typeof item === 'string') return item;
          return item?.url ?? item?.src ?? item?.original_image_url ?? item?.original_video_url ?? null;
        })
        .filter(Boolean);
    }

    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Resolves an Active/Inactive status string from whichever field the
 * payload happens to expose. Never throws.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function resolveGraphQLStatus(raw) {
  try {
    if (typeof raw?.status === 'string') return raw.status;

    if (typeof raw?.ad_archive?.is_active === 'boolean') {
      return raw.ad_archive.is_active ? 'Active' : 'Inactive';
    }

    if (typeof raw?.isActive === 'boolean') {
      return raw.isActive ? 'Active' : 'Inactive';
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Normalizes a raw candidate object (identified by looksLikeAdObject)
 * into the fixed GraphQL ad shape. Uses optional chaining throughout so
 * a missing/differently-shaped nested field never throws — it just
 * resolves to null. Malformed candidates that yield nothing usable
 * return null so the caller can skip them.
 *
 * @param {*} raw
 * @returns {{
 *   libraryId: string|null,
 *   adId: string|null,
 *   advertiser: string|null,
 *   headline: string|null,
 *   primaryText: string|null,
 *   status: string|null,
 *   startDate: string|null,
 *   endDate: string|null,
 *   destinationUrl: string|null,
 *   images: string[],
 *   videos: string[],
 *   countries: string[]|null
 * }|null}
 */
function normalizeGraphQLAd(raw) {
  try {
    if (!raw || typeof raw !== 'object') return null;

    const snapshot = raw?.snapshot ?? raw?.ad_archive?.snapshot ?? null;
    const creative = raw?.creative ?? snapshot?.creative ?? null;

    const libraryIdRaw =
      raw?.libraryId ?? raw?.ad_archive_id ?? raw?.ad_archive?.ad_archive_id ?? raw?.adArchiveID ?? null;

    const adIdRaw = raw?.adId ?? raw?.ad_id ?? raw?.id ?? null;

    const advertiser =
      raw?.advertiser ??
      snapshot?.page_name ??
      raw?.page_name ??
      raw?.pageName ??
      creative?.advertiser_name ??
      null;

    const headline = snapshot?.title ?? creative?.title ?? raw?.headline ?? raw?.title ?? null;

    const primaryText =
      snapshot?.body?.text ??
      (typeof snapshot?.body === 'string' ? snapshot.body : null) ??
      creative?.body ??
      raw?.body ??
      raw?.primaryText ??
      null;

    const startDate = raw?.startDate ?? raw?.ad_archive?.start_date ?? raw?.start_date_string ?? null;

    const endDate = raw?.endDate ?? raw?.ad_archive?.end_date ?? raw?.end_date_string ?? null;

    const destinationUrl =
      snapshot?.link_url ?? creative?.link_url ?? raw?.destinationUrl ?? raw?.link_url ?? null;

    const images = collectMediaUrls(snapshot?.images ?? creative?.images ?? raw?.images);
    const videos = collectMediaUrls(snapshot?.videos ?? creative?.videos ?? raw?.videos);

    const countries = Array.isArray(raw?.countries)
      ? raw.countries
      : Array.isArray(raw?.ad_archive?.countries)
      ? raw.ad_archive.countries
      : null;

    const normalized = {
      libraryId: libraryIdRaw !== null && libraryIdRaw !== undefined ? String(libraryIdRaw) : null,
      adId: adIdRaw !== null && adIdRaw !== undefined ? String(adIdRaw) : null,
      advertiser: typeof advertiser === 'string' ? advertiser : null,
      headline: typeof headline === 'string' ? headline : null,
      primaryText: typeof primaryText === 'string' ? primaryText : null,
      status: resolveGraphQLStatus(raw),
      startDate: typeof startDate === 'string' ? startDate : null,
      endDate: typeof endDate === 'string' ? endDate : null,
      destinationUrl: typeof destinationUrl === 'string' ? destinationUrl : null,
      images,
      videos,
      countries,
    };

    // Skip candidates that matched looksLikeAdObject() but yielded
    // nothing usable at all (e.g. a false-positive structural match).
    const hasAnySignal =
      normalized.libraryId ||
      normalized.adId ||
      normalized.advertiser ||
      normalized.headline ||
      normalized.primaryText ||
      normalized.destinationUrl ||
      normalized.images.length > 0 ||
      normalized.videos.length > 0;

    return hasAnySignal ? normalized : null;
  } catch (e) {
    // Malformed object — skip rather than throw.
    return null;
  }
}

/**
 * extractGraphQLAds(responses) — local fallback implementation
 * ---------------------------------------------------------------------------
 * Pure JavaScript, no Playwright code. Recursively walks every captured
 * network response payload, collects every object that looks like a Meta
 * ad (per looksLikeAdObject), normalizes each into the fixed GraphQL ad
 * shape, deduplicates by libraryId, and returns the resulting array.
 *
 * Never throws: malformed responses, malformed nested objects, and
 * candidates that don't normalize into anything usable are all silently
 * skipped rather than aborting the whole extraction.
 *
 * @param {Array<object>} responses - raw captured responses from getCapturedResponses()
 * @returns {Array<object>} normalized, deduplicated GraphQL ads
 */
function extractGraphQLAds(responses) {
  if (!Array.isArray(responses) || responses.length === 0) return [];

  const MAX_WALK_DEPTH = 12;
  const collected = [];

  function walk(node, depth) {
    if (depth > MAX_WALK_DEPTH || node === null || node === undefined) return;

    try {
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }

      if (typeof node !== 'object') return;

      if (looksLikeAdObject(node)) {
        collected.push(node);
      }

      for (const key of Object.keys(node)) {
        walk(node[key], depth + 1);
      }
    } catch (e) {
      // Malformed/unwalkable node — skip it and continue with siblings.
    }
  }

  for (const response of responses) {
    try {
      walk(response, 0);
    } catch (e) {
      // Malformed response — skip entirely, continue with the rest.
    }
  }

  const normalized = collected.map((raw) => normalizeGraphQLAd(raw)).filter(Boolean);

  // Deduplicate by libraryId (first occurrence wins). Ads without a
  // libraryId are all kept, since there's no reliable key to dedup them
  // by at this layer.
  const seenLibraryIds = new Set();
  const deduped = [];

  for (const ad of normalized) {
    if (!ad.libraryId) {
      deduped.push(ad);
      continue;
    }

    if (!seenLibraryIds.has(ad.libraryId)) {
      seenLibraryIds.add(ad.libraryId);
      deduped.push(ad);
    }
  }

  return deduped;
}

/**
 * Resolves GraphQL ads for a competitor: prefers
 * networkInterceptor.extractAdsFromResponses() if that export exists
 * (GraphQL parsing conceptually belongs with the module that captured
 * the traffic), falling back to the local extractGraphQLAds() above
 * otherwise. Never throws — either path failing falls through to [].
 *
 * @param {Array<object>} responses
 * @returns {Array<object>}
 */
function resolveGraphQLAds(responses) {
  if (typeof networkInterceptorExtractAdsFromResponses === 'function') {
    try {
      return networkInterceptorExtractAdsFromResponses(responses) || [];
    } catch (err) {
      // Fall through to local implementation on unexpected failure.
    }
  }

  return extractGraphQLAds(responses);
}

// ---------------------------------------------------------------------------
// Orchestration: process a single competitor
// (reset network capture -> close popups -> select country -> select ad
//  category -> search -> wait for ads -> scroll until stable -> DOM
//  extract -> GraphQL extract -> merge -> download assets)
// ---------------------------------------------------------------------------

/**
 * Runs the full per-competitor workflow. Country and Ad Category filters
 * are re-applied on EVERY competitor iteration (not just once at session
 * start), since Meta can reset these filters between searches — this
 * mirrors the exact pipeline order specified for this project.
 *
 * Network capture is cleared before the competitor starts and persisted
 * after — on both the success and failure paths — since network traffic
 * is useful for debugging a DOM-side failure even when the DOM workflow
 * itself failed. Never throws — failures are captured in the returned
 * result object.
 *
 * Backward compatible by construction: if no GraphQL ads are found in
 * the captured traffic, resolveGraphQLAds() simply returns [], and
 * dataMerger.mergeAds(domAds, []) is called as usual — the scraper never
 * fails just because GraphQL data wasn't available.
 *
 * @param {import('playwright').Page} page
 * @param {string} competitor
 * @param {string} country
 * @returns {Promise<{
 *   competitor: string,
 *   success: boolean,
 *   ads: object[],
 *   stats: object,
 *   network: object,
 *   error?: string
 * }>}
 */
async function processCompetitor(page, competitor, country) {
  // -----------------------------------------------------------------
  // 1. Reset network capture for this competitor
  // -----------------------------------------------------------------
  clearCapturedResponses();

  try {
    await Logger.info(`Starting competitor: "${competitor}"`);

    // -----------------------------------------------------------------
    // 2. Dismiss any popup that may be present
    // -----------------------------------------------------------------
    await metaAdLibrary.closePopups(page);

    // -----------------------------------------------------------------
    // 3. SELECT COUNTRY — must happen BEFORE competitor search
    // -----------------------------------------------------------------
    await Logger.info(`Setting country filter to "${country}" for "${competitor}"`);
    await metaAdLibrary.selectCountry(page, country);
    await page.waitForTimeout(1500);

    // -----------------------------------------------------------------
    // 4. SELECT AD CATEGORY — "All ads", BEFORE competitor search
    // -----------------------------------------------------------------
    await Logger.info(`Setting ad category filter to "${DEFAULT_AD_CATEGORY}" for "${competitor}"`);
    await metaAdLibrary.selectAdCategory(page, DEFAULT_AD_CATEGORY);
    await page.waitForTimeout(1500);

    // -----------------------------------------------------------------
    // 5. NOW SEARCH COMPETITOR
    // -----------------------------------------------------------------
    const searchSucceeded = await metaAdLibrary.searchBrand(page, competitor);
    if (!searchSucceeded) {
      throw new Error(`Search submission failed for competitor "${competitor}"`);
    }

    // -----------------------------------------------------------------
    // 6. WAIT FOR RESULTS
    // -----------------------------------------------------------------
    await metaAdLibrary.closePopups(page);

    const adsFound = await metaAdLibrary.waitForAds(page);
    if (!adsFound) {
      throw new Error('No ad cards became visible within retry window');
    }

    // -----------------------------------------------------------------
    // 7. SCROLL UNTIL RESULTS STABILIZE
    // -----------------------------------------------------------------
    await metaAdLibrary.scrollUntilStable(page);

    // -----------------------------------------------------------------
    // 8. DOM EXTRACTION (delegated to ./parser)
    // -----------------------------------------------------------------
    const domResult = await parser.extractAds(page, competitor);
    // Defensive: accept either a bare array or a { ads, stats } shape,
    // in case parser.extractAds's return contract ever changes.
    const domAds = Array.isArray(domResult) ? domResult : domResult?.ads || [];
    const extractionStats = Array.isArray(domResult) ? {} : domResult?.stats || {};

    // -----------------------------------------------------------------
    // 9. GRAPHQL EXTRACTION (persist + summarize, then extract)
    // -----------------------------------------------------------------
    const network = await captureNetworkForCompetitor(competitor);

    const rawResponses = getCapturedResponses();
    const graphqlAds = resolveGraphQLAds(rawResponses);

    await Logger.info(
      `Extracted ${graphqlAds.length} GraphQL ad(s) for "${competitor}" from ${rawResponses.length} captured response(s)`
    );

    // -----------------------------------------------------------------
    // 10. MERGE DOM + GRAPHQL (delegated to ./dataMerger)
    // -----------------------------------------------------------------
    const merged = dataMerger.mergeAds(domAds, graphqlAds);
    const mergedAds = merged?.ads || [];

    // -----------------------------------------------------------------
    // 11. DOWNLOAD MEDIA (delegated to ./downloader)
    // -----------------------------------------------------------------
    let assetStats = { downloadedImages: 0, downloadedVideos: 0, skipped: 0, failed: [] };
    try {
      assetStats = await downloader.downloadAssets(mergedAds, PATHS.assets);
      await Logger.info(
        `Downloaded assets for "${competitor}": ${assetStats.downloadedImages} image(s), ` +
          `${assetStats.downloadedVideos} video(s), ${assetStats.skipped} skipped, ` +
          `${assetStats.failed.length} failed`
      );
    } catch (err) {
      await Logger.warn(`Asset download failed unexpectedly for "${competitor}": ${err.message}`);
    }

    // -----------------------------------------------------------------
    // 12. RESULT
    // -----------------------------------------------------------------
    await Logger.info(
      `Successfully processed competitor: "${competitor}" - ${mergedAds.length} merged ad(s)`
    );

    return {
      competitor,
      success: true,
      ads: mergedAds,
      stats: {
        ...extractionStats,
        ...(merged?.stats || {}),
        assets: assetStats,
        network: {
          responseCount: network.responseCount,
          edgeCount: network.edgeCount,
          hasNextPage: network.hasNextPage,
        },
      },
      network,
    };
  } catch (err) {
    const network = await captureNetworkForCompetitor(competitor);

    // Cross-check: if the DOM workflow failed but the network layer still
    // saw ad edges for this competitor, that's a strong signal the DOM
    // side (waitForAds / markup) is what broke, not that Meta returned no
    // data — worth surfacing distinctly from the generic failure log.
    if (network.edgeCount > 0) {
      await Logger.warn(
        `Competitor "${competitor}" failed on the DOM side ("${err.message}") but the network layer ` +
          `captured ${network.edgeCount} edge(s) — likely a DOM/markup mismatch rather than missing data. ` +
          `See ${network.rawFile}`
      );
    }

    await Logger.error(`Failed to process competitor "${competitor}": ${err.message}`);
    return { competitor, success: false, ads: [], error: err.message, network };
  }
}

// ---------------------------------------------------------------------------
// Orchestration: process all competitors sequentially
// ---------------------------------------------------------------------------

/**
 * Iterates over the competitor list, processing each one sequentially on
 * the shared page. Accumulates and returns per-competitor results.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} competitors
 * @param {string} country
 * @returns {Promise<Array<{ competitor: string, success: boolean, ads: object[], stats?: object, error?: string, network?: object }>>}
 */
async function processCompetitors(page, competitors, country) {
  const results = [];

  for (const competitor of competitors) {
    const result = await processCompetitor(page, competitor, country);
    results.push(result);

    // Persist progress incrementally so partial results are never lost
    // if a later competitor causes an unexpected failure.
    await updateAdsOutput('running', results);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Cleanup: close browser cleanly
// ---------------------------------------------------------------------------

/**
 * Closes the browser instance, swallowing any errors to ensure shutdown
 * never crashes the process.
 *
 * @param {import('playwright').Browser} browser
 */
async function closeBrowser(browser) {
  if (!browser) {
    return;
  }

  try {
    await browser.close();
    await Logger.info('Browser closed cleanly');
  } catch (err) {
    await Logger.error(`Error while closing browser: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Main orchestration function for the scraper module. Sets up the
 * environment, launches the browser, attaches network capture, opens
 * Meta Ad Library and accepts cookies ONCE, then processes each
 * competitor (which re-applies country/category filters, searches,
 * waits, scrolls, extracts, merges, and downloads per iteration), and
 * ensures a clean shutdown regardless of success or failure.
 */
async function main() {
  let browser;

  try {
    await ensureDirectories();
    await initializeAdsOutput();

    const { country, competitors } = await loadCompetitorConfig();

    browser = await launchBrowser();
    const context = await createBrowserContext(browser);
    const page = await createPage(context);

    // Attach network capture before any navigation.
    await attachNetworkCapture(page);

    // --- One-time session setup: open the library, accept cookies.
    // Country and Ad Category are NOT selected here — they are
    // re-applied per competitor inside processCompetitor(), per the
    // required pipeline order. ---
    await metaAdLibrary.launch(page);
    await metaAdLibrary.acceptCookies(page);

    const results = await processCompetitors(page, competitors, country);

    const overallStatus = results.every((r) => r.success) ? 'completed' : 'completed_with_errors';
    await updateAdsOutput(overallStatus, results);

    await Logger.info(`Scraper run finished with status: "${overallStatus}"`);
  } catch (err) {
    await Logger.error(`Fatal error during scraper execution: ${err.message}`);
    await updateAdsOutput('failed', []).catch(() => {});
    process.exitCode = 1;
  } finally {
    await closeBrowser(browser);
  }
}

// Execute only when run directly (node src/scraper.js), allowing this
// module to be safely imported elsewhere (e.g. tests) without side effects.
if (require.main === module) {
  main();
}

module.exports = {
  ensureDirectories,
  initializeAdsOutput,
  updateAdsOutput,
  loadCompetitorConfig,
  launchBrowser,
  createBrowserContext,
  createPage,
  attachNetworkCapture,
  captureNetworkForCompetitor,
  extractGraphQLAds,
  resolveGraphQLAds,
  processCompetitor,
  processCompetitors,
  closeBrowser,
  main,
};
