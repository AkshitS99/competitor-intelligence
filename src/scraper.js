/**
 * src/scraper.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Phase 1 Scraper Module
 *
 * Responsibilities in this phase:
 *   - Bootstrap required project directories (output, logs, assets, reports)
 *   - Initialize output/ads.json as a placeholder result file
 *   - Read the competitor list from config/competitors.json
 *   - Launch a realistic desktop Chromium browser via Playwright
 *   - Open the Meta Ad Library and search for each competitor
 *   - Wait for search results to render and log progress
 *   - Cleanly shut down the browser
 *
 * NOTE: Advertisement data extraction is intentionally NOT implemented in
 * this phase, per requirements. This module only verifies that navigation
 * and search flows work correctly for each competitor.
 *
 * Usage:
 *   node src/scraper.js
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { chromium } = require('playwright');

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
  adsJson: path.join(ROOT_DIR, 'output', 'ads.json'),
  logFile: path.join(ROOT_DIR, 'logs', 'scraper.log'),
};

const AD_LIBRARY_BASE_URL = 'https://www.facebook.com/ads/library/';

const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUTS = {
  navigation: 45000,
  selector: 20000,
  postSearchWaitMs: 3000,
};

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
// Bootstrap: ensure required project directories exist
// ---------------------------------------------------------------------------

/**
 * Ensures all directories required by the platform exist before the
 * scraper runs. Safe to call repeatedly (idempotent).
 */
async function ensureDirectories() {
  const requiredDirs = [PATHS.output, PATHS.logs, PATHS.assets, PATHS.reports];

  for (const dir of requiredDirs) {
    await fs.ensureDir(dir);
  }

  await Logger.info('Verified/created required directories: output/, logs/, assets/, reports/');
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
// Config: load competitor list
// ---------------------------------------------------------------------------

/**
 * Loads and validates the competitor list from config/competitors.json.
 * Supports either a flat array of strings or an object with a
 * `competitors` array of strings/objects.
 *
 * @returns {Promise<string[]>} list of competitor names
 */
async function loadCompetitors() {
  try {
    const exists = await fs.pathExists(PATHS.config);
    if (!exists) {
      throw new Error(`Config file not found at ${PATHS.config}`);
    }

    const data = await fs.readJson(PATHS.config);
    const rawList = Array.isArray(data) ? data : data.competitors;

    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new Error('competitors.json must contain a non-empty array of competitor names');
    }

    const competitors = rawList
      .map((entry) => (typeof entry === 'string' ? entry.trim() : entry?.name?.trim()))
      .filter(Boolean);

    if (competitors.length === 0) {
      throw new Error('No valid competitor names could be parsed from competitors.json');
    }

    await Logger.info(`Loaded ${competitors.length} competitor(s) from config/competitors.json`);
    return competitors;
  } catch (err) {
    await Logger.error(`Failed to load competitors: ${err.message}`);
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

    context.setDefaultNavigationTimeout(TIMEOUTS.navigation);
    context.setDefaultTimeout(TIMEOUTS.selector);

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
// Navigation: build the Meta Ad Library search URL for a competitor
// ---------------------------------------------------------------------------

/**
 * Builds a Meta Ad Library search URL for the given competitor name.
 *
 * @param {string} competitorName
 * @returns {string}
 */
function buildSearchUrl(competitorName) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: 'ALL',
    q: competitorName,
    media_type: 'all',
  });

  return `${AD_LIBRARY_BASE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Navigation: open Meta Ad Library and search for a competitor
// ---------------------------------------------------------------------------

/**
 * Navigates the given page to the Meta Ad Library search results for a
 * specific competitor and waits for the results region to render.
 *
 * Does NOT extract any ad data — this phase only validates that the
 * search flow completes successfully.
 *
 * @param {import('playwright').Page} page
 * @param {string} competitorName
 */
async function searchCompetitor(page, competitorName) {
  const url = buildSearchUrl(competitorName);

  await Logger.info(`Navigating to Meta Ad Library for competitor: "${competitorName}"`);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUTS.navigation,
  });

  await waitForResults(page, competitorName);

  await Logger.info(`Search completed for competitor: "${competitorName}"`);
}

// ---------------------------------------------------------------------------
// Navigation: wait for search results to render
// ---------------------------------------------------------------------------

/**
 * Waits for the Ad Library results region to appear on the page. Falls
 * back gracefully with a warning if the expected selector does not show
 * up in time, without throwing (since the platform may still be usable).
 *
 * @param {import('playwright').Page} page
 * @param {string} competitorName
 */
async function waitForResults(page, competitorName) {
  try {
    await page.waitForSelector('[role="main"]', { timeout: TIMEOUTS.selector });
    await page.waitForTimeout(TIMEOUTS.postSearchWaitMs);
    await Logger.info(`Results region detected for competitor: "${competitorName}"`);
  } catch (err) {
    await Logger.warn(
      `Results region did not appear in time for "${competitorName}": ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestration: process all competitors sequentially
// ---------------------------------------------------------------------------

/**
 * Iterates over the competitor list, performing a search for each one on
 * the shared page. Errors for an individual competitor are logged and
 * do not halt processing of the remaining competitors.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} competitors
 */
async function processCompetitors(page, competitors) {
  for (const competitor of competitors) {
    try {
      await searchCompetitor(page, competitor);
    } catch (err) {
      await Logger.error(`Failed to process competitor "${competitor}": ${err.message}`);
    }
  }
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
 * environment, launches the browser, processes each competitor's search
 * flow, and ensures a clean shutdown regardless of success or failure.
 */
async function main() {
  let browser;

  try {
    await ensureDirectories();
    await initializeAdsOutput();

    const competitors = await loadCompetitors();

    browser = await launchBrowser();
    const context = await createBrowserContext(browser);
    const page = await createPage(context);

    await processCompetitors(page, competitors);

    await Logger.info('Scraper phase 1 (search validation) completed successfully');
  } catch (err) {
    await Logger.error(`Fatal error during scraper execution: ${err.message}`);
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
  loadCompetitors,
  launchBrowser,
  createBrowserContext,
  createPage,
  buildSearchUrl,
  searchCompetitor,
  waitForResults,
  processCompetitors,
  closeBrowser,
  main,
};
