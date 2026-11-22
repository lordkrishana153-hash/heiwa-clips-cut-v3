/* Stage 7 module: single and sequential batch downloads and safe filename generation. */

import { ERROR_CODES, fail, ok } from './errors.js';

export const DOWNLOAD_STAGE = 7;
export const MAX_FILENAME_LENGTH = 120;
export const DEFAULT_BATCH_DELAY_MS = 450;

const URL_REVOKE_DELAY_MS = 10_000;
const UNSAFE_CHARS_REGEX = /[<>:"/\\|?*\u0000-\u001F\u007F]+/g;
const WINDOWS_RESERVED_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const VALID_EXTENSIONS = new Set(['mp4', 'webm', 'zip']);

const trackedObjectUrls = new Map();
let pagehideRegistered = false;

function ensurePagehideCleanup() {
  if (pagehideRegistered || typeof window === 'undefined') {
    return;
  }
  pagehideRegistered = true;
  window.addEventListener('pagehide', () => {
    revokeAllDownloadUrls();
  });
}

export function revokeAllDownloadUrls() {
  for (const [url, timerId] of trackedObjectUrls.entries()) {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* Ignore already-revoked object URLs. */
      }
    }
  }
  trackedObjectUrls.clear();
  return ok(true);
}

export function stripFileExtension(filename) {
  if (typeof filename !== 'string') {
    return '';
  }
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, lastDot);
}

export function sanitizeFilenamePart(raw, fallback = 'clip') {
  const safeFallback = typeof fallback === 'string' && fallback.trim() ? fallback.trim() : 'clip';
  if (typeof raw !== 'string') {
    return safeFallback;
  }
  const cleaned = raw
    .replace(UNSAFE_CHARS_REGEX, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  if (!cleaned) {
    return safeFallback;
  }
  if (WINDOWS_RESERVED_REGEX.test(cleaned)) {
    return `file_${cleaned}`;
  }
  return cleaned;
}

export function formatTimeForFilename(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '00m00s';
  }
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const remAfterHours = totalMs % 3_600_000;
  const minutes = Math.floor(remAfterHours / 60_000);
  const remAfterMinutes = remAfterHours % 60_000;
  const secs = Math.floor(remAfterMinutes / 1000);
  const ms = remAfterMinutes % 1000;

  const pad2 = (n) => String(n).padStart(2, '0');
  const frac = ms > 0 ? `.${String(ms).padStart(3, '0').replace(/0+$/, '')}` : '';

  if (hours > 0) {
    return `${pad2(hours)}h${pad2(minutes)}m${pad2(secs)}${frac}s`;
  }
  return `${pad2(minutes)}m${pad2(secs)}${frac}s`;
}

function normalizeExtension(format) {
  const lower = typeof format === 'string' ? format.trim().toLowerCase().replace(/^\./, '') : '';
  return VALID_EXTENSIONS.has(lower) ? lower : 'mp4';
}

function toLowerNameSet(existingNames) {
  const set = new Set();
  if (!existingNames) {
    return set;
  }
  for (const name of existingNames) {
    if (typeof name === 'string' && name.trim()) {
      set.add(name.trim().toLowerCase());
    }
  }
  return set;
}

function deduplicateFilename(baseStem, ext, existingNames) {
  const used = toLowerNameSet(existingNames);
  const suffixWithExt = `.${ext}`;
  const maxBaseLen = Math.max(8, MAX_FILENAME_LENGTH - suffixWithExt.length);
  let stem = baseStem.slice(0, maxBaseLen).replace(/[._-]+$/g, '') || 'clip';

  if (WINDOWS_RESERVED_REGEX.test(stem)) {
    stem = `file_${stem}`.slice(0, maxBaseLen);
  }

  let candidate = `${stem}${suffixWithExt}`;
  if (!used.has(candidate.toLowerCase())) {
    return candidate;
  }

  for (let counter = 2; counter <= 9999; counter += 1) {
    const dupSuffix = `_${counter}`;
    const trimmedStem = stem
      .slice(0, Math.max(4, maxBaseLen - dupSuffix.length))
      .replace(/[._-]+$/g, '') || 'clip';
    candidate = `${trimmedStem}${dupSuffix}${suffixWithExt}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${stem.slice(0, Math.max(4, maxBaseLen - 8))}_${Date.now().toString(36).slice(-6)}${suffixWithExt}`;
}

export function buildClipFilename({
  sourceName,
  clipName,
  startSec,
  endSec,
  format = 'mp4',
  existingNames = null
}) {
  const ext = normalizeExtension(format);
  const sourcePart = sanitizeFilenamePart(stripFileExtension(sourceName || 'video'), 'video');
  const clipPart = sanitizeFilenamePart(clipName || 'clip', 'clip');
  const rangePart = `${formatTimeForFilename(startSec)}-${formatTimeForFilename(endSec)}`;

  const fixedTail = `_${rangePart}.${ext}`;
  const maxPrefixLen = Math.max(12, MAX_FILENAME_LENGTH - fixedTail.length - 5);
  const halfBudget = Math.max(6, Math.floor((maxPrefixLen - 1) / 2));

  let trimmedSource = sourcePart;
  let trimmedClip = clipPart;
  if (trimmedSource.length + 1 + trimmedClip.length > maxPrefixLen) {
    trimmedSource = trimmedSource.slice(0, halfBudget).replace(/[._-]+$/g, '') || 'video';
    const remainingForClip = Math.max(6, maxPrefixLen - trimmedSource.length - 1);
    trimmedClip = trimmedClip.slice(0, remainingForClip).replace(/[._-]+$/g, '') || 'clip';
  }

  const baseStem = `${trimmedSource}_${trimmedClip}_${rangePart}`;
  return ok(deduplicateFilename(baseStem, ext, existingNames));
}

export function sanitizeCustomFilename(rawInput, format = 'mp4', existingNames = null) {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return fail(ERROR_CODES.E_DOWNLOAD_FAILED, 'Filename cannot be empty.', 'Enter a valid clip filename.');
  }
  const ext = normalizeExtension(format);
  const stripped = stripFileExtension(rawInput.trim());
  const cleaned = sanitizeFilenamePart(stripped, 'clip');
  return ok(deduplicateFilename(cleaned, ext, existingNames));
}

export function buildZipFilename(sourceName) {
  const sourcePart = sanitizeFilenamePart(stripFileExtension(sourceName || 'heiwa_clips'), 'heiwa_clips');
  const trimmed = sourcePart.slice(0, MAX_FILENAME_LENGTH - 10).replace(/[._-]+$/g, '') || 'heiwa_clips';
  return ok(`${trimmed}_clips.zip`);
}

export function downloadBlob(blob, filename) {
  if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
    return fail(ERROR_CODES.E_OUTPUT_EMPTY, 'Cannot download an empty file.');
  }
  if (typeof filename !== 'string' || !filename.trim()) {
    return fail(ERROR_CODES.E_DOWNLOAD_FAILED, 'A valid filename is required for download.');
  }
  if (
    typeof document === 'undefined' ||
    !document.body ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return fail(ERROR_CODES.E_DOWNLOAD_FAILED, 'Browser download APIs are unavailable in this environment.');
  }

  ensurePagehideCleanup();

  let objectUrl = null;
  try {
    objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename.trim();
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    const timerId = setTimeout(() => {
      trackedObjectUrls.delete(objectUrl);
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* Ignore already-revoked object URLs. */
      }
    }, URL_REVOKE_DELAY_MS);
    trackedObjectUrls.set(objectUrl, timerId);

    return ok({
      filename: filename.trim(),
      bytes: blob.size
    });
  } catch (err) {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* Ignore cleanup error. */
      }
      trackedObjectUrls.delete(objectUrl);
    }
    const detail = err instanceof Error ? err.message : String(err || '');
    return fail(
      ERROR_CODES.E_DOWNLOAD_FAILED,
      detail ? `Could not trigger file download (${detail}).` : undefined
    );
  }
}

function waitMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function downloadBatchSequentially(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return fail(ERROR_CODES.E_DOWNLOAD_FAILED, 'No finished clips are available to download.');
  }
  const delayMs = typeof options.delayMs === 'number' && options.delayMs >= 0
    ? options.delayMs
    : DEFAULT_BATCH_DELAY_MS;
  const triggerDownload = typeof options.downloadFn === 'function' ? options.downloadFn : downloadBlob;
  const onItemDone = typeof options.onItemDone === 'function' ? options.onItemDone : null;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;

  const downloadedIds = [];
  const failedItems = [];
  let cancelled = false;

  for (let i = 0; i < items.length; i += 1) {
    if (shouldCancel && shouldCancel()) {
      cancelled = true;
      break;
    }
    const item = items[i];
    const res = triggerDownload(item.blob, item.filename);
    if (res.ok) {
      downloadedIds.push(item.id);
      if (onItemDone) {
        onItemDone(item, i, items.length);
      }
    } else {
      failedItems.push({ id: item.id, filename: item.filename, error: res.error });
    }
    if (i < items.length - 1 && delayMs > 0) {
      await waitMs(delayMs);
    }
  }

  const multiDownloadNote = items.length > 1
    ? 'If your browser blocked extra files after the first download, allow "Automatic downloads" for this site or click each clip\'s Download button individually.'
    : '';

  return ok({
    total: items.length,
    downloadedIds,
    failedItems,
    cancelled,
    multiDownloadNote
  });
}
