/* Frozen error catalog, typed Result helpers, error normalization, and toast routing. */

import { showToast } from './ui/toasts.js';

export const ERROR_CODES = Object.freeze({
  E_EMPTY_FILE: 'E_EMPTY_FILE',
  E_UNSUPPORTED_CONTAINER: 'E_UNSUPPORTED_CONTAINER',
  E_UNSUPPORTED_CODEC: 'E_UNSUPPORTED_CODEC',
  E_CORRUPT_FILE: 'E_CORRUPT_FILE',
  E_METADATA_INVALID: 'E_METADATA_INVALID',
  E_LOAD_TIMEOUT: 'E_LOAD_TIMEOUT',
  E_RANGE_INVALID: 'E_RANGE_INVALID',
  E_TIME_PARSE: 'E_TIME_PARSE',
  E_NO_WEBCODECS: 'E_NO_WEBCODECS',
  E_ENCODER_UNSUPPORTED: 'E_ENCODER_UNSUPPORTED',
  E_EXPORT_FAILED: 'E_EXPORT_FAILED',
  E_OUTPUT_EMPTY: 'E_OUTPUT_EMPTY',
  E_OUTPUT_VERIFY: 'E_OUTPUT_VERIFY',
  E_CANCELLED: 'E_CANCELLED',
  E_ZIP_TOO_LARGE: 'E_ZIP_TOO_LARGE',
  E_ZIP_FAILED: 'E_ZIP_FAILED',
  E_DOWNLOAD_FAILED: 'E_DOWNLOAD_FAILED',
  E_STORAGE_FULL: 'E_STORAGE_FULL',
  E_STORAGE_UNAVAILABLE: 'E_STORAGE_UNAVAILABLE',
  E_OUT_OF_MEMORY_RISK: 'E_OUT_OF_MEMORY_RISK'
});

export const ERROR_CATALOG = Object.freeze({
  E_EMPTY_FILE: Object.freeze({
    code: 'E_EMPTY_FILE',
    message: 'The selected file is empty (0 bytes).',
    hint: 'Choose a valid video file that has finished recording or downloading.'
  }),
  E_UNSUPPORTED_CONTAINER: Object.freeze({
    code: 'E_UNSUPPORTED_CONTAINER',
    message: 'This video container format is not supported by the browser.',
    hint: 'Try converting the file to MP4 (H.264/AAC) or WebM (VP9/Opus) and open it again.'
  }),
  E_UNSUPPORTED_CODEC: Object.freeze({
    code: 'E_UNSUPPORTED_CODEC',
    message: 'This browser cannot decode the video or audio codec in this file.',
    hint: 'Re-encode the source to H.264/AAC MP4 or try opening it in a Chromium-based browser.'
  }),
  E_CORRUPT_FILE: Object.freeze({
    code: 'E_CORRUPT_FILE',
    message: 'The file could not be read as a valid video.',
    hint: 'Check that the file plays in your system media player and is not damaged or renamed.'
  }),
  E_METADATA_INVALID: Object.freeze({
    code: 'E_METADATA_INVALID',
    message: 'The video duration or frame dimensions could not be read reliably.',
    hint: 'Remux the file into a standard MP4 container and try loading it again.'
  }),
  E_LOAD_TIMEOUT: Object.freeze({
    code: 'E_LOAD_TIMEOUT',
    message: 'Loading the video timed out after 15 seconds.',
    hint: 'Verify the file is stored locally on disk (not a slow cloud placeholder) and try again.'
  }),
  E_RANGE_INVALID: Object.freeze({
    code: 'E_RANGE_INVALID',
    message: 'The clip start and end times are invalid.',
    hint: 'Make sure the start time is before the end time and both stay within the video duration.'
  }),
  E_TIME_PARSE: Object.freeze({
    code: 'E_TIME_PARSE',
    message: 'That timestamp could not be understood.',
    hint: 'Enter seconds (90), minutes and seconds (1:30), or hours (1:02:03.5) with no negatives or letters.'
  }),
  E_NO_WEBCODECS: Object.freeze({
    code: 'E_NO_WEBCODECS',
    message: 'WebCodecs is not available in this browser.',
    hint: 'Open Heiwa Clips Cut in a recent version of Chrome, Edge, or Chromium on HTTPS or localhost.'
  }),
  E_ENCODER_UNSUPPORTED: Object.freeze({
    code: 'E_ENCODER_UNSUPPORTED',
    message: 'This device does not support the chosen export codec or resolution.',
    hint: 'Switch to WebM (VP9/Opus) or lower the maximum resolution (720p or 480p) and retry.'
  }),
  E_EXPORT_FAILED: Object.freeze({
    code: 'E_EXPORT_FAILED',
    message: 'Exporting the clip failed during media processing.',
    hint: 'Retry the clip, lower the export resolution, or keep this tab in the foreground while exporting.'
  }),
  E_OUTPUT_EMPTY: Object.freeze({
    code: 'E_OUTPUT_EMPTY',
    message: 'The exported clip file came out empty (0 bytes).',
    hint: 'Check that the clip range has video frames and retry in Precise mode.'
  }),
  E_OUTPUT_VERIFY: Object.freeze({
    code: 'E_OUTPUT_VERIFY',
    message: 'The exported clip failed playback or duration verification.',
    hint: 'Retry the clip in Precise mode or with a lower resolution setting.'
  }),
  E_CANCELLED: Object.freeze({
    code: 'E_CANCELLED',
    message: 'The operation was cancelled.',
    hint: 'You can restart or retry any unfinished clips whenever you are ready.'
  }),
  E_ZIP_TOO_LARGE: Object.freeze({
    code: 'E_ZIP_TOO_LARGE',
    message: 'The combined clips exceed the 4 GB standard ZIP limit.',
    hint: 'Download the clips individually or export fewer clips into a single ZIP.'
  }),
  E_ZIP_FAILED: Object.freeze({
    code: 'E_ZIP_FAILED',
    message: 'Creating the ZIP archive failed.',
    hint: 'Download your finished clips individually instead.'
  }),
  E_DOWNLOAD_FAILED: Object.freeze({
    code: 'E_DOWNLOAD_FAILED',
    message: 'The browser could not save the file.',
    hint: 'Allow automatic downloads for this site or click each clip download button one by one.'
  }),
  E_STORAGE_FULL: Object.freeze({
    code: 'E_STORAGE_FULL',
    message: 'Browser storage is full, so autosave could not be written.',
    hint: 'Free up device storage or clear old export history; your current session remains active.'
  }),
  E_STORAGE_UNAVAILABLE: Object.freeze({
    code: 'E_STORAGE_UNAVAILABLE',
    message: 'IndexedDB storage is blocked or unavailable in this browser mode.',
    hint: 'You can keep working in this tab, but autosave and crash recovery are turned off.'
  }),
  E_OUT_OF_MEMORY_RISK: Object.freeze({
    code: 'E_OUT_OF_MEMORY_RISK',
    message: 'This export batch may exceed available browser memory on this device.',
    hint: 'Lower the resolution to 720p or 480p, shorten clip ranges, or export fewer clips at a time.'
  })
});

export function ok(value) {
  return { ok: true, value };
}

export function createAppError(code, customMessage, customHint) {
  const fallback = ERROR_CATALOG.E_EXPORT_FAILED;
  const entry = Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code)
    ? ERROR_CATALOG[code]
    : fallback;

  const message = typeof customMessage === 'string' && customMessage.trim()
    ? customMessage.trim()
    : entry.message;

  const hint = typeof customHint === 'string' && customHint.trim()
    ? customHint.trim()
    : entry.hint;

  return {
    code: entry.code,
    message,
    hint
  };
}

export function fail(code, customMessage, customHint) {
  return {
    ok: false,
    error: createAppError(code, customMessage, customHint)
  };
}

export function isAppError(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    typeof value.code === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value.code) &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    typeof value.hint === 'string' &&
    value.hint.trim().length > 0
  );
}

export function normalizeError(err, fallbackCode = ERROR_CODES.E_EXPORT_FAILED) {
  if (isAppError(err)) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  if (err && typeof err === 'object' && typeof err.name === 'string') {
    if (err.name === 'QuotaExceededError') {
      return createAppError(ERROR_CODES.E_STORAGE_FULL);
    }
    if (err.name === 'AbortError') {
      return createAppError(ERROR_CODES.E_CANCELLED);
    }
  }
  const detail = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : '';
  const base = createAppError(fallbackCode);
  if (!detail || detail === base.message) {
    return base;
  }
  return createAppError(base.code, `${base.message} (${detail})`, base.hint);
}

export function notifyToast(title, hint = '', variant = 'info', durationMs) {
  return showToast({ title, hint, variant, durationMs });
}

export function reportError(err, options = {}) {
  const fallbackCode = options.fallbackCode || ERROR_CODES.E_EXPORT_FAILED;
  const appError = normalizeError(err, fallbackCode);
  const shouldToast = options.toast !== false;
  if (shouldToast) {
    const variant = appError.code === ERROR_CODES.E_CANCELLED ? 'warning' : 'error';
    showToast({
      title: `${appError.code}: ${appError.message}`,
      hint: appError.hint,
      variant
    });
  }
  return appError;
}
