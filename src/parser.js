/**
 * src/parser.js
 * Enterprise Competitor Intelligence Platform
 * ---
 * Meta Ad Library Parser Module
 *
 * Sole responsibility: extract structured ad data from the CURRENT page
 * state, after navigation, cookie handling, country selection, brand
 * search, ad-visibility waiting, AND scrolling (via
 * metaAdLibrary.scrollUntilStable) have already occurred.
 *
 * This module MUST NOT:
 *   - Navigate or scroll the page
 *   - Click, type, or otherwise interact with the DOM
 *   - Save files, screenshots, reports, or downloaded media
 *     (it only computes the PATH a screenshot would be saved to —
 *     actual capture is the caller's responsibility)
 *
 * Design notes:
 *   - No rawHtml is captured or stored — it bloats output for little
 *     analytic value; a screenshot path is far more useful downstream.
 *   - Every field defaults to null (or [] for list fields) if it
 *     cannot be confidently extracted. A malformed card is skipped, not
 *     fatal.
 *   - Extracted text is whitespace-normalized.
 *   - Image/video extraction accounts for lazy-loading: many cards only
 *     populate data-src/data-image/srcset until scrolled into view, so
 *     naive img.src reads miss a lot of creatives.
 *   - CTA detection prefers reading interactive [role="button"]/<button>
 *     elements directly, rather than scanning the entire card's text,
 *     which can false-positive on CTA keywords appearing in ad copy.
 *   - Headline detection scores bold candidates by length band (15–80
 *     chars), vertical position relative to the media block, and
 *     proximity to the CTA button — rather than simply picking the
 *     shortest bold element, which was prone to returning "Sponsored",
 *     "Active", the CTA label, or the page name.
 *   - Primary text extraction excludes known noise blocks (Library ID
 *     section, CTA labels, "Sponsored", disclaimers, legal boilerplate,
 *     platform labels) before picking the longest remaining candidate.
 *   - Destination URL checks anchor hrefs (with Meta redirect decoding),
 *     plus `data-lynx-uri` and `data-store` attributes, since newer
 *     Meta layouts sometimes only expose the real landing URL inside
 *     those attributes rather than a plain href.
 *   - Carousel detection treats Next/Previous ARIA navigation controls
 *     as the primary signal, since many carousels lazy-load only a
 *     single image and would otherwise be missed by an image-count check.
 *   - Ad type detection also covers Collection, Playable, Lead Form, and
 *     Instant Experience formats, in addition to Image/Video/Carousel/Reel.
 *     These are text/aria-label heuristics — Meta doesn't always expose
 *     ad format explicitly in card markup, so these are best-effort.
 *   - Additional competitor-intelligence metadata (page transparency link,
 *     declared languages, reach estimate, currency) is extracted when
 *     present in the card. In practice Meta usually only renders these
 *     on a per-ad detail/transparency view rather than inline in the
 *     main results list, so expect these fields to be null more often
 *     than not at this DOM layer — see the network-capture note below.
 *   - Confidence score is a weighted heuristic (not equal-weighted),
 *     reflecting that some fields (Library ID, advertiser, primary text)
 *     are more diagnostic of a "good" extraction than others.
 *   - Results are deduplicated by libraryId, falling back to a
 *     contentHash (advertiser + headline + primaryText).
 *   - Returns { ads, stats } so callers get visibility into extraction
 *     quality (cards seen, duplicates, failures, timing).
 *
 * Known limitation (by design, out of scope for this module):
 *   All of the above is DOM-based, so it's subject to lazy loading,
 *   virtualization, and frontend markup changes — and several of the
 *   newer metadata fields (reach estimate, currency, exact country) are
 *   frequently just not present in the DOM at all outside the ad detail
 *   panel. A more resilient production setup pairs this module with a
 *   network-layer capture (e.g. `page.on('response', ...)` on the
 *   caller side, filtering for graphql / ads_archive responses) as the
 *   primary source of truth for IDs, pagination, and metadata, using
 *   this DOM extraction as a secondary source for rendered text and
 *   button labels. That capture involves listening to page traffic,
 *   which is a caller/orchestration concern, not this module's — this
 *   module strictly parses whatever state the page is already in.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Internal utility: lightweight logger (console only — no file I/O here)
// ---------------------------------------------------------------------------

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [parser] [${level}] ${message}`;

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Internal utility: filesystem-safe slug for screenshot path segments
// ---------------------------------------------------------------------------

/**
 * @param {string} value
 * @returns {string}
 */
function toSafeSlug(value) {
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
// Internal utility: content hash for cross-campaign duplicate detection
// ---------------------------------------------------------------------------

/**
 * Builds a stable SHA-256 hash from creative content (advertiser +
 * headline + primaryText). Two ads with identical creative content —
 * even across different campaigns/libraryIds — hash the same, which is
 * useful for spotting reused creatives.
 *
 * @param {object} ad
 * @returns {string|null}
 */
function buildContentHash(ad) {
  const basis = [ad.advertiser || '', ad.headline || '', ad.primaryText || '']
    .join('||')
    .trim()
    .toLowerCase();

  if (!basis) return null;

  return crypto.createHash('sha256').update(basis).digest('hex');
}

// ---------------------------------------------------------------------------
// Internal utility: dedup key + dedup pass
// ---------------------------------------------------------------------------

/**
 * @param {object} ad
 * @returns {string}
 */
function buildDedupKey(ad) {
  if (ad.libraryId) return `libraryId:${ad.libraryId}`;
  if (ad.contentHash) return `contentHash:${ad.contentHash}`;
  return `fallback:${Math.random()}`; // last resort — never collides, never dedups
}

/**
 * @param {object[]} ads
 * @returns {{ deduped: object[], duplicatesRemoved: number }}
 */
function deduplicateAds(ads) {
  const seen = new Set();
  const deduped = [];

  for (const ad of ads) {
    const key = buildDedupKey(ad);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ad);
    }
  }

  return { deduped, duplicatesRemoved: ads.length - deduped.length };
}

// ---------------------------------------------------------------------------
// Internal utility: language detection heuristic
// ---------------------------------------------------------------------------

/**
 * Heuristic script-based classifier (Devanagari vs Latin). Not a full
 * language model — sufficient for the India-focused competitor set this
 * platform targets.
 *
 * @param {string} text
 * @returns {'English'|'Hindi'|'Mixed'|null}
 */
function detectLanguage(text) {
  if (!text || text.trim().length === 0) return null;

  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);

  if (hasDevanagari && hasLatin) return 'Mixed';
  if (hasDevanagari) return 'Hindi';
  if (hasLatin) return 'English';
  return null;
}

// ---------------------------------------------------------------------------
// Internal utility: weighted extraction confidence score
// ---------------------------------------------------------------------------

// Weights reflect how diagnostic each field is of a "good" extraction,
// not just whether it happened to be non-empty. These are a starting
// heuristic — worth revisiting once labeled data exists on which fields
// actually predict usable records.
const CONFIDENCE_WEIGHTS = {
  libraryId: 0.3,
  advertiser: 0.2,
  primaryText: 0.2,
  destinationUrl: 0.1,
  headline: 0.1,
  callToAction: 0.05,
  media: 0.05,
};

/**
 * Weighted confidence score (0–1) based on which key fields were
 * successfully extracted. A heuristic triage signal, not a statistical
 * guarantee.
 *
 * @param {object} ad
 * @returns {number}
 */
function computeConfidence(ad) {
  let score = 0;

  if (ad.libraryId) score += CONFIDENCE_WEIGHTS.libraryId;
  if (ad.advertiser) score += CONFIDENCE_WEIGHTS.advertiser;
  if (ad.primaryText) score += CONFIDENCE_WEIGHTS.primaryText;
  if (ad.destinationUrl) score += CONFIDENCE_WEIGHTS.destinationUrl;
  if (ad.headline) score += CONFIDENCE_WEIGHTS.headline;
  if (ad.callToAction) score += CONFIDENCE_WEIGHTS.callToAction;

  const hasMedia =
    (ad.mediaUrls && ad.mediaUrls.images && ad.mediaUrls.images.length > 0) ||
    (ad.mediaUrls && ad.mediaUrls.videos && ad.mediaUrls.videos.length > 0);
  if (hasMedia) score += CONFIDENCE_WEIGHTS.media;

  return Math.round(score * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main export: extractAds
// ---------------------------------------------------------------------------

/**
 * Extracts all currently visible ad cards from the page for the given
 * competitor. Assumes navigation, search, ad-visibility waiting, AND
 * scrolling have already occurred. Never throws — resolves to
 * { ads: [], stats } on total failure.
 *
 * @param {import('playwright').Page} page
 * @param {string} competitor
 * @returns {Promise<{
 *   ads: object[],
 *   stats: {
 *     cardsSeen: number,
 *     duplicatesRemoved: number,
 *     failedCards: number,
 *     timeTakenMs: number
 *   }
 * }>}
 */
async function extractAds(page, competitor) {
  const startTime = Date.now();
  const emptyStats = { cardsSeen: 0, duplicatesRemoved: 0, failedCards: 0, timeTakenMs: 0 };

  if (!page) {
    log('ERROR', 'extractAds called without a valid page instance.');
    return { ads: [], stats: emptyStats };
  }

  const competitorLabel = typeof competitor === 'string' ? competitor : 'UNKNOWN';

  try {
    log('INFO', `Starting ad extraction for competitor: "${competitorLabel}"`);

    let pageUrl = null;
    try {
      pageUrl = page.url();
    } catch (urlErr) {
      log('WARN', `Could not read current page URL: ${urlErr.message}`);
    }

    // ---- Browser-context extraction ----
    const evalResult = await page.evaluate((competitorArg) => {
      // -- text normalization --
      function extractText(el) {
        if (!el) return null;
        const raw = el.innerText || el.textContent || '';
        const normalized = raw.replace(/\s+/g, ' ').trim();
        return normalized.length > 0 ? normalized : null;
      }

      function queryFirst(root, selectors) {
        for (const selector of selectors) {
          try {
            const el = root.querySelector(selector);
            if (el) return el;
          } catch (e) {
            /* invalid selector for this DOM — skip */
          }
        }
        return null;
      }

      // -- ad card discovery (multi-strategy fallback) --
      function findAdCards() {
        const strategies = [
          () => Array.from(document.querySelectorAll('div[role="article"]')),
          () => Array.from(document.querySelectorAll('[data-testid="ad-library-card"]')),
          () => {
            const feed = document.querySelector('[role="feed"]');
            return feed ? Array.from(feed.children) : [];
          },
          () =>
            Array.from(document.querySelectorAll('div')).filter(
              (el) => el.innerText && /Library ID/i.test(el.innerText)
            ),
        ];

        for (const strategy of strategies) {
          try {
            const found = strategy();
            if (Array.isArray(found) && found.length > 0) return found;
          } catch (e) {
            /* strategy failed — try next */
          }
        }
        return [];
      }

      // Tolerates "Library ID", "Ad Library ID", missing colon, and a
      // line break between the label and the digits. `\s` already
      // matches newlines in JS regex, but `\n` is kept explicit in the
      // character class for clarity of intent.
      function extractLibraryId(cardText) {
        if (!cardText) return null;
        const match = cardText.match(/(?:Ad\s+)?Library\s+ID[:\s\n]*([0-9]{6,})/i);
        return match ? match[1] : null;
      }

      function extractAdStatus(cardText) {
        if (!cardText) return null;
        if (/\bActive\b/i.test(cardText)) return 'Active';
        if (/\bInactive\b/i.test(cardText)) return 'Inactive';
        return null;
      }

      function extractStartDate(cardText) {
        if (!cardText) return null;
        const match = cardText.match(/Started running on ([A-Za-z]+ \d{1,2}, \d{4})/i);
        return match ? match[1] : null;
      }

      function extractPlatforms(card, cardText) {
        const knownPlatforms = ['Facebook', 'Instagram', 'Messenger', 'Audience Network'];
        const found = new Set();

        card.querySelectorAll('[aria-label], img[alt]').forEach((el) => {
          const label = el.getAttribute('aria-label') || el.getAttribute('alt') || '';
          knownPlatforms.forEach((p) => {
            if (label.toLowerCase().includes(p.toLowerCase())) found.add(p);
          });
        });

        if (found.size === 0 && cardText) {
          knownPlatforms.forEach((p) => {
            if (cardText.toLowerCase().includes(p.toLowerCase())) found.add(p);
          });
        }

        return Array.from(found);
      }

      // Advertiser selectors, most specific/reliable first. Broad
      // catch-alls (div[dir="auto"]) last since they also match ordinary
      // ad copy. Added h3, div[role="heading"], [aria-level] to cover
      // newer layouts that mark up the advertiser name as a heading.
      function extractAdvertiser(card) {
        const candidate = queryFirst(card, [
          'a[role="link"] span',
          'h2',
          'h3',
          '[role="heading"]',
          '[aria-level]',
          'a[role="link"]',
          'strong',
          'div[dir="auto"] span',
          'div[dir="auto"]',
        ]);
        return extractText(candidate);
      }

      // Noise patterns to exclude when picking primary text / headline
      // candidates. Longest-string-wins previously had no way to avoid
      // picking up disclaimers, "Sponsored", legal boilerplate, or
      // "See ad details".
      const NOISE_PATTERNS = [
        /^sponsored$/i,
        /library\s+id/i,
        /started running on/i,
        /see ad details/i,
        /see summary/i,
        /^active$/i,
        /^inactive$/i,
        /facebook|instagram|messenger|audience network/i,
        /privacy/i,
        /\bterms\b/i,
        /\bconditions\b/i,
        /copyright/i,
        /^learn more$/i,
      ];

      function isNoiseText(text, ctaLabel) {
        if (!text) return true;
        if (ctaLabel && text === ctaLabel) return true;
        return NOISE_PATTERNS.some((pattern) => pattern.test(text));
      }

      // Primary text excludes CTA/disclaimer/legal/platform/Library ID
      // noise before choosing the longest remaining candidate, instead
      // of naively taking the longest text in the card (which could
      // otherwise surface a "Terms and conditions apply..." disclaimer).
      function extractPrimaryText(card, ctaLabel) {
        const blocks = Array.from(card.querySelectorAll('span, div'))
          .map((el) => extractText(el))
          .filter((t) => t && t.length > 30 && !isNoiseText(t, ctaLabel));
        if (blocks.length === 0) return null;
        return blocks.sort((a, b) => b.length - a.length)[0];
      }

      // Headline detection: gather bold candidates (via computed
      // font-weight, not inline style — bold styling is frequently
      // applied via CSS classes), then SCORE them instead of just
      // taking the shortest one. Scoring considers:
      //   - length band (15–80 chars is the headline sweet spot)
      //   - vertical position below the media block
      //   - vertical proximity to (and above) the CTA button
      // This avoids picking up "Sponsored", "Active", the CTA label
      // itself, or the page name, which the shortest-bold heuristic
      // was prone to.
      function extractHeadline(card, primaryText, ctaLabel, ctaEl) {
        let mediaBottom = null;
        const mediaEls = Array.from(card.querySelectorAll('img, video'));
        if (mediaEls.length > 0) {
          try {
            mediaBottom = Math.max(
              ...mediaEls.map((el) => el.getBoundingClientRect().bottom)
            );
          } catch (e) {
            mediaBottom = null;
          }
        }

        let ctaTop = null;
        if (ctaEl) {
          try {
            ctaTop = ctaEl.getBoundingClientRect().top;
          } catch (e) {
            ctaTop = null;
          }
        }

        const candidates = Array.from(card.querySelectorAll('div, span, h2, h3, strong'))
          .filter((el) => {
            try {
              const weight = window.getComputedStyle(el).fontWeight;
              const numericWeight = parseInt(weight, 10);
              return (!Number.isNaN(numericWeight) && numericWeight >= 600) || weight === 'bold';
            } catch (e) {
              return false;
            }
          })
          .map((el) => {
            const text = extractText(el);
            if (!text || text === primaryText || isNoiseText(text, ctaLabel)) return null;
            let rectTop = null;
            try {
              rectTop = el.getBoundingClientRect().top;
            } catch (e) {
              rectTop = null;
            }
            return { text, rectTop };
          })
          .filter(Boolean);

        if (candidates.length === 0) return null;

        function scoreCandidate(c) {
          let score = 0;
          const len = c.text.length;

          // Length band: headlines are typically 15–80 characters.
          if (len >= 15 && len <= 80) {
            score += 3;
          } else if (len < 15) {
            score -= (15 - len) * 0.1;
          } else {
            score -= (len - 80) * 0.05;
          }

          // Below media block.
          if (mediaBottom !== null && c.rectTop !== null) {
            score += c.rectTop >= mediaBottom ? 2 : -1;
          }

          // Above and near the CTA — headlines sit above the CTA button,
          // and the closer (within reason), the more likely it's the
          // headline rather than unrelated copy further up the card.
          if (ctaTop !== null && c.rectTop !== null) {
            if (c.rectTop <= ctaTop) {
              const distance = ctaTop - c.rectTop;
              score += Math.max(0, 2 - distance / 200);
            } else {
              score -= 1;
            }
          }

          return score;
        }

        candidates.forEach((c) => {
          c.score = scoreCandidate(c);
        });
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].text;
      }

      function extractDescription(card, headline, primaryText, ctaLabel) {
        const blocks = Array.from(card.querySelectorAll('span, div'))
          .map((el) => extractText(el))
          .filter(
            (t) =>
              t &&
              t.length > 0 &&
              t.length < 150 &&
              t !== headline &&
              t !== primaryText &&
              !isNoiseText(t, ctaLabel)
          );
        return blocks.length > 0 ? blocks[0] : null;
      }

      // CTA detection reads [role="button"]/<button> elements directly
      // instead of scanning the entire card's text, which can
      // false-positive when a CTA keyword happens to appear in ad copy.
      // Returns both the label and the element itself, since the
      // element's position is used by headline scoring above.
      function extractCallToAction(card) {
        const knownCtaLabels = [
          'Shop Now', 'Learn More', 'Sign Up', 'Download', 'Get Offer',
          'Book Now', 'Contact Us', 'Apply Now', 'Subscribe', 'Watch More',
          'Get Quote', 'Send Message', 'Order Now', 'Get Directions', 'Call Now',
        ];

        const buttonEls = Array.from(card.querySelectorAll('[role="button"], button'));

        // Primary: exact match against known CTA labels on real buttons.
        for (const btn of buttonEls) {
          const label = extractText(btn);
          if (!label) continue;

          const matched = knownCtaLabels.find(
            (known) => label.toLowerCase() === known.toLowerCase()
          );
          if (matched) return { label: matched, el: btn };
        }

        // Secondary: any short button-like label, even if it doesn't match
        // our known list exactly (Meta occasionally varies CTA wording).
        for (const btn of buttonEls) {
          const label = extractText(btn);
          if (label && label.length > 0 && label.length < 30) {
            return { label, el: btn };
          }
        }

        // Last resort: scan full card text, in case this render doesn't
        // use role="button" markup for the CTA at all. No element
        // reference available in this fallback path.
        const cardText = extractText(card) || '';
        for (const known of knownCtaLabels) {
          if (cardText.includes(known)) return { label: known, el: null };
        }

        return { label: null, el: null };
      }

      function extractLinks(card) {
        return Array.from(card.querySelectorAll('a[href]'))
          .map((a) => a.getAttribute('href'))
          .filter(Boolean);
      }

      // -- decode Meta's l.facebook.com/l.php?u=<encoded> redirect wrapper --
      function decodeMetaRedirect(href) {
        try {
          const url = new URL(href, window.location.origin);
          const isRedirect =
            url.hostname.includes('l.facebook.com') || url.pathname.includes('l.php');

          if (isRedirect && url.searchParams.has('u')) {
            return decodeURIComponent(url.searchParams.get('u'));
          }
          return href;
        } catch (e) {
          return href;
        }
      }

      // Recursively searches a parsed data-store JSON blob for a URL-like
      // string, preferring keys whose name suggests a link (url/link/uri).
      // Depth-capped to avoid runaway traversal on deeply nested objects.
      function findUrlInObject(obj, depth) {
        if (depth > 4 || obj === null || obj === undefined) return null;

        if (typeof obj === 'string') {
          return /^https?:\/\//i.test(obj) ? obj : null;
        }

        if (typeof obj !== 'object') return null;

        const keys = Object.keys(obj);

        for (const key of keys) {
          const val = obj[key];
          if (/url|link|uri/i.test(key) && typeof val === 'string' && /^https?:\/\//i.test(val)) {
            return val;
          }
        }

        for (const key of keys) {
          const found = findUrlInObject(obj[key], depth + 1);
          if (found) return found;
        }

        return null;
      }

      // Checks anchor hrefs first, then falls back to `data-lynx-uri` and
      // `data-store` attributes — newer Meta layouts sometimes only expose
      // the real landing URL inside those rather than a plain href.
      function extractDestinationUrl(card) {
        const lynxEl = card.querySelector('[data-lynx-uri]');
        if (lynxEl) {
          const uri = lynxEl.getAttribute('data-lynx-uri');
          if (uri) return decodeMetaRedirect(uri);
        }

        const storeEls = Array.from(card.querySelectorAll('[data-store]'));
        for (const el of storeEls) {
          const raw = el.getAttribute('data-store');
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            const found = findUrlInObject(parsed, 0);
            if (found) return decodeMetaRedirect(found);
          } catch (e) {
            /* not JSON or malformed — skip */
          }
        }

        const links = extractLinks(card);
        const external = links.map(decodeMetaRedirect).find((href) => {
          try {
            return (
              href.startsWith('http') &&
              !href.includes('facebook.com') &&
              !href.includes('fb.com') &&
              !href.includes('instagram.com')
            );
          } catch (e) {
            return false;
          }
        });
        return external || null;
      }

      // -- account for lazy-loaded images (data-src/data-image/srcset) --
      function extractImageUrls(card) {
        const urls = Array.from(card.querySelectorAll('img')).map((img) => {
          const candidate =
            img.currentSrc ||
            img.getAttribute('src') ||
            img.dataset.src ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-image') ||
            null;

          if (candidate) return candidate;

          const srcset = img.getAttribute('srcset');
          if (srcset) {
            const firstUrl = srcset.split(',')[0].trim().split(' ')[0];
            return firstUrl || null;
          }

          return null;
        });

        return Array.from(new Set(urls.filter(Boolean)));
      }

      // -- account for lazy-loaded videos (data-src fallback) --
      function extractVideoUrls(card) {
        const fromVideoTags = Array.from(card.querySelectorAll('video')).map((v) => {
          return (
            v.currentSrc ||
            v.getAttribute('src') ||
            v.dataset.src ||
            v.getAttribute('data-src') ||
            null
          );
        });

        const fromSourceTags = Array.from(card.querySelectorAll('video source')).map((s) => {
          return s.getAttribute('src') || s.dataset.src || s.getAttribute('data-src') || null;
        });

        return Array.from(new Set([...fromVideoTags, ...fromSourceTags].filter(Boolean)));
      }

      // Carousel detection treats Next/Previous ARIA controls as the
      // PRIMARY signal (many carousels lazy-load only one image at a
      // time, so an image-count check alone misses them). Image count
      // remains a fallback signal only. Also detects Collection,
      // Playable, Lead Form, and Instant Experience formats via
      // text/aria-label keyword heuristics — Meta doesn't consistently
      // expose ad format in card markup, so these are best-effort and
      // may under-detect relative to the network-layer approach.
      function extractAdType(card, cardText, imageUrls, videoUrls) {
        const ariaLabels = Array.from(card.querySelectorAll('[aria-label]')).map(
          (el) => el.getAttribute('aria-label') || ''
        );
        const matchesAny = (pattern) =>
          pattern.test(cardText) || ariaLabels.some((label) => pattern.test(label));

        const isReel = matchesAny(/\breel\b/i);
        if (isReel && videoUrls.length > 0) return 'Reel';

        if (matchesAny(/playable/i)) return 'Playable';
        if (matchesAny(/instant experience/i)) return 'Instant Experience';
        if (matchesAny(/\bcollection\b/i) && imageUrls.length > 0) return 'Collection';
        if (matchesAny(/lead form|instant form/i)) return 'Lead Form';

        const hasNext = card.querySelectorAll('[role="button"][aria-label*="Next" i]').length > 0;
        const hasPrevious =
          card.querySelectorAll('[role="button"][aria-label*="Previous" i]').length > 0;
        const hasCarouselNav = hasNext || hasPrevious;

        if (hasCarouselNav && videoUrls.length === 0) return 'Carousel';
        if (!hasCarouselNav && imageUrls.length > 1 && videoUrls.length === 0) return 'Carousel';

        if (videoUrls.length > 0) return 'Video';
        if (imageUrls.length > 0) return 'Image';
        return 'Unknown';
      }

      // Best-effort competitor-intelligence metadata. Meta typically only
      // surfaces these on a per-ad detail/transparency view rather than
      // inline in the main results list, so most of these will be null
      // for the majority of cards — that's expected, not a bug. Reliable,
      // consistent capture of this metadata needs the network-layer
      // approach noted in the module header.
      function extractPageTransparencyUrl(card) {
        const el = card.querySelector('a[href*="transparency"]');
        return el ? el.getAttribute('href') : null;
      }

      function extractDeclaredLanguages(cardText) {
        if (!cardText) return null;
        const match = cardText.match(/Languages?:?\s*([A-Za-z, ]{2,60})/i);
        return match ? match[1].trim() : null;
      }

      function extractReachEstimate(cardText) {
        if (!cardText) return null;
        const match = cardText.match(/(?:Reach|Estimated audience size):?\s*([0-9,.\-KMkm]+)/i);
        return match ? match[1].trim() : null;
      }

      function extractCurrency(cardText) {
        if (!cardText) return null;
        const match = cardText.match(/Currency:?\s*([A-Z]{3})\b/);
        return match ? match[1] : null;
      }

      function extractCountry(cardText) {
        if (!cardText) return null;
        const match = cardText.match(/(?:Country|Audience location):?\s*([A-Za-z ]{2,40})/i);
        return match ? match[1].trim() : null;
      }

      // -- single-card extraction --
      function extractSingleCard(card, competitorName) {
        const cardText = extractText(card) || '';

        const cta = extractCallToAction(card);
        const primaryText = extractPrimaryText(card, cta.label);
        const headline = extractHeadline(card, primaryText, cta.label, cta.el);
        const description = extractDescription(card, headline, primaryText, cta.label);
        const imageUrls = extractImageUrls(card);
        const videoUrls = extractVideoUrls(card);

        return {
          competitor: competitorName,
          advertiser: extractAdvertiser(card),
          libraryId: extractLibraryId(cardText),
          adStatus: extractAdStatus(cardText),
          startDate: extractStartDate(cardText),
          platforms: extractPlatforms(card, cardText),
          primaryText,
          headline,
          description,
          callToAction: cta.label,
          destinationUrl: extractDestinationUrl(card),
          adType: extractAdType(card, cardText, imageUrls, videoUrls),
          mediaUrls: { images: imageUrls, videos: videoUrls },
          pageTransparencyUrl: extractPageTransparencyUrl(card),
          declaredLanguages: extractDeclaredLanguages(cardText),
          reachEstimate: extractReachEstimate(cardText),
          currency: extractCurrency(cardText),
          country: extractCountry(cardText),
        };
      }

      // -- orchestration inside evaluate --
      const cards = findAdCards();
      const cardsSeen = cards.length;
      const extracted = [];
      let failedCards = 0;
      let skippedNoSignal = 0;

      for (const card of cards) {
        try {
          const record = extractSingleCard(card, competitorArg);

          const hasAnySignal =
            record.advertiser ||
            record.libraryId ||
            record.primaryText ||
            record.headline ||
            record.destinationUrl ||
            record.mediaUrls.images.length > 0 ||
            record.mediaUrls.videos.length > 0;

          if (hasAnySignal) {
            extracted.push(record);
          } else {
            skippedNoSignal += 1;
          }
        } catch (cardErr) {
          failedCards += 1;
        }
      }

      return { cardsSeen, failedCards, skippedNoSignal, ads: extracted };
    }, competitorLabel);

    const { cardsSeen, failedCards, skippedNoSignal, ads } = evalResult || {
      cardsSeen: 0,
      failedCards: 0,
      skippedNoSignal: 0,
      ads: [],
    };

    log(
      'INFO',
      `Found ${cardsSeen} candidate card(s) for "${competitorLabel}" ` +
        `(skipped ${skippedNoSignal} with no signal, ${failedCards} failed).`
    );

    // ---- Node-side enrichment (outside evaluate) ----
    const extractedAt = new Date().toISOString();
    const competitorSlug = toSafeSlug(competitorLabel);

    const enrichedAds = ads.map((ad) => {
      const primaryTextLength = ad.primaryText ? ad.primaryText.length : 0;
      const headlineLength = ad.headline ? ad.headline.length : 0;
      const contentHash = buildContentHash(ad);

      // Screenshot capture itself is NOT this module's job — we only
      // compute the path a caller should save a per-card screenshot to.
      const screenshotKey = ad.libraryId || contentHash || 'unknown';
      const screenshotPath = `assets/${competitorSlug}/${screenshotKey}.png`;

      const enriched = {
        ...ad,
        pageUrl,
        extractedAt,
        rawHtml: null, // intentionally omitted — see module header
        screenshot: screenshotPath,
        language: detectLanguage(`${ad.headline || ''} ${ad.primaryText || ''}`),
        primaryTextLength,
        headlineLength,
        contentHash,
      };

      enriched.confidence = computeConfidence(enriched);
      return enriched;
    });

    // ---- Deduplicate ----
    const { deduped, duplicatesRemoved } = deduplicateAds(enrichedAds);

    if (duplicatesRemoved > 0) {
      log('INFO', `Removed ${duplicatesRemoved} duplicate ad record(s) for "${competitorLabel}".`);
    }

    const timeTakenMs = Date.now() - startTime;

    log(
      'INFO',
      `Extraction complete for "${competitorLabel}": ${deduped.length} ad(s) in ${timeTakenMs}ms.`
    );

    return {
      ads: deduped,
      stats: { cardsSeen, duplicatesRemoved, failedCards, timeTakenMs },
    };
  } catch (err) {
    log('ERROR', `Failed to extract ads for competitor "${competitorLabel}": ${err.message}`);
    return {
      ads: [],
      stats: { ...emptyStats, timeTakenMs: Date.now() - startTime },
    };
  }
}

module.exports = {
  extractAds,
};

