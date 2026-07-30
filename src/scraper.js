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
 * - Loop through competitors, search each brand, wait for ads, log results
 * - Persist captured network traffic per competitor for pagination/edge
 *   counts and DOM-failure debugging
 * - Cleanly shut down the browser
 *
 * This module intentionally contains NO Meta Ad Library navigation logic.
 * All page-level interaction (launch, cookies, country selection, search,
 * waiting for ads, popups) lives in ./metaAdLibrary and is only invoked
 * here. Network capture is similarly delegated to ./networkInterceptor —
 * this module only attaches it, clears it per competitor, and persists
 * whatever it captured.
 *
 * Usage:
 * node src/scraper.js
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { chromium } = require('playwright');

const metaAdLibrary = require('./metaAdLibrary');
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
 * accumulated per-competitor results (search/ad-detection status, plus a
 * lightweight network-capture summary — raw GraphQL payloads themselves
 * live under output/network/, not inline in ads.json).
 *
 * @param {'initialized'|'running'|'completed'|'failed'} status
 * @param {Array<{ competitor: string, success: boolean, error?: string, network?: object }>} competitors
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
// Orchestration: process a single competitor (search + wait for ads)
// ---------------------------------------------------------------------------

/**
 * Runs the search + ad-detection workflow for a single competitor,
 * delegating all page interaction to ./metaAdLibrary. Network capture is
 * cleared before the competitor starts and persisted after — on both the
 * success and failure paths — since network traffic is useful for
 * debugging a DOM-side failure even when the DOM workflow itself failed.
 * Never throws — failures are captured in the returned result object.
 *
 * @param {import('playwright').Page} page
 * @param {string} competitor
 * @returns {Promise<{ competitor: string, success: boolean, error?: string, network: object }>}
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

    const network = await captureNetworkForCompetitor(competitor);

    await Logger.info(`Successfully processed competitor: "${competitor}"`);
    return { competitor, success: true, network };
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
    return { competitor, success: false, error: err.message, network };
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
 * @returns {Promise<Array<{ competitor: string, success: boolean, error?: string, network?: object }>>}
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
  processCompetitor,
  processCompetitors,
  closeBrowser,
  main,
};
