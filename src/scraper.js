/**
 * src/scraper.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Orchestration Module
 *
 * Responsibilities:
 * - Bootstrap required project directories (output, logs, assets, reports,
 *   output/network)
 * - Initialize/update output/ads.json with run status
 * - Read competitor list (and target country) from config/competitors.json
 * - Launch a realistic desktop Chromium browser via Playwright
 * - Delegate ALL Meta Ad Library interaction to ./metaAdLibrary
 * - Attach ./networkInterceptor once per page to passively capture Meta
 *   Ad Library GraphQL/XHR traffic alongside the DOM-driven workflow
 * - Delegate DOM ad extraction to ./parser
 * - Extract and normalize GraphQL ad objects from captured network traffic
 * - Merge DOM-extracted ads with GraphQL-extracted ads via ./dataMerger
 * - Loop through competitors, search each brand, wait for ads, scroll
 *   until the feed stabilizes, extract + merge, log results
 * - Persist captured network traffic per competitor for pagination/edge
 *   counts and DOM-failure debugging
 * - Cleanly shut down the browser
 *
 * This module intentionally contains NO Meta Ad Library navigation logic
 * and NO DOM parsing logic. All page-level interaction (launch, cookies,
 * country selection, search, waiting for ads, scrolling, popups) lives in
 * ./metaAdLibrary; all DOM extraction lives in ./parser; all GraphQL/XHR
 * capture lives in ./networkInterceptor; all dataset merging lives in
 * ./dataMerger. This module only wires them together.
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
 * first request onward (including whatever traffic country selection
 * triggers, ahead of the first competitor search). Never throws —
 * network capture is a diagnostic aid, not a critical-path dependency,
 * so a failure here should not abort the scraper run.
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
// GraphQL extraction: recursively walk captured network payloads and
// normalize any Meta-Ad-shaped object found within them
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
 * extractGraphQLAds(responses)
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

// ---------------------------------------------------------------------------
// Orchestration: process a single competitor
// (search -> wait for ads -> scroll until stable -> DOM extract ->
//  network capture -> GraphQL extract -> merge)
// ---------------------------------------------------------------------------

/**
 * Runs the full per-competitor workflow: search, wait for ads, scroll
 * until the feed stabilizes (delegated to ./metaAdLibrary), extract DOM
 * ads (delegated to ./parser), persist + summarize captured network
 * traffic, extract and normalize GraphQL ads from that traffic, and
 * merge both datasets (delegated to ./dataMerger).
 *
 * Network capture is cleared before the competitor starts and persisted
 * after — on both the success and failure paths — since network traffic
 * is useful for debugging a DOM-side failure even when the DOM workflow
 * itself failed. Never throws — failures are captured in the returned
 * result object.
 *
 * Backward compatible by construction: if no GraphQL ads are found in
 * the captured traffic, extractGraphQLAds() simply returns [], and
 * dataMerger.mergeAds(domAds, []) is called as usual — the scraper never
 * fails just because GraphQL data wasn't available.
 *
 * @param {import('playwright').Page} page
 * @param {string} competitor
 * @returns {Promise<{
 *   competitor: string,
 *   success: boolean,
 *   ads: object[],
 *   stats: object,
 *   network: object,
 *   error?: string
 * }>}
 */
async function processCompetitor(page, competitor) {
  // Reset the network buffer so this competitor's persisted capture
  // doesn't include traffic from a previous competitor (or from the
  // pre-loop launch/cookie/country-selection steps).
  clearCapturedResponses();

  try {
    await metaAdLibrary.closePopups(page);

    const searchSucceeded = await metaAdLibrary.searchBrand(page, competitor);
    if (!searchSucceeded) {
      throw new Error('Search submission failed or results did not load');
    }

    await metaAdLibrary.closePopups(page);

    const adsFound = await metaAdLibrary.waitForAds(page);
    if (!adsFound) {
      throw new Error('No ad cards became visible within retry window');
    }

    // Load the FULL result set before parsing — Meta virtualizes the
    // feed and only renders a viewport's worth of cards at a time.
    await metaAdLibrary.scrollUntilStable(page);

    // --- DOM extraction (delegated to ./parser — unchanged) ---
    const extraction = await parser.extractAds(page, competitor);

    // --- Network capture: persist + summarize what was captured ---
    const network = await captureNetworkForCompetitor(competitor);

    // --- GraphQL extraction: normalize ad objects out of the raw
    // captured responses (pure JS, no Playwright/DOM involved) ---
    const rawResponses = getCapturedResponses();
    const graphqlAds = extractGraphQLAds(rawResponses);

    await Logger.info(
      `Extracted ${graphqlAds.length} GraphQL ad(s) for "${competitor}" from ${rawResponses.length} captured response(s)`
    );

    // --- Merge DOM ads + GraphQL ads (delegated to ./dataMerger) ---
    // If graphqlAds is empty, this is equivalent to
    // dataMerger.mergeAds(extraction.ads, []) — the scraper continues to
    // work exactly as before using DOM ads only.
    const merged = dataMerger.mergeAds(extraction.ads, graphqlAds);
    // --- Asset download: fetch every image/video referenced in the
    // merged ads (delegated to ./downloader). Wrapped defensively so a
    // download-layer problem never turns an otherwise-successful
    // competitor result into a failure — downloader.js is designed to
    // never throw, but this guards against any unexpected surprise.
    let assetStats = { downloadedImages: 0, downloadedVideos: 0, skipped: 0, failed: [] };
    try {
      assetStats = await downloader.downloadAssets(merged.ads, PATHS.assets);
      await Logger.info(
        `Downloaded assets for "${competitor}": ${assetStats.downloadedImages} image(s), ` +
          `${assetStats.downloadedVideos} video(s), ${assetStats.skipped} skipped, ` +
          `${assetStats.failed.length} failed`
      );
    } catch (err) {
      await Logger.warn(`Asset download failed unexpectedly for "${competitor}": ${err.message}`);
    }

    await Logger.info(
      `Successfully processed competitor: "${competitor}" - ${merged.ads.length} merged ad(s)`
    );

    return {
      competitor,
      success: true,
      ads: merged.ads,
      stats: {
        ...extraction.stats,
        ...merged.stats,
        assets: assetStats,
        network: {
          responseCount: network.responseCount,
          edgeCount: network.edgeCount,
          hasNextPage: network.hasNextPage,
        },
      },
      network,
    };

    await Logger.info(
      `Successfully processed competitor: "${competitor}" - ${merged.ads.length} merged ad(s)`
    );

    return {
      competitor,
      success: true,
      ads: merged.ads,
      stats: {
        ...extraction.stats,
        ...merged.stats,
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
 * @returns {Promise<Array<{ competitor: string, success: boolean, ads: object[], stats?: object, error?: string, network?: object }>>}
 */
async function processCompetitors(page, competitors) {
  const results = [];

  for (const competitor of competitors) {
    const result = await processCompetitor(page, competitor);
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
 * environment, launches the browser, delegates Meta Ad Library
 * interaction to ./metaAdLibrary, attaches network capture, processes
 * each competitor, and ensures a clean shutdown regardless of success or
 * failure.
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

    // Attach network capture before any navigation, so it's in place for
    // whatever traffic country selection triggers ahead of the first
    // competitor search.
    await attachNetworkCapture(page);

    // --- Meta Ad Library interaction is fully delegated ---
    await metaAdLibrary.launch(page);
    await metaAdLibrary.acceptCookies(page);
    await metaAdLibrary.selectCountry(page, country);

    const results = await processCompetitors(page, competitors);

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
  processCompetitor,
  processCompetitors,
  closeBrowser,
  main,
};
