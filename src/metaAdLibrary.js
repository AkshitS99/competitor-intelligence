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


// ---------------------------------------------------------------------------
// 3. selectCountry(page, country)
// ---------------------------------------------------------------------------

async function selectCountry(page, country) {


  if(!country || typeof country !== 'string') {


    log(

      'WARN',

      'selectCountry called without valid country. Skipping.'

    );


    return;

  }



  try {


    const countryControl =

      page

        .getByRole('combobox',{name:/country/i})

        .or(

          page.getByRole('button',{name:/country/i})

        )

        .first();




    const visible =

      await countryControl

        .isVisible({

          timeout:TIMEOUTS.short

        })

        .catch(()=>false);




    if(!visible){


      log(

        'INFO',

        'Country selector not found on page. Continuing with default/current country.'

      );


      return;

    }




    await countryControl.click().catch(()=>{});




    const searchInput =

      page.getByRole('textbox').first();




    if(

      await searchInput

        .isVisible({

          timeout:TIMEOUTS.short

        })

        .catch(()=>false)

    ){


      await searchInput

        .fill(country)

        .catch(()=>{});



      await page.waitForTimeout(500);

    }




    const option =

      page

        .getByText(country,{exact:false})

        .first();




    if(

      await option

        .isVisible({

          timeout:TIMEOUTS.short

        })

        .catch(()=>false)

    ){


      await option.click().catch(()=>{});



      log(

        'INFO',

        `Selected country: ${country}`

      );


    }



  } catch(err) {


    log(

      'WARN',

      `selectCountry encountered issue: ${err.message}`

    );


  }

}


// ---------------------------------------------------------------------------
// 4. setSearchFilters(page, country)
// ---------------------------------------------------------------------------
// Applies the two top-level Meta Ad Library filters in one step: Country
// and Ad Category ("All ads"). This is a broader, more resilient
// alternative/complement to selectCountry() above — it tries several
// role/aria-label candidate selectors for each filter control before
// giving up, and never throws (a filter that can't be located or
// selected is logged as a WARN and skipped, so the scraper can continue
// with Meta's default filter state rather than aborting the run).
// ---------------------------------------------------------------------------

async function setSearchFilters(page, country = 'India') {

  try {

    log(
      'INFO',
      `Setting Meta Ad Library filters: Country="${country}", Ad Category="All ads"`
    );

    // ---------------------------------------------------------
    // 1. COUNTRY
    // ---------------------------------------------------------

    const countryCandidates = [
      page.getByRole('button', { name: /country/i }),
      page.getByRole('combobox', { name: /country/i }),
      page.locator('[aria-label*="Country" i]').first(),
      page.locator('[aria-label*="country" i]').first()
    ];

    let countryControl = null;

    for (const candidate of countryCandidates) {

      if (
        await candidate.isVisible({ timeout: 1500 }).catch(() => false)
      ) {
        countryControl = candidate;
        break;
      }

    }

    if (countryControl) {

      await countryControl.click().catch(() => {});

      await page.waitForTimeout(500);

      // Try searching/selecting India
      const countrySearch = page.locator(
        'input[placeholder*="Search" i], input[aria-label*="Search" i]'
      ).first();

      if (
        await countrySearch.isVisible({ timeout: 1500 }).catch(() => false)
      ) {
        await countrySearch.fill(country).catch(() => {});
        await page.waitForTimeout(500);
      }

      const indiaOption = page
        .getByText(country, { exact: true })
        .first();

      if (
        await indiaOption.isVisible({ timeout: 3000 }).catch(() => false)
      ) {
        await indiaOption.click().catch(() => {});
        log('INFO', `Country successfully selected: ${country}`);
      } else {
        log('WARN', `Could not find country option: ${country}`);
      }

    } else {

      log('WARN', 'Country selector not found.');

    }

    await page.waitForTimeout(1000);

    // ---------------------------------------------------------
    // 2. AD CATEGORY
    // ---------------------------------------------------------

    const categoryCandidates = [
      page.getByRole('button', { name: /ad category/i }),
      page.getByRole('combobox', { name: /ad category/i }),
      page.locator('[aria-label*="Ad category" i]').first(),
      page.locator('[aria-label*="Category" i]').first()
    ];

    let categoryControl = null;

    for (const candidate of categoryCandidates) {

      if (
        await candidate.isVisible({ timeout: 1500 }).catch(() => false)
      ) {
        categoryControl = candidate;
        break;
      }

    }

    if (categoryControl) {

      await categoryControl.click().catch(() => {});

      await page.waitForTimeout(500);

      const allAdsOptionCandidates = [
        page.getByText('All ads', { exact: true }).first(),
        page.getByText('All Ads', { exact: true }).first(),
        page.getByText(/All ads/i).first()
      ];

      let allAdsOption = null;

      for (const candidate of allAdsOptionCandidates) {

        if (
          await candidate.isVisible({ timeout: 2000 }).catch(() => false)
        ) {
          allAdsOption = candidate;
          break;
        }

      }

      if (allAdsOption) {
        await allAdsOption.click().catch(() => {});
        log('INFO', 'Ad category successfully selected: All ads');
      } else {
        log('WARN', 'Could not find "All ads" option.');
      }

    } else {

      log('WARN', 'Ad Category selector not found.');

    }

    await page.waitForTimeout(1000);

    log('INFO', 'Meta Ad Library filters applied.');

    return true;

  } catch (err) {

    log(
      'WARN',
      `setSearchFilters encountered issue: ${err.message}`
    );

    return false;

  }

}


// ---------------------------------------------------------------------------
// 5. searchBrand(page, brand)
// ---------------------------------------------------------------------------

async function searchBrand(page, brand) {

  return withRetry(

    async () => {

      log(
        'INFO',
        `Searching advertiser: ${brand}`
      );

      // ---------------------------------------------------------------------
      // STEP 1: Look for an already-visible editable input
      // ---------------------------------------------------------------------

      const inputSelectors = [
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[aria-label*="Search"]',
        'input[aria-label*="search"]',
        'input[type="search"]',
        'input[type="text"]',
        'textarea[placeholder*="Search"]',
        'textarea[placeholder*="search"]'
      ];

      let searchInput = null;

      for (const selector of inputSelectors) {

        try {

          const locator = page.locator(selector).first();

          if (await locator.count() === 0) {
            continue;
          }

          const visible = await locator
            .isVisible({ timeout: 1500 })
            .catch(() => false);

          if (!visible) {
            continue;
          }

          const editable = await locator
            .isEditable({ timeout: 1500 })
            .catch(() => false);

          if (!editable) {
            continue;
          }

          searchInput = locator;

          log(
            'INFO',
            `Search input found using selector: ${selector}`
          );

          break;

        } catch (err) {
          continue;
        }
      }

      // ---------------------------------------------------------------------
      // STEP 2: If input isn't available, click Meta's combobox
      // ---------------------------------------------------------------------

      if (!searchInput) {

        try {

          const comboboxes = page.getByRole('combobox');

          const count = await comboboxes.count();

          log(
            'INFO',
            `Found ${count} combobox element(s) while locating search.`
          );

          for (let i = 0; i < count; i++) {

            const combobox = comboboxes.nth(i);

            const visible = await combobox
              .isVisible({ timeout: 1500 })
              .catch(() => false);

            if (!visible) {
              continue;
            }

            log(
              'INFO',
              `Clicking visible Meta combobox ${i + 1}/${count} to activate search.`
            );

            await combobox.click({
              timeout: TIMEOUTS.short
            }).catch(() => {});

            // Give Meta time to render the real input.
            await page.waitForTimeout(500);

            // ---------------------------------------------------------------
            // Search again for actual editable input
            // ---------------------------------------------------------------

            for (const selector of inputSelectors) {

              try {

                const locator = page.locator(selector).first();

                if (await locator.count() === 0) {
                  continue;
                }

                const visible = await locator
                  .isVisible({ timeout: 1000 })
                  .catch(() => false);

                if (!visible) {
                  continue;
                }

                const editable = await locator
                  .isEditable({ timeout: 1000 })
                  .catch(() => false);

                if (!editable) {
                  continue;
                }

                searchInput = locator;

                log(
                  'INFO',
                  `Search input became available after activating combobox: ${selector}`
                );

                break;

              } catch (err) {
                continue;
              }
            }

            if (searchInput) {
              break;
            }
          }

        } catch (err) {

          log(
            'WARN',
            `Failed to activate Meta search combobox: ${err.message}`
          );

        }
      }

      // ---------------------------------------------------------------------
      // STEP 3: Final fallback — search for contenteditable
      // ---------------------------------------------------------------------

      if (!searchInput) {

        try {

          const contentEditable = page
            .locator('[contenteditable="true"]')
            .first();

          const visible = await contentEditable
            .isVisible({ timeout: 1500 })
            .catch(() => false);

          if (visible) {

            searchInput = contentEditable;

            log(
              'INFO',
              'Search input found using contenteditable fallback.'
            );

          }

        } catch (err) {

          // Ignore and continue to diagnostics.

        }
      }

      // ---------------------------------------------------------------------
      // STEP 4: Give up only after all methods fail
      // ---------------------------------------------------------------------

      if (!searchInput) {

        const timestamp = Date.now();

        await page.screenshot({
          path:
            `logs/screenshots/search-input-not-found-${timestamp}.png`,
          fullPage: true
        }).catch(() => {});

        await fs.promises.writeFile(
          `logs/html/search-input-not-found-${timestamp}.html`,
          await page.content(),
          'utf8'
        ).catch(() => {});

        throw new Error(
          `Unable to locate an editable Meta Ad Library search input for "${brand}"`
        );
      }

      // ---------------------------------------------------------------------
      // STEP 5: Clear existing search
      // ---------------------------------------------------------------------

      await searchInput.click({
        timeout: TIMEOUTS.short
      });

      await searchInput.fill('', {
        timeout: TIMEOUTS.short
      });

      // ---------------------------------------------------------------------
      // STEP 6: Enter competitor name
      // ---------------------------------------------------------------------

      await searchInput.fill(
        brand,
        {
          timeout: TIMEOUTS.short
        }
      );

      log(
        'INFO',
        `Entered advertiser name: ${brand}`
      );

      // ---------------------------------------------------------------------
      // STEP 7: Submit search
      // ---------------------------------------------------------------------

      await page.waitForTimeout(1000);

      await searchInput.press('Enter').catch(async () => {

        await page.keyboard.press('Enter');

      });

      log(
        'INFO',
        `Search submitted successfully for advertiser: ${brand}`
      );

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
  acceptCookies,
  selectCountry,
  setSearchFilters,
  closePopups,
  searchBrand,
  waitForAds,
  scrollUntilStable
};
