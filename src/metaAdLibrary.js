/**
 * src/metaAdLibrary.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Meta Ad Library Navigation Module
 *
 * Sole responsibility: interact with the Meta Ad Library web UI
 * (navigation, cookie/consent handling, country selection, brand search,
 * waiting for ad results, and dismissing popups).
 *
 * This module MUST NOT:
 *   - Analyse or interpret ad content
 *   - Persist/save JSON, files, or reports
 *   - Download assets/media
 *
 * All extraction, persistence, and reporting responsibilities live in
 * other modules that consume this one.
 *
 * All exported functions are async and designed to be resilient: they
 * favor graceful degradation (logging + continuing) over throwing,
 * except where a boolean return value communicates success/failure to
 * the caller.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AD_LIBRARY_URL =
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all';

const TIMEOUTS = {
  navigation: 45000,
  selector: 15000,
  short: 5000,
  stability: 2000,
};

const RETRY = {
  maxAttempts: 3,
  delayMs: 1500,
};

// ---------------------------------------------------------------------------
// Internal utility: simple console logger with consistent formatting
// ---------------------------------------------------------------------------

/**
 * Lightweight internal logger. This module intentionally avoids writing
 * to files (that responsibility belongs to a dedicated logging/reporting
 * module) and only logs to the console.
 *
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [metaAdLibrary] [${level}] ${message}`;

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Internal utility: generic retry wrapper
// ---------------------------------------------------------------------------

/**
 * Executes an async function up to `maxAttempts` times, waiting
 * `delayMs` between attempts. Resolves with the function's return value
 * on first success, or `fallback` if all attempts fail.
 *
 * @param {() => Promise<any>} fn
 * @param {{ maxAttempts?: number, delayMs?: number, label?: string, fallback?: any }} [options]
 * @returns {Promise<any>}
 */
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = RETRY.maxAttempts,
    delayMs = RETRY.delayMs,
    label = 'operation',
    fallback = false,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      log('WARN', `Attempt ${attempt}/${maxAttempts} failed for ${label}: ${err.message}`);

      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  log('ERROR', `All ${maxAttempts} attempts failed for ${label}: ${lastError?.message}`);
  return fallback;
}

/**
 * Simple promise-based sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. launch(page)
// ---------------------------------------------------------------------------

/**
 * Opens the Meta Ad Library in the given page, waits for DOMContentLoaded,
 * and waits briefly for the page to stabilize (network/render settling).
 * Logs the resulting URL for traceability.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function launch(page) {
  try {
    log('INFO', `Navigating to Meta Ad Library: ${AD_LIBRARY_URL}`);

    await page.goto(AD_LIBRARY_URL, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.navigation,
    });

    // Allow the SPA to stabilize
    await page.waitForTimeout(TIMEOUTS.stability);

    // Save screenshot for debugging
    await page.screenshot({
      path: 'logs/meta-home.png',
      fullPage: true,
    });

    // Save HTML for debugging
    const html = await page.content();
    await require('fs').promises.writeFile(
      'logs/meta-home.html',
      html,
      'utf8'
    );

    log('INFO', `Meta Ad Library loaded. Current URL: ${page.url()}`);
  } catch (err) {
    log('ERROR', `Failed to launch Meta Ad Library: ${err.message}`);
    throw err;
  }
}
// ---------------------------------------------------------------------------
// 2. acceptCookies(page)
// ---------------------------------------------------------------------------

/**
 * Attempts to dismiss the cookie/consent dialog if present. If no such
 * dialog is found, continues silently. This function must never throw.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function acceptCookies(page) {
  const candidateTexts = [
    'Allow all cookies',
    'Accept all',
    'Accept All',
    'Allow essential and optional cookies',
    'Only allow essential cookies',
  ];

  try {
    for (const text of candidateTexts) {
      const button = page.getByRole('button', { name: text }).first();

      const isVisible = await button.isVisible({ timeout: TIMEOUTS.short }).catch(() => false);

      if (isVisible) {
        await button.click({ timeout: TIMEOUTS.short }).catch(() => {});
        log('INFO', `Dismissed cookie consent dialog using button labeled "${text}"`);
        return;
      }
    }

    log('INFO', 'No cookie consent dialog detected. Continuing.');
  } catch (err) {
    // Swallow all errors — this function must never throw.
    log('WARN', `acceptCookies encountered a non-fatal issue: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. selectCountry(page, country)
// ---------------------------------------------------------------------------

/**
 * Selects the requested country in the Ad Library's country filter, if
 * the selector/control is present. Silently continues if the control
 * cannot be found (e.g. UI variant without a country selector, or the
 * default "ALL" is already sufficient).
 *
 * @param {import('playwright').Page} page
 * @param {string} country - e.g. "India", "United States"
 * @returns {Promise<void>}
 */
async function selectCountry(page, country) {
  if (!country || typeof country !== 'string') {
    log('WARN', 'selectCountry called without a valid country value. Skipping.');
    return;
  }

  try {
    // The country control is typically a combobox/button that opens a
    // searchable dropdown. We attempt a generic role-based lookup first.
    const countryControl = page
      .getByRole('combobox', { name: /country/i })
      .or(page.getByRole('button', { name: /country/i }))
      .first();

    const controlVisible = await countryControl
      .isVisible({ timeout: TIMEOUTS.short })
      .catch(() => false);

    if (!controlVisible) {
      log('INFO', 'Country selector not found on page. Continuing with default/current country.');
      return;
    }

    await countryControl.click({ timeout: TIMEOUTS.short }).catch(() => {});

    // After opening the dropdown, look for a search input or the direct
    // option matching the requested country.
    const searchInput = page.getByRole('textbox').first();
    const hasSearchInput = await searchInput
      .isVisible({ timeout: TIMEOUTS.short })
      .catch(() => false);

    if (hasSearchInput) {
      await searchInput.fill(country).catch(() => {});
      await page.waitForTimeout(500);
    }

    const countryOption = page.getByText(country, { exact: false }).first();
    const optionVisible = await countryOption
      .isVisible({ timeout: TIMEOUTS.short })
      .catch(() => false);

    if (optionVisible) {
      await countryOption.click({ timeout: TIMEOUTS.short }).catch(() => {});
      log('INFO', `Selected country: "${country}"`);
    } else {
      log('WARN', `Country option "${country}" not found in dropdown. Continuing without change.`);
    }
  } catch (err) {
    log('WARN', `selectCountry encountered a non-fatal issue: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 4. searchBrand(page, brand)
// ---------------------------------------------------------------------------

/**
 * Locates the Ad Library search box, clears any previous query, types
 * the given brand name, submits via Enter, and waits for search results
 * to begin rendering.
 *
 * @param {import('playwright').Page} page
 * @param {string} brand
 * @returns {Promise<boolean>} true if the search was submitted and results appeared, false otherwise
 */
async function searchBrand(page, brand) {
  if (!brand || typeof brand !== 'string') {
    log('WARN', 'searchBrand called without a valid brand value.');
    return false;
  }

  // Screenshot before searching
  await page.screenshot({
    path: `logs/before-search-${brand}.png`,
    fullPage: true,
  });

  return withRetry(
    async () => {

      const searchBox = page
        .getByRole('combobox', { name: /search/i })
        .or(page.getByPlaceholder(/search by keyword or advertiser/i))
        .or(page.locator('input[type="search"]'))
        .first();

      await searchBox.waitFor({
        state: 'visible',
        timeout: TIMEOUTS.selector,
      });

      await searchBox.click();

      await searchBox.fill('');

      await searchBox.type(brand, {
        delay: 40,
      });

      await searchBox.press('Enter');

      log('INFO', `Submitted search for "${brand}"`);

      await page.waitForSelector('[role="main"]', {
        timeout: TIMEOUTS.selector,
      });

      await page.waitForTimeout(3000);

      // Screenshot after successful search
      await page.screenshot({
        path: `logs/after-search-${brand}.png`,
        fullPage: true,
      });

      return true;
    },
    {
      label: `searchBrand("${brand}")`,
      fallback: false,
    }
  ).catch(async (err) => {

    // Save screenshot on failure
    await page.screenshot({
      path: `logs/error-${brand}.png`,
      fullPage: true,
    }).catch(() => {});

    // Save HTML on failure
    const html = await page.content().catch(() => '');
    if (html) {
      await require('fs').promises.writeFile(
        `logs/error-${brand}.html`,
        html,
        'utf8'
      ).catch(() => {});
    }

    log('ERROR', `Search failed for "${brand}": ${err.message}`);

    return false;
  });
}
// ---------------------------------------------------------------------------
// 5. waitForAds(page)
// ---------------------------------------------------------------------------

/**
 * Waits until ad cards are visible in the results region, retrying
 * several times with short delays to accommodate lazy loading and
 * network variability.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if ad cards became visible, false otherwise
 */
async function waitForAds(page) {
  return withRetry(
    async () => {
      // Ad cards are commonly rendered as elements with role="article",
      // or contain the "Library ID" text unique to Ad Library entries.
      const adCard = page
        .locator('div[role="article"]')
        .or(page.getByText(/Library ID/i))
        .first();

      await adCard.waitFor({ state: 'visible', timeout: TIMEOUTS.selector });

      log('INFO', 'Ad cards detected on the page.');
      return true;
    },
    { label: 'waitForAds', maxAttempts: RETRY.maxAttempts, delayMs: RETRY.delayMs, fallback: false }
  );
}

// ---------------------------------------------------------------------------
// 6. closePopups(page)
// ---------------------------------------------------------------------------

/**
 * Detects and dismisses common popups/modals (e.g. login prompts,
 * notification permission dialogs, promotional overlays) that may
 * obstruct interaction with the Ad Library. Never throws.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function closePopups(page) {
  const dismissTexts = ['Close', 'Not Now', 'Not now', 'Dismiss', 'No Thanks', 'Ã—', '✕'];

  try {
    for (const text of dismissTexts) {
      const dismissButton = page
        .getByRole('button', { name: text })
        .or(page.getByLabel(text))
        .first();

      const isVisible = await dismissButton
        .isVisible({ timeout: TIMEOUTS.short })
        .catch(() => false);

      if (isVisible) {
        await dismissButton.click({ timeout: TIMEOUTS.short }).catch(() => {});
        log('INFO', `Dismissed popup using control labeled "${text}"`);
        // Continue checking in case multiple popups are stacked.
      }
    }

    // Generic fallback: press Escape in case a modal is focused but has
    // no matching text-based control.
    await page.keyboard.press('Escape').catch(() => {});
  } catch (err) {
    // Swallow all errors — this function must never throw.
    log('WARN', `closePopups encountered a non-fatal issue: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  launch,
  acceptCookies,
  selectCountry,
  searchBrand,
  waitForAds,
  closePopups,
};
