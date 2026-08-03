/**
 * src/metaAdLibrary.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Meta Ad Library Navigation Module
 *
 * Responsible for:
 * - Navigation
 * - Cookie/consent handling
 * - Country selection
 * - Brand search
 * - Waiting for ad results
 * - Popup dismissal
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
// 2. acceptCookies(page)
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
// 4. searchBrand(page, brand)
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
// 5. waitForAds(page)
// ---------------------------------------------------------------------------

async function waitForAds(page) {

  return withRetry(

    async () => {

      log(
        'INFO',
        'Waiting for Meta ad results...'
      );

      // ---------------------------------------------------------------------
      // IMPORTANT:
      //
      // Do NOT use:
      //
      // a[href*="/ads/library/"]
      //
      // as an ad detector.
      //
      // Meta uses /ads/library/ links throughout the page, including
      // navigation and non-ad elements. This previously caused:
      //
      // "Ad results detected"
      //
      // even when there were actually ZERO ads.
      // ---------------------------------------------------------------------

      const resultSignals = [

        // Strong textual signals
        page.getByText(/Library ID/i).first(),

        page.getByText(/Active ads/i).first(),

        page.getByText(/Ads from/i).first(),

        // Actual article-style result containers
        page.locator('div[role="article"]').first(),

        // Meta's common ad-card/test-id patterns
        page.locator('[data-testid*="ad-card"]').first(),

        page.locator('[data-testid*="AdCard"]').first(),

        page.locator('[data-pagelet*="AdLibrary"]').first()

      ];

      // ---------------------------------------------------------------------
      // First give the results page time to settle.
      // ---------------------------------------------------------------------

      await page.waitForTimeout(3000);

      // ---------------------------------------------------------------------
      // Check whether Meta is explicitly showing zero results.
      // ---------------------------------------------------------------------

      const zeroResultPatterns = [

        /no ads/i,
        /no active ads/i,
        /no results/i,
        /we couldn't find/i,
        /couldn't find any ads/i,
        /didn't find any ads/i

      ];

      let bodyText = '';

      try {

        bodyText = await page.locator('body').innerText({
          timeout: TIMEOUTS.short
        });

      } catch (err) {

        bodyText = '';

      }

      for (const pattern of zeroResultPatterns) {

        if (pattern.test(bodyText)) {

          log(
            'INFO',
            `Meta explicitly indicates no ads were found (${pattern}).`
          );

          return true;

        }

      }

      // ---------------------------------------------------------------------
      // Check for actual result signals
      // ---------------------------------------------------------------------

      let detectedSignal = null;

      for (const locator of resultSignals) {

        try {

          const visible = await locator
            .isVisible({
              timeout: 1500
            })
            .catch(() => false);

          if (visible) {

            detectedSignal = locator;

            break;

          }

        } catch (err) {

          continue;

        }

      }

      // ---------------------------------------------------------------------
      // Additional validation:
      //
      // We require an actual "Library ID" signal or multiple ad-like
      // containers before declaring that ads exist.
      // ---------------------------------------------------------------------

      let libraryIdCount = 0;

      try {

        libraryIdCount = await page
          .getByText(/Library ID/i)
          .count();

      } catch (err) {

        libraryIdCount = 0;

      }

      let articleCount = 0;

      try {

        articleCount = await page
          .locator('div[role="article"]')
          .count();

      } catch (err) {

        articleCount = 0;

      }

      let adCardCount = 0;

      try {

        adCardCount =
          await page
            .locator('[data-testid*="ad-card"], [data-testid*="AdCard"]')
            .count();

      } catch (err) {

        adCardCount = 0;

      }

      // ---------------------------------------------------------------------
      // Strongest confirmation:
      // Library ID exists.
      // ---------------------------------------------------------------------

      if (libraryIdCount > 0) {

        log(
          'INFO',
          `Ad results detected: ${libraryIdCount} Library ID signal(s).`
        );

        return true;

      }

      // ---------------------------------------------------------------------
      // Alternative confirmation:
      // Multiple actual article/ad-card containers.
      // ---------------------------------------------------------------------

      if (articleCount > 0 || adCardCount > 0) {

        log(
          'INFO',
          `Potential ad results detected (articles: ${articleCount}, ad cards: ${adCardCount}).`
        );

        return true;

      }

      // ---------------------------------------------------------------------
      // Generic signals alone are NOT enough.
      // ---------------------------------------------------------------------

      if (detectedSignal) {

        log(
          'INFO',
          'Meta results page detected, but no confirmed ad cards/Library IDs yet. Continuing to wait.'
        );

      }

      // ---------------------------------------------------------------------
      // No confirmed ads.
      // ---------------------------------------------------------------------

      const timestamp = Date.now();

      await page.screenshot({

        path:
          `logs/screenshots/no-ad-results-${timestamp}.png`,

        fullPage: true

      }).catch(() => {});

      await fs.promises.writeFile(

        `logs/html/no-ad-results-${timestamp}.html`,

        await page.content(),

        'utf8'

      ).catch(() => {});

      throw new Error(
        'No confirmed Meta ad result cards or Library IDs detected'
      );

    },

    {

      label: 'waitForAds',

      maxAttempts: RETRY.maxAttempts,

      delayMs: RETRY.delayMs,

      fallback: false

    }

  );

}// ---------------------------------------------------------------------------
// 6. scrollUntilStable(page)
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
// 6. closePopups(page)
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
// Exports
// ---------------------------------------------------------------------------

module.exports = {


 launch,
    acceptCookies,
    selectCountry,
    closePopups,
    searchBrand,
    waitForAds,
    scrollUntilStable


};
