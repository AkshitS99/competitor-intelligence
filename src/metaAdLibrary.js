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

    async()=>{


      log(

        'INFO',

        `Searching advertiser: ${brand}`

      );




      const searchSelectors = [


        // Meta current search patterns

        'input[aria-label*="Search"]',

        'input[aria-label*="search"]',

        'input[placeholder*="Search"]',

        'input[placeholder*="search"]',

        'input[type="search"]',

        'input[type="text"]',

        '[role="combobox"]'

      ];




      let searchInput = null;




      for(const selector of searchSelectors){


        try{


          const locator =

            page

              .locator(selector)

              .first();




          const visible =

            await locator

              .isVisible({

                timeout:3000

              })

              .catch(()=>false);




          if(visible){


            searchInput = locator;



            log(

              'INFO',

              `Search input found using selector: ${selector}`

            );



            break;

          }



        }catch{

          continue;

        }

      }




      if(!searchInput){



        const timestamp = Date.now();



        await page.screenshot({

          path:

            `logs/screenshots/search-input-not-found-${timestamp}.png`,

          fullPage:true

        }).catch(()=>{});




        await fs.promises.writeFile(

          `logs/html/search-input-not-found-${timestamp}.html`,

          await page.content(),

          'utf8'

        ).catch(()=>{});




        throw new Error(

          `Unable to locate Meta Ad Library search input for "${brand}"`

        );

      }





      await searchInput.click({

        timeout:TIMEOUTS.short

      });





      await searchInput.fill(

        brand,

        {

          timeout:TIMEOUTS.short

        }

      );




      log(

        'INFO',

        `Entered advertiser name: ${brand}`

      );




      await page.waitForTimeout(2000);




      await page.keyboard.press('Enter');




      log(

        'INFO',

        `Search submitted successfully for advertiser: ${brand}`

      );




      // Allow results page to render

      await page.waitForTimeout(8000);




      await page.screenshot({

        path:

          `logs/screenshots/search-results-${Date.now()}.png`,

        fullPage:true

      }).catch(()=>{});




      return true;



    },

    {


      label:`searchBrand("${brand}")`,

      maxAttempts:RETRY.maxAttempts,

      delayMs:RETRY.delayMs,

      fallback:false

    }

  );

}
// ---------------------------------------------------------------------------
// 5. waitForAds(page)
// ---------------------------------------------------------------------------

async function waitForAds(page) {


  return withRetry(

    async()=>{


      log(

        'INFO',

        'Waiting for Meta ad results...'

      );




      const adSelectors = [


        // Meta Ad Library containers

        '[data-pagelet*="AdLibrary"]',

        '[data-testid*="ad"]',

        '[data-testid*="Ad"]',

        'div[role="article"]',

        'div[aria-label*="Ad"]',

        'a[href*="/ads/library/"]',



        // Text indicators

        'text=/Library ID/i',

        'text=/Sponsored/i',

        'text=/Active ads/i',

        'text=/Ads from/i'

      ];




      let adFound = false;




      for(const selector of adSelectors){


        try{


          const locator =

            page

              .locator(selector)

              .first();




          const visible =

            await locator

              .isVisible({

                timeout:3000

              })

              .catch(()=>false);




          if(visible){



            log(

              'INFO',

              `Ad results detected using selector: ${selector}`

            );



            adFound = true;


            break;

          }



        }catch{


          continue;

        }

      }




      if(!adFound){



        const timestamp = Date.now();




        await page.screenshot({

          path:

            `logs/screenshots/no-ad-results-${timestamp}.png`,

          fullPage:true

        }).catch(()=>{});





        await fs.promises.writeFile(

          `logs/html/no-ad-results-${timestamp}.html`,

          await page.content(),

          'utf8'

        ).catch(()=>{});





        throw new Error(

          'No Meta ad result cards detected'

        );

      }




      return true;



    },

    {


      label:'waitForAds',

      maxAttempts:RETRY.maxAttempts,

      delayMs:RETRY.delayMs,

      fallback:false

    }

  );

}

// ---------------------------------------------------------------------------
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
