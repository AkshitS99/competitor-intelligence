/**
 * scraper.js
 *
 * Scrapes the Meta Ad Library (https://www.facebook.com/ads/library/) for
 * a list of competitor brands defined in config/competitors.json, extracting
 * key details from each ad card and saving the aggregated results to
 * output/ads.json.
 *
 * Usage:
 *   node scraper.js
 *
 * Requires: playwright, fs-extra, dotenv (loaded for future config/env use)
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const { chromium } = require('playwright');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, 'config', 'competitors.json');
const OUTPUT_DIR = path.join(__dirname, 'output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'ads.json');

const AD_LIBRARY_BASE_URL = 'https://www.facebook.com/ads/library/';

// Tunable timeouts / delays
const NAVIGATION_TIMEOUT_MS = 45000;
const SELECTOR_TIMEOUT_MS = 20000;
const POST_SEARCH_WAIT_MS = 3000;
const MAX_ADS_PER_COMPETITOR = 20;

// ---------------------------------------------------------------------------
// Utility: load competitor list from config
// ---------------------------------------------------------------------------

async function loadCompetitors(configPath) {
  try {
    const exists = await fs.pathExists(configPath);
    if (!exists) {
      throw new Error(`Config file not found at ${configPath}`);
    }

    const data = await fs.readJson(configPath);

    // Support either a flat array of strings or an array of objects { name }
    const competitors = Array.isArray(data) ? data : data.competitors;

    if (!Array.isArray(competitors) || competitors.length === 0) {
      throw new Error('competitors.json must contain a non-empty array of competitor names');
    }

    return competitors.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
  } catch (err) {
    console.error(`[loadCompetitors] Failed to load competitors: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Utility: build the search URL for a given competitor
// ---------------------------------------------------------------------------

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
// Core: navigate to the Ad Library and search for a competitor
// ---------------------------------------------------------------------------

async function searchCompetitor(page, competitorName) {
  const url = buildSearchUrl(competitorName);
  console.log(`[searchCompetitor] Navigating to Ad Library for "${competitorName}"`);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  // Meta Ad Library renders results asynchronously; wait for a results
  // container or a "no results" message before proceeding.
  try {
    await page.waitForSelector('[role="main"]', { timeout: SELECTOR_TIMEOUT_MS });
  } catch (err) {
    console.warn(`[searchCompetitor] Main content region did not appear for "${competitorName}": ${err.message}`);
  }

  // Give the page additional time for ad cards to hydrate/load images etc.
  await page.waitForTimeout(POST_SEARCH_WAIT_MS);

  // Scroll a few times to trigger lazy-loaded ad cards.
  await autoScroll(page);
}

// ---------------------------------------------------------------------------
// Utility: scroll the page to trigger lazy loading of additional ad cards
// ---------------------------------------------------------------------------

async function autoScroll(page, steps = 5, delayMs = 800) {
  for (let i = 0; i < steps; i += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Core: extract ad details from the current page for a given competitor
// ---------------------------------------------------------------------------

async function extractAds(page, competitorName) {
  // NOTE: Meta Ad Library's DOM structure and class names are obfuscated and
  // change frequently. The selectors below rely on visible text patterns and
  // generic structural cues rather than brittle auto-generated class names.
  // Adjust selectors if Meta changes their markup.

  const ads = await page.evaluate(
    ({ maxAds }) => {
      const results = [];

      // Ad cards typically live inside elements with role="article" or
      // similar containers. We look broadly and then filter by content.
      const candidateNodes = Array.from(
        document.querySelectorAll('div[role="article"], div[data-testid="ad-library-card"]')
      );

      const nodesToUse = candidateNodes.length > 0
        ? candidateNodes
        : Array.from(document.querySelectorAll('div')).filter((el) =>
            el.innerText && el.innerText.includes('Library ID')
          );

      for (const node of nodesToUse.slice(0, maxAds)) {
        const text = node.innerText || '';

        // --- Brand ---
        // Brand name is usually the first bold/prominent line in the card.
        let brand = null;
        const brandEl = node.querySelector('a[role="link"] span, h4, strong');
        if (brandEl && brandEl.innerText.trim()) {
          brand = brandEl.innerText.trim();
        }

        // --- Ad copy ---
        // Ad body copy is usually the longest text block within the card.
        let adCopy = null;
        const textBlocks = Array.from(node.querySelectorAll('span, div'))
          .map((el) => el.innerText)
          .filter((t) => t && t.trim().length > 30);
        if (textBlocks.length > 0) {
          adCopy = textBlocks.sort((a, b) => b.length - a.length)[0].trim();
        }

        // --- CTA ---
        // Common CTA labels shown as buttons/links.
        const ctaKeywords = [
          'Shop Now',
          'Learn More',
          'Sign Up',
          'Download',
          'Get Offer',
          'Book Now',
          'Contact Us',
          'Apply Now',
          'Subscribe',
          'Watch More',
        ];
        let cta = null;
        for (const keyword of ctaKeywords) {
          if (text.includes(keyword)) {
            cta = keyword;
            break;
          }
        }

        // --- Landing page ---
        let landingPage = null;
        const linkEl = Array.from(node.querySelectorAll('a[href]')).find((a) => {
          try {
            const href = a.getAttribute('href') || '';
            return (
              href.startsWith('http') &&
              !href.includes('facebook.com') &&
              !href.includes('fb.com')
            );
          } catch (e) {
            return false;
          }
        });
        if (linkEl) {
          landingPage = linkEl.getAttribute('href');
        }

        // --- Start date ---
        // Ad Library typically shows "Started running on <date>".
        let startDate = null;
        const startMatch = text.match(/Started running on ([A-Za-z]+ \d{1,2}, \d{4})/);
        if (startMatch) {
          startDate = startMatch[1];
        }

        // Only keep entries that have at least some useful signal.
        if (brand || adCopy || cta || landingPage || startDate) {
          results.push({
            brand,
            adCopy,
            cta,
            landingPage,
            startDate,
          });
        }
      }

      return results;
    },
    { maxAds: MAX_ADS_PER_COMPETITOR }
  );

  return ads.map((ad) => ({
    competitor: competitorName,
    ...ad,
  }));
}

// ---------------------------------------------------------------------------
// Core: process a single competitor end-to-end (search + extract), with
// isolated error handling so one failure doesn't halt the whole run.
// ---------------------------------------------------------------------------

async function processCompetitor(context, competitorName) {
  const page = await context.newPage();

  try {
    await searchCompetitor(page, competitorName);
    const ads = await extractAds(page, competitorName);
    console.log(`[processCompetitor] Extracted ${ads.length} ad(s) for "${competitorName}"`);
    return { competitor: competitorName, success: true, ads };
  } catch (err) {
    console.error(`[processCompetitor] Error processing "${competitorName}": ${err.message}`);
    return { competitor: competitorName, success: false, error: err.message, ads: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Core: save aggregated results to disk
// ---------------------------------------------------------------------------

async function saveResults(results) {
  try {
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeJson(OUTPUT_PATH, results, { spaces: 2 });
    console.log(`[saveResults] Results saved to ${OUTPUT_PATH}`);
  } catch (err) {
    console.error(`[saveResults] Failed to write output file: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  let browser;

  try {
    const competitors = await loadCompetitors(CONFIG_PATH);
    console.log(`[main] Loaded ${competitors.length} competitor(s): ${competitors.join(', ')}`);

    browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
    });

    const allResults = [];

    // Process competitors sequentially to avoid overwhelming the target
    // site and to keep resource usage predictable. Could be parallelized
    // with Promise.all + separate contexts if throughput is a priority.
    for (const competitor of competitors) {
      const result = await processCompetitor(context, competitor);
      allResults.push(result);
    }

    await saveResults({
      scrapedAt: new Date().toISOString(),
      totalCompetitors: competitors.length,
      results: allResults,
    });

    console.log('[main] Scraping run completed successfully.');
  } catch (err) {
    console.error(`[main] Fatal error during scraping run: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// Only run automatically when executed directly (node scraper.js),
// allowing this module to be imported/tested elsewhere without side effects.
if (require.main === module) {
  main();
}

module.exports = {
  loadCompetitors,
  buildSearchUrl,
  searchCompetitor,
  extractAds,
  processCompetitor,
  saveResults,
  main,
};
