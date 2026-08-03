/**
 * src/metaAdLibrary.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Meta Ad Library Navigation Module
 *
 * Responsible for, in pipeline order:
 * 1. Navigation (launch)
 * 2. Cookie/consent handling + popup dismissal
 * 3. Country selection
 * 4. Ad category / filter selection
 * 5. Brand search
 * 6. Waiting for ad results
 * 7. Scrolling until the results feed stabilizes
 *
 * Does NOT:
 * - Analyse ads
 * - Save reports
 * - Download media
 */

'use strict';

const fs = require('fs');


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AD_LIBRARY_URL =
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all';


const TIMEOUTS = {

  navigation: 45000,

  selector: 15000,

  short: 5000,

  stability: 3000,

};


const RETRY = {

  maxAttempts: 3,

  delayMs: 1500,

};



// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(level, message) {

  const timestamp = new Date().toISOString();

  const line =
    `[${timestamp}] [metaAdLibrary] [${level}] ${message}`;


  if (level === 'ERROR') {

    console.error(line);

  } else if (level === 'WARN') {

    console.warn(line);

  } else {

    console.log(line);

  }

}



// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function sleep(ms) {

  return new Promise(resolve => setTimeout(resolve, ms));

}



async function withRetry(fn, options = {}) {

  const {

    maxAttempts = RETRY.maxAttempts,

    delayMs = RETRY.delayMs,

    label = 'operation',

    fallback = false,

  } = options;



  let lastError;



  for (let attempt = 1; attempt <= maxAttempts; attempt++) {


    try {

      return await fn();


    } catch(err) {


      lastError = err;


      log(

        'WARN',

        `Attempt ${attempt}/${maxAttempts} failed for ${label}: ${err.message}`

      );



      if (attempt < maxAttempts) {

        await sleep(delayMs);

      }

    }

  }



  log(

    'ERROR',

    `All ${maxAttempts} attempts failed for ${label}: ${lastError?.message}`

  );



  return fallback;

}



// ---------------------------------------------------------------------------
// 1. launch(page)
// ---------------------------------------------------------------------------

async function launch(page) {


  try {


    await fs.promises.mkdir(

      'logs/screenshots',

      {
        recursive:true
      }

    );


    await fs.promises.mkdir(

      'logs/html',

      {
        recursive:true
      }

    );



    log(

      'INFO',

      `Navigating to Meta Ad Library: ${AD_LIBRARY_URL}`

    );



    await page.goto(

      AD_LIBRARY_URL,

      {

        waitUntil:'domcontentloaded',

        timeout:TIMEOUTS.navigation

      }

    );



    await page.waitForTimeout(

      TIMEOUTS.stability

    );



    await page.screenshot({

      path:'logs/meta-home.png',

      fullPage:true

    });



    await fs.promises.writeFile(

      'logs/html/meta-home.html',

      await page.content(),

      'utf8'

    );



    log(

      'INFO',

      `Meta Ad Library loaded. Current URL: ${page.url()}`

    );



  } catch(err) {


    log(

      'ERROR',

      `Failed to launch Meta Ad Library: ${err.message}`

    );


    throw err;

  }

}

// ---------------------------------------------------------------------------
// 1b. navigateToCompetitorUrl(page, competitorUrl)
// ---------------------------------------------------------------------------

async function navigateToCompetitorUrl(page, competitorUrl) {
  if (!competitorUrl || typeof competitorUrl !== 'string') {
    log(
      'ERROR',
      'navigateToCompetitorUrl called without a valid competitor URL'
    );

    return false;
  }

  try {
    log(
      'INFO',
      `Navigating directly to competitor Meta Ad Library URL: ${competitorUrl}`
    );

    await page.goto(
      competitorUrl,
      {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUTS.navigation
      }
    );

    await page.waitForTimeout(TIMEOUTS.stability);

    log(
      'INFO',
      `Competitor Meta Ad Library page loaded. Current URL: ${page.url()}`
    );

    await page.screenshot({
      path: `logs/screenshots/competitor-page-${Date.now()}.png`,
      fullPage: true
    }).catch(() => {});

    await fs.promises.writeFile(
      `logs/html/competitor-page-${Date.now()}.html`,
      await page.content(),
      'utf8'
    ).catch(() => {});

    return true;

  } catch (err) {
    log(
      'ERROR',
      `Failed to navigate to competitor Meta Ad Library URL: ${err.message}`
    );

    return false;
  }
}



// ---------------------------------------------------------------------------
// 2a. acceptCookies(page)
// ---------------------------------------------------------------------------

async function acceptCookies(page) {


  const candidateTexts = [

    'Allow all cookies',

    'Accept all',

    'Accept All',

    'Allow essential and optional cookies',

    'Only allow essential cookies',

  ];



  try {


    for(const text of candidateTexts){



      const button =

        page

          .getByRole(

            'button',

            {
              name:text
            }

          )

          .first();



      const visible =

        await button

          .isVisible({

            timeout:TIMEOUTS.short

          })

          .catch(()=>false);



      if(visible){


        await button

          .click({

            timeout:TIMEOUTS.short

          })

          .catch(()=>{});



        log(

          'INFO',

          `Dismissed cookie consent dialog using button labeled "${text}"`

        );



        return;

      }

    }



    log(

      'INFO',

      'No cookie consent dialog detected. Continuing.'

    );



  } catch(err) {


    log(

      'WARN',

      `acceptCookies encountered issue: ${err.message}`

    );

  }

}


// ---------------------------------------------------------------------------
// 2b. closePopups(page)
// ---------------------------------------------------------------------------
// Grouped immediately after acceptCookies since, per the required
// pipeline, "accept cookies" and "close popups" are one combined setup
// step (step 2) that runs before country/filter selection.
// ---------------------------------------------------------------------------

async function closePopups(page){


  const dismissTexts = [

    'Close',

    'Not Now',

    'Not now',

    'Dismiss',

    'No Thanks',

    '×',

    '✕'

  ];




  try{


    for(const text of dismissTexts){



      const button =

        page

          .getByRole(

            'button',

            {
              name:text
            }

          )

          .or(

            page.getByLabel(text)

          )

          .first();





      const visible =

        await button

          .isVisible({

            timeout:TIMEOUTS.short

          })

          .catch(()=>false);





      if(visible){



        await button

          .click({

            timeout:TIMEOUTS.short

          })

          .catch(()=>{});





        log(

          'INFO',

          `Dismissed popup using control labeled "${text}"`

        );


      }


    }





    await page.keyboard.press('Escape').catch(()=>{});





  }catch(err){



    log(

      'WARN',

      `closePopups encountered issue: ${err.message}`

    );


  }

}

// -----------------------------------------------------------------
// 2. NAVIGATE DIRECTLY TO COMPETITOR META AD LIBRARY URL
// -----------------------------------------------------------------
async function navigateToCompetitorUrl(page, competitorUrl) {
  if (!competitorUrl || typeof competitorUrl !== 'string') {
    log(
      'ERROR',
      'navigateToCompetitorUrl called without a valid competitor URL'
    );

    return false;
  }

  try {
    log(
      'INFO',
      `Navigating directly to competitor Meta Ad Library URL: ${competitorUrl}`
    );

    await page.goto(competitorUrl, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.navigation
    });

    await page.waitForTimeout(TIMEOUTS.stability);

    log(
      'INFO',
      `Competitor Meta Ad Library page loaded. Current URL: ${page.url()}`
    );

    await page.screenshot({
      path: `logs/screenshots/competitor-page-${Date.now()}.png`,
      fullPage: true
    }).catch(() => {});

    await fs.promises.writeFile(
      `logs/html/competitor-page-${Date.now()}.html`,
      await page.content(),
      'utf8'
    ).catch(() => {});

    return true;

  } catch (err) {
    log(
      'ERROR',
      `Failed to navigate to competitor Meta Ad Library URL: ${err.message}`
    );

    return false;
  }
}
// -----------------------------------------------------------------
// 3. ACCEPT COOKIES / CLOSE POPUPS
// -----------------------------------------------------------------

await metaAdLibrary.acceptCookies(page);

await metaAdLibrary.closePopups(page);

await page.waitForTimeout(1500);

// -----------------------------------------------------------------
// 4. WAIT FOR RESULTS
// -----------------------------------------------------------------

const adsFound = await metaAdLibrary.waitForAds(page);

if (!adsFound) {
  throw new Error(
    `No ad results could be confirmed for "${competitor}"`
  );
}
  
      // ---------------------------------------------------------------------
      // STEP 8: Allow results page to load
      // ---------------------------------------------------------------------

      await page.waitForTimeout(8000);

      await page.screenshot({
        path:
          `logs/screenshots/search-results-${Date.now()}.png`,
        fullPage: true
      }).catch(() => {});

      return true;

    },

    {
      label: `searchBrand("${brand}")`,
      maxAttempts: RETRY.maxAttempts,
      delayMs: RETRY.delayMs,
      fallback: false
    }

  );

}

// ---------------------------------------------------------------------------
// 6. waitForAds(page)
// ---------------------------------------------------------------------------

async function waitForAds(page) {

  return withRetry(

    async () => {

      log(
        'INFO',
        'Waiting for Meta Ad Library results...'
      );

      // Give Meta time to finish rendering / network requests.
      await page.waitForTimeout(5000);

      // ---------------------------------------------------------------------
      // Capture current page state
      // ---------------------------------------------------------------------

      let currentUrl = '';

      try {
        currentUrl = page.url();
      } catch (err) {
        currentUrl = 'UNKNOWN';
      }

      log(
        'INFO',
        `Current page URL after search: ${currentUrl}`
      );

      let bodyText = '';

      try {

        bodyText = await page.locator('body').innerText({
          timeout: TIMEOUTS.short
        });

      } catch (err) {

        log(
          'WARN',
          `Could not read page body: ${err.message}`
        );

      }

      // ---------------------------------------------------------------------
      // Log useful page text for debugging
      // ---------------------------------------------------------------------

      const compactText = bodyText
        .replace(/\s+/g, ' ')
        .trim();

      log(
        'INFO',
        `Page text length: ${compactText.length} characters`
      );

      log(
        'INFO',
        `Page text preview: ${compactText.substring(0, 1500)}`
      );

      // ---------------------------------------------------------------------
      // Look for explicit zero-result messages
      // ---------------------------------------------------------------------

      const noResultPatterns = [

        /no ads/i,
        /no active ads/i,
        /no results/i,
        /couldn't find/i,
        /could not find/i,
        /didn't find/i,
        /did not find/i,
        /no advertisements/i,
        /there are no/i

      ];

      for (const pattern of noResultPatterns) {

        if (pattern.test(compactText)) {

          log(
            'INFO',
            `Meta appears to have returned a zero-result state: ${pattern}`
          );

          return true;

        }

      }

      // ---------------------------------------------------------------------
      // Count potentially useful DOM signals
      // ---------------------------------------------------------------------

      const selectors = {

        articles:
          'div[role="article"]',

        links:
          'a[href*="/ads/library/"]',

        images:
          'img',

        videos:
          'video',

        buttons:
          'button',

        textboxes:
          'input, textarea, [contenteditable="true"]',

        adTestIds:
          '[data-testid*="ad"]',

        pagelets:
          '[data-pagelet*="AdLibrary"]'

      };

      const counts = {};

      for (const [name, selector] of Object.entries(selectors)) {

        try {

          counts[name] = await page.locator(selector).count();

        } catch (err) {

          counts[name] = 0;

        }

      }

      log(
        'INFO',
        `DOM diagnostic counts: ${JSON.stringify(counts)}`
      );

      // ---------------------------------------------------------------------
      // Look for Library ID text in the complete page
      // ---------------------------------------------------------------------

      const libraryIdMatches =
        compactText.match(/library\s*id/gi) || [];

      if (libraryIdMatches.length > 0) {

        log(
          'INFO',
          `Found ${libraryIdMatches.length} "Library ID" text occurrence(s).`
        );

        return true;

      }

      // ---------------------------------------------------------------------
      // Look for common Meta Ad Library result indicators
      // ---------------------------------------------------------------------

      const resultPatterns = [

        /active ads/i,
        /ads from/i,
        /advertiser/i,
        /started running/i,
        /see ad details/i,
        /sponsored/i

      ];

      let resultSignalCount = 0;

      for (const pattern of resultPatterns) {

        if (pattern.test(compactText)) {

          resultSignalCount += 1;

          log(
            'INFO',
            `Detected page result signal: ${pattern}`
          );

        }

      }

      // ---------------------------------------------------------------------
      // If multiple strong signals exist, allow parser to inspect page.
      // ---------------------------------------------------------------------

      if (
        resultSignalCount >= 2 &&
        (
          counts.articles > 0 ||
          counts.adTestIds > 0 ||
          counts.pagelets > 0
        )
      ) {

        log(
          'INFO',
          'Multiple Meta Ad Library result signals detected.'
        );

        return true;

      }

      // ---------------------------------------------------------------------
      // Save complete diagnostics before retrying
      // ---------------------------------------------------------------------

      const timestamp = Date.now();

      await page.screenshot({

        path:
          `logs/screenshots/wait-for-ads-${timestamp}.png`,

        fullPage: true

      }).catch(() => {});

      await fs.promises.writeFile(

        `logs/html/wait-for-ads-${timestamp}.html`,

        await page.content(),

        'utf8'

      ).catch(() => {});

      await fs.promises.writeFile(

        `logs/html/wait-for-ads-${timestamp}.txt`,

        compactText,

        'utf8'

      ).catch(() => {});

      // ---------------------------------------------------------------------
      // No confirmed result yet
      // ---------------------------------------------------------------------

      throw new Error(
        'Meta Ad Library results could not be confirmed from current page state'
      );

    },

    {

      label: 'waitForAds',

      maxAttempts: RETRY.maxAttempts,

      delayMs: RETRY.delayMs,

      fallback: false

    }

  );

}


// ---------------------------------------------------------------------------
// 7. scrollUntilStable(page)
// ---------------------------------------------------------------------------

async function scrollUntilStable(page) {
  try {
    log('INFO', 'Starting scroll until Meta Ad Library results stabilize...');

    let previousHeight = 0;
    let stableCount = 0;

    const maxScrolls = 30;
    const stableRequired = 3;

    for (let i = 0; i < maxScrolls; i++) {
      const currentHeight = await page.evaluate(() => {
        return Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );
      });

      if (currentHeight === previousHeight) {
        stableCount += 1;

        log(
          'INFO',
          `Page height stable (${stableCount}/${stableRequired})`
        );

        if (stableCount >= stableRequired) {
          log(
            'INFO',
            'Meta Ad Library results stabilized. Scrolling complete.'
          );

          return true;
        }
      } else {
        stableCount = 0;

        log(
          'INFO',
          `Scroll ${i + 1}/${maxScrolls}: page height ${currentHeight}px`
        );
      }

      previousHeight = currentHeight;

      await page.evaluate(() => {
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: 'instant'
        });
      });

      await page.waitForTimeout(1500);
    }

    log(
      'WARN',
      `Reached maximum scroll limit (${maxScrolls}) before full stabilization.`
    );

    return true;

  } catch (err) {
    log(
      'WARN',
      `scrollUntilStable encountered issue: ${err.message}`
    );

    return false;
  }
}


// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  launch,
  navigateToCompetitorUrl,
  acceptCookies,
  selectCountry,
  selectAdCategory,
  closePopups,
  searchBrand,
  waitForAds,
  scrollUntilStable
};
