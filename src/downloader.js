/**
 * src/downloader.js
 *
 * Enterprise Competitor Intelligence Platform
 * ---------------------------------------------------------------------------
 * Asset Downloader Module
 *
 * Sole responsibility: download creative assets (images/videos) referenced
 * by merged ads onto disk, organized per competitor ad under its Library ID.
 *
 * This module MUST NOT:
 *   - Interact with Playwright or any browser/page object
 *   - Parse HTML or DOM structures
 *   - Parse GraphQL/network payloads
 *   - Merge ad datasets
 *   - Write ads.json or any other orchestration output
 *
 * It ONLY downloads files referenced in the `images`/`videos` arrays of
 * already-merged ad objects, streaming each directly to disk.
 *
 * Design notes:
 *   - Downloads stream via axios (`responseType: 'stream'`) directly into
 *     an `fs` write stream — no file is ever buffered fully in memory,
 *     which matters for large video assets and for scraper runs with
 *     thousands of images.
 *   - Concurrency is capped at CONCURRENCY_LIMIT (5) via a small
 *     dependency-free worker-pool helper (mapWithConcurrency), so
 *     thousands of assets never start downloading simultaneously.
 *   - Each asset gets up to MAX_RETRIES (3) attempts with exponential
 *     backoff (1s, 2s, 4s) before being recorded as failed.
 *   - De-duplication is global, keyed on a normalized form of the URL
 *     (query/fragment-insensitive host casing, fragment stripped). The
 *     FIRST ad referencing a given URL triggers the actual network
 *     download ("primary"); every other ad referencing that same URL has
 *     the already-downloaded file copied locally (no second network
 *     request) into its own per-ad folder, so every ad's folder still
 *     ends up populated for downstream use.
 *   - File extension is resolved from the response's Content-Type header
 *     first, falling back to the URL's own extension, and finally to a
 *     sane per-asset-type default (.jpg / .mp4).
 *   - Validation rejects empty, non-string, malformed, `data:`, and
 *     `blob:` URLs before any network call is attempted — these count
 *     toward `skipped`, not `failed`.
 *   - Every per-asset failure is isolated: one bad URL, timeout, or I/O
 *     error is recorded in `failed` and never aborts the batch. The
 *     top-level `downloadAssets()` call itself is also wrapped so an
 *     entirely unexpected error still returns a well-formed stats object
 *     rather than throwing.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONCURRENCY_LIMIT = 5;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000; // 1s, 2s, 4s
const REQUEST_TIMEOUT_MS = 30000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CONTENT_TYPE_EXTENSION_MAP = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'video/3gpp': '.3gp',
  'video/x-matroska': '.mkv',
};

// ---------------------------------------------------------------------------
// Internal utility: lightweight logger (console only)
// ---------------------------------------------------------------------------

function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [downloader] [${level}] ${message}`;

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Internal utility: sleep helper for retry backoff
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Internal utility: filesystem-safe slug for per-ad folder names
// ---------------------------------------------------------------------------

function toSafeSlug(value) {
  if (!value) return null;
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : null;
}

/**
 * Resolves the per-ad folder name used under images/ and videos/. Prefers
 * the ad's libraryId; falls back to a stable index-based folder so ads
 * with no Library ID (e.g. unmatched DOM-only records) still get their
 * own folder instead of colliding with one another.
 *
 * @param {object} ad
 * @param {number} adIndex
 * @returns {string}
 */
function resolveAdFolderSlug(ad, adIndex) {
  return toSafeSlug(ad?.libraryId) || `unknown_${adIndex}`;
}

// ---------------------------------------------------------------------------
// Validation: reject empty / malformed / data: / blob: URLs up front
// ---------------------------------------------------------------------------

/**
 * @param {*} rawUrl
 * @returns {{ valid: boolean, reason: string|null }}
 */
function validateDownloadUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { valid: false, reason: 'URL is not a string' };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'Empty URL' };
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('data:')) {
    return { valid: false, reason: 'data: URLs are not downloadable' };
  }
  if (lower.startsWith('blob:')) {
    return { valid: false, reason: 'blob: URLs are not downloadable' };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
    }
  } catch (err) {
    return { valid: false, reason: 'Malformed URL' };
  }

  return { valid: true, reason: null };
}

/**
 * Normalizes a URL for de-duplication purposes: lowercases the host,
 * strips the fragment, and leaves path/query untouched (many servers are
 * path-case-sensitive). Falls back to a trimmed string if the value
 * isn't a parseable absolute URL — validation already filtered those out
 * before this is called, but this stays defensive regardless.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeUrlForDedup(rawUrl) {
  try {
    const parsed = new URL(rawUrl.trim());
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch (err) {
    return rawUrl.trim();
  }
}

// ---------------------------------------------------------------------------
// Extension resolution: Content-Type first, then URL, then a safe default
// ---------------------------------------------------------------------------

function extensionFromContentType(contentType) {
  if (!contentType || typeof contentType !== 'string') return null;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSION_MAP[mime] || null;
}

function extensionFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const ext = path.extname(parsed.pathname);
    return /^\.[a-zA-Z0-9]{2,5}$/.test(ext) ? ext.toLowerCase() : null;
  } catch (err) {
    return null;
  }
}

function resolveExtension(rawUrl, contentType, assetType) {
  return (
    extensionFromContentType(contentType) ||
    extensionFromUrl(rawUrl) ||
    (assetType === 'video' ? '.mp4' : '.jpg')
  );
}

// ---------------------------------------------------------------------------
// Concurrency: minimal dependency-free worker-pool mapper
// ---------------------------------------------------------------------------

/**
 * Runs `iteratorFn` over `items` with at most `limit` concurrently
 * in-flight, without pulling in an external queue/limiter package.
 *
 * @param {Array<any>} items
 * @param {number} limit
 * @param {(item: any, index: number) => Promise<any>} iteratorFn
 * @returns {Promise<Array<any>>}
 */
async function mapWithConcurrency(items, limit, iteratorFn) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await iteratorFn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

// ---------------------------------------------------------------------------
// Core download: single asset, streamed directly to disk
// ---------------------------------------------------------------------------

/**
 * Requests `url` and streams the response body directly to a file in
 * `destDir`, choosing the final filename (with extension) once response
 * headers are available. Never buffers the full response in memory.
 *
 * @param {string} url
 * @param {string} destDir
 * @param {string} baseFilename - without extension, e.g. "image_1"
 * @param {'image'|'video'} assetType
 * @returns {Promise<{ destPath: string, contentType: string|null }>}
 */
async function streamDownload(url, destDir, baseFilename, assetType) {
  const acceptHeader = assetType === 'video' ? 'video/*,*/*;q=0.8' : 'image/*,*/*;q=0.8';

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: acceptHeader,
    },
  });

  const contentType = response.headers?.['content-type'] || null;
  const ext = resolveExtension(url, contentType, assetType);
  const destPath = path.join(destDir, `${baseFilename}${ext}`);

  await fs.ensureDir(destDir);

  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      let settled = false;

      const onError = (err) => {
        if (settled) return;
        settled = true;
        writer.destroy();
        reject(err);
      };

      response.data.on('error', onError);
      writer.on('error', onError);
      writer.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      response.data.pipe(writer);
    });
  } catch (err) {
    // Attach the partial file's path so the retry wrapper can clean up
    // a truncated/corrupt file before the next attempt.
    err.partialPath = destPath;
    throw err;
  }

  return { destPath, contentType };
}

/**
 * Wraps streamDownload with retry + exponential backoff (1s, 2s, 4s).
 * Cleans up any partially-written file between failed attempts. Never
 * throws — resolves to a result object indicating success or failure.
 *
 * @param {{ url: string, destDir: string, baseFilename: string, assetType: 'image'|'video' }} task
 * @returns {Promise<{ success: true, destPath: string, contentType: string|null } | { success: false, error: Error }>}
 */
async function downloadWithRetry(task) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { destPath, contentType } = await streamDownload(
        task.url,
        task.destDir,
        task.baseFilename,
        task.assetType
      );
      return { success: true, destPath, contentType };
    } catch (err) {
      lastError = err;
      log('WARN', `Attempt ${attempt}/${MAX_RETRIES} failed for ${task.url}: ${err.message}`);

      if (err.partialPath) {
        await fs.remove(err.partialPath).catch(() => {});
      }

      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  return { success: false, error: lastError };
}

// ---------------------------------------------------------------------------
// Main export: downloadAssets
// ---------------------------------------------------------------------------

/**
 * Downloads every image/video referenced in `ads` into a per-Library-ID
 * folder structure under `outputDirectory`:
 *
 *   <outputDirectory>/images/<libraryId>/image_1.jpg, image_2.png, ...
 *   <outputDirectory>/videos/<libraryId>/video_1.mp4, video_2.mov, ...
 *
 * Never throws. A malformed input, a missing output directory, or any
 * unexpected internal error all resolve to a well-formed (possibly
 * all-zero) stats object rather than rejecting.
 *
 * @param {Array<{
 *   libraryId?: string|number|null,
 *   advertiser?: string|null,
 *   headline?: string|null,
 *   images?: string[],
 *   videos?: string[]
 * }>} ads
 * @param {string} outputDirectory
 * @returns {Promise<{
 *   downloadedImages: number,
 *   downloadedVideos: number,
 *   skipped: number,
 *   failed: Array<{ url: string, reason: string }>,
 *   totalAssetsSeen: number,
 *   duplicatesReused: number,
 *   timeTakenMs: number
 * }>}
 */
async function downloadAssets(ads, outputDirectory) {
  const startTime = Date.now();
  const emptyStats = {
    downloadedImages: 0,
    downloadedVideos: 0,
    skipped: 0,
    failed: [],
    totalAssetsSeen: 0,
    duplicatesReused: 0,
    timeTakenMs: 0,
  };

  try {
    if (!Array.isArray(ads) || ads.length === 0) {
      log('INFO', 'downloadAssets called with no ads — nothing to download.');
      return { ...emptyStats, timeTakenMs: Date.now() - startTime };
    }

    if (!outputDirectory || typeof outputDirectory !== 'string') {
      log('ERROR', 'downloadAssets called without a valid outputDirectory.');
      return { ...emptyStats, timeTakenMs: Date.now() - startTime };
    }

    try {
      await fs.ensureDir(outputDirectory);
    } catch (err) {
      log('ERROR', `Failed to ensure output directory "${outputDirectory}": ${err.message}`);
      return { ...emptyStats, timeTakenMs: Date.now() - startTime };
    }

    // ---- Build a flat task list across all ads ----
    // Each task carries its own destination folder (per ad Library ID)
    // and its own sequential filename (image_1, image_2, ... reset per
    // ad), plus a normalized key used for cross-ad de-duplication below.
    const tasks = [];
    let skippedCount = 0;
    const failedList = [];

    ads.forEach((ad, adIndex) => {
      if (!ad || typeof ad !== 'object') return;

      const folderSlug = resolveAdFolderSlug(ad, adIndex);
      const imagesDir = path.join(outputDirectory, 'images', folderSlug);
      const videosDir = path.join(outputDirectory, 'videos', folderSlug);

      const imageUrls = Array.isArray(ad.images) ? ad.images : [];
      const videoUrls = Array.isArray(ad.videos) ? ad.videos : [];

      let imageCounter = 0;
      imageUrls.forEach((rawUrl) => {
        const validation = validateDownloadUrl(rawUrl);
        if (!validation.valid) {
          skippedCount += 1;
          return;
        }

        imageCounter += 1;
        tasks.push({
          assetType: 'image',
          url: rawUrl.trim(),
          normalizedKey: normalizeUrlForDedup(rawUrl),
          destDir: imagesDir,
          baseFilename: `image_${imageCounter}`,
        });
      });

      let videoCounter = 0;
      videoUrls.forEach((rawUrl) => {
        const validation = validateDownloadUrl(rawUrl);
        if (!validation.valid) {
          skippedCount += 1;
          return;
        }

        videoCounter += 1;
        tasks.push({
          assetType: 'video',
          url: rawUrl.trim(),
          normalizedKey: normalizeUrlForDedup(rawUrl),
          destDir: videosDir,
          baseFilename: `video_${videoCounter}`,
        });
      });
    });

    log(
      'INFO',
      `Prepared ${tasks.length} asset download task(s) (${skippedCount} skipped as invalid URLs).`
    );

    // ---- Group by normalized URL for de-duplication ----
    // The first task per group is the "primary" (actually fetched over
    // the network); the rest are "duplicates" satisfied via local copy
    // once the primary completes, so identical assets are never fetched
    // twice regardless of how many ads reference them.
    const groups = new Map();
    for (const task of tasks) {
      if (!groups.has(task.normalizedKey)) groups.set(task.normalizedKey, []);
      groups.get(task.normalizedKey).push(task);
    }

    const groupEntries = Array.from(groups.entries()).map(([key, group]) => ({
      key,
      primary: group[0],
      duplicates: group.slice(1),
    }));

    let downloadedImages = 0;
    let downloadedVideos = 0;
    let duplicatesReused = 0;

    // ---- Phase 1: download every primary asset, concurrency-limited ----
    const primaryResults = await mapWithConcurrency(groupEntries, CONCURRENCY_LIMIT, async (entry) => {
      const result = await downloadWithRetry(entry.primary);

      if (result.success) {
        if (entry.primary.assetType === 'image') downloadedImages += 1;
        else downloadedVideos += 1;
      } else {
        failedList.push({
          url: entry.primary.url,
          reason: result.error?.message || 'Unknown download error',
        });
      }

      return { key: entry.key, result };
    });

    const primaryResultByKey = new Map(primaryResults.map((r) => [r.key, r.result]));

    // ---- Phase 2: satisfy duplicate references via local file copy ----
    const duplicateJobs = [];
    for (const entry of groupEntries) {
      if (entry.duplicates.length === 0) continue;
      const primaryResult = primaryResultByKey.get(entry.key);
      for (const dup of entry.duplicates) {
        duplicateJobs.push({ dup, primaryResult });
      }
    }

    await mapWithConcurrency(duplicateJobs, CONCURRENCY_LIMIT, async ({ dup, primaryResult }) => {
      if (!primaryResult || !primaryResult.success) {
        failedList.push({
          url: dup.url,
          reason: `Primary download of this duplicate asset failed: ${
            primaryResult?.error?.message || 'unknown error'
          }`,
        });
        return;
      }

      try {
        await fs.ensureDir(dup.destDir);
        const ext = path.extname(primaryResult.destPath);
        const destPath = path.join(dup.destDir, `${dup.baseFilename}${ext}`);
        await fs.copy(primaryResult.destPath, destPath);

        if (dup.assetType === 'image') downloadedImages += 1;
        else downloadedVideos += 1;
        duplicatesReused += 1;
      } catch (err) {
        failedList.push({ url: dup.url, reason: `Failed to copy duplicate asset locally: ${err.message}` });
      }
    });

    const timeTakenMs = Date.now() - startTime;

    log(
      'INFO',
      `downloadAssets complete: ${downloadedImages} image(s), ${downloadedVideos} video(s) ` +
        `(${duplicatesReused} via local duplicate reuse), ${skippedCount} skipped, ` +
        `${failedList.length} failed, in ${timeTakenMs}ms.`
    );

    return {
      downloadedImages,
      downloadedVideos,
      skipped: skippedCount,
      failed: failedList,
      totalAssetsSeen: tasks.length,
      duplicatesReused,
      timeTakenMs,
    };
  } catch (err) {
    // Fully unexpected, unhandled failure — still never throw.
    log('ERROR', `downloadAssets failed unexpectedly: ${err.message}`);
    return { ...emptyStats, timeTakenMs: Date.now() - startTime };
  }
}

module.exports = {
  downloadAssets,
};
