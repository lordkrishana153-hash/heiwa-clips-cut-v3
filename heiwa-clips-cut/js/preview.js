/* Stage 2 module: video preview element controls, 15s load timeout, loading/error states, and playhead sync. */

import { ACTIONS, store } from './store.js';
import { createAppError, ERROR_CODES, fail, ok } from './errors.js';
import { clamp, formatTimestamp } from './time.js';

export const VIDEO_LOAD_TIMEOUT_MS = 15_000;
const SEEK_SLIDER_STEPS = 1000;

let previewRefs = null;
let isInitialized = false;
let isUserSeeking = false;
let activeLoadAbort = null;
let activeRange = null;
let rangeRafId = null;

function formatSafeTime(seconds) {
  const res = formatTimestamp(seconds);
  return res.ok ? res.value : '00:00:00.000';
}

function setVisible(el, visible) {
  if (!el) {
    return;
  }
  el.hidden = !visible;
}

function setControlsEnabled(enabled) {
  if (!previewRefs) {
    return;
  }
  if (previewRefs.playBtn) {
    previewRefs.playBtn.disabled = !enabled;
  }
  if (previewRefs.seekBar) {
    previewRefs.seekBar.disabled = !enabled;
  }
}

function updatePlayButtonLabel(isPlaying) {
  if (!previewRefs || !previewRefs.playBtn) {
    return;
  }
  previewRefs.playBtn.textContent = isPlaying ? 'Pause' : 'Play';
  previewRefs.playBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
}

function syncSeekBarToTime(currentSec, durationSec) {
  if (!previewRefs) {
    return;
  }
  if (previewRefs.currentTime) {
    previewRefs.currentTime.textContent = formatSafeTime(Math.max(0, currentSec));
  }
  if (previewRefs.durationTime) {
    previewRefs.durationTime.textContent = formatSafeTime(Math.max(0, durationSec));
  }
  if (previewRefs.seekBar && !isUserSeeking) {
    const ratio = durationSec > 0 ? currentSec / durationSec : 0;
    const clamped = clamp(ratio, 0, 1);
    const value = clamped.ok ? Math.round(clamped.value * SEEK_SLIDER_STEPS) : 0;
    previewRefs.seekBar.value = String(value);
  }
}

export function setPreviewIdle() {
  if (!previewRefs) {
    return;
  }
  setVisible(previewRefs.emptyState, true);
  setVisible(previewRefs.loadingState, false);
  setVisible(previewRefs.errorState, false);
  setVisible(previewRefs.video, false);
  setControlsEnabled(false);
  updatePlayButtonLabel(false);
  syncSeekBarToTime(0, 0);
}

export function setPreviewLoading(fileName) {
  if (!previewRefs) {
    return;
  }
  setVisible(previewRefs.emptyState, false);
  setVisible(previewRefs.errorState, false);
  setVisible(previewRefs.video, false);
  setVisible(previewRefs.loadingState, true);
  if (previewRefs.loadingState) {
    previewRefs.loadingState.textContent = fileName
      ? `Loading "${fileName}"…`
      : 'Loading video…';
  }
  setControlsEnabled(false);
  updatePlayButtonLabel(false);
}

export function setPreviewError(appError) {
  if (!previewRefs) {
    return;
  }
  setVisible(previewRefs.emptyState, false);
  setVisible(previewRefs.loadingState, false);
  setVisible(previewRefs.video, false);
  setVisible(previewRefs.errorState, true);

  if (previewRefs.errorState) {
    while (previewRefs.errorState.firstChild) {
      previewRefs.errorState.removeChild(previewRefs.errorState.firstChild);
    }
    const titleEl = document.createElement('p');
    titleEl.className = 'preview-error__title';
    titleEl.textContent = `${appError.code}: ${appError.message}`;

    const hintEl = document.createElement('p');
    hintEl.className = 'preview-error__hint';
    hintEl.textContent = appError.hint;

    previewRefs.errorState.appendChild(titleEl);
    previewRefs.errorState.appendChild(hintEl);
  }

  setControlsEnabled(false);
  updatePlayButtonLabel(false);
  syncSeekBarToTime(0, 0);
}

export function setPreviewReady(durationSec) {
  if (!previewRefs) {
    return;
  }
  setVisible(previewRefs.emptyState, false);
  setVisible(previewRefs.loadingState, false);
  setVisible(previewRefs.errorState, false);
  setVisible(previewRefs.video, true);
  setControlsEnabled(true);
  updatePlayButtonLabel(false);
  syncSeekBarToTime(0, durationSec);
}

export function stopRangePreview() {
  activeRange = null;
  if (rangeRafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rangeRafId);
    rangeRafId = null;
  }
  return ok(true);
}

function enforceRangeTick() {
  rangeRafId = null;
  if (!activeRange || !previewRefs || !previewRefs.video) {
    return;
  }
  const video = previewRefs.video;
  const source = store.getState().source;
  if (video.paused || video.ended) {
    activeRange = null;
    return;
  }
  if (video.currentTime >= activeRange.endSec) {
    const endSec = activeRange.endSec;
    activeRange = null;
    video.pause();
    video.currentTime = endSec;
    store.dispatch({ type: ACTIONS.SET_PLAYHEAD, payload: endSec });
    if (source) {
      syncSeekBarToTime(endSec, source.durationSec);
    }
    return;
  }
  if (typeof requestAnimationFrame === 'function') {
    rangeRafId = requestAnimationFrame(enforceRangeTick);
  }
}

export function clearPreview() {
  stopRangePreview();
  if (activeLoadAbort) {
    activeLoadAbort();
    activeLoadAbort = null;
  }
  if (!previewRefs || !previewRefs.video) {
    return ok(true);
  }
  const video = previewRefs.video;
  try {
    video.pause();
  } catch {
    /* Ignore pause errors on unloaded element. */
  }
  video.removeAttribute('src');
  video.load();
  setPreviewIdle();
  return ok(true);
}

function mapMediaElementError(video) {
  const mediaErr = video && video.error ? video.error : null;
  if (!mediaErr) {
    return createAppError(ERROR_CODES.E_CORRUPT_FILE);
  }
  if (mediaErr.code === 3) {
    return createAppError(
      ERROR_CODES.E_CORRUPT_FILE,
      'The browser encountered a decoding error while reading this video.'
    );
  }
  if (mediaErr.code === 4) {
    return createAppError(
      ERROR_CODES.E_UNSUPPORTED_CONTAINER,
      'The browser cannot play this video file or container format.'
    );
  }
  return createAppError(ERROR_CODES.E_CORRUPT_FILE);
}

export function loadVideoIntoPreview(objectUrl, fileName, timeoutMs = VIDEO_LOAD_TIMEOUT_MS) {
  if (!previewRefs || !previewRefs.video) {
    return Promise.resolve(fail(ERROR_CODES.E_EXPORT_FAILED, 'Preview video element is not mounted.'));
  }
  if (typeof objectUrl !== 'string' || !objectUrl) {
    return Promise.resolve(fail(ERROR_CODES.E_EMPTY_FILE));
  }

  if (activeLoadAbort) {
    activeLoadAbort();
    activeLoadAbort = null;
  }

  const video = previewRefs.video;
  setPreviewLoading(fileName);

  return new Promise((resolve) => {
    let settled = false;
    let timerId = null;

    const cleanup = () => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
      if (activeLoadAbort === abortLoad) {
        activeLoadAbort = null;
      }
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const abortLoad = () => {
      finish(fail(ERROR_CODES.E_CANCELLED));
    };

    const onLoadedMetadata = () => {
      const durationSec = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;

      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        finish(fail(
          ERROR_CODES.E_METADATA_INVALID,
          'Video duration reported by the browser is NaN, Infinity, or zero.'
        ));
        return;
      }
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        finish(fail(
          ERROR_CODES.E_METADATA_INVALID,
          'Video frame dimensions could not be determined.'
        ));
        return;
      }

      finish(ok({ durationSec, width, height }));
    };

    const onError = () => {
      finish({ ok: false, error: mapMediaElementError(video) });
    };

    activeLoadAbort = abortLoad;
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('error', onError);

    timerId = setTimeout(() => {
      video.removeAttribute('src');
      video.load();
      finish(fail(ERROR_CODES.E_LOAD_TIMEOUT));
    }, timeoutMs);

    video.preload = 'metadata';
    video.src = objectUrl;
    video.load();
  });
}

export function seekPreviewTo(seconds) {
  if (!previewRefs || !previewRefs.video) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Preview is not initialized.');
  }
  stopRangePreview();
  const source = store.getState().source;
  const maxSec = source && Number.isFinite(source.durationSec) ? source.durationSec : 0;
  const clamped = clamp(seconds, 0, maxSec);
  if (!clamped.ok) {
    return clamped;
  }
  previewRefs.video.currentTime = clamped.value;
  store.dispatch({ type: ACTIONS.SET_PLAYHEAD, payload: clamped.value });
  syncSeekBarToTime(clamped.value, maxSec);
  return ok(clamped.value);
}

export function stepPreviewBySeconds(deltaSec) {
  if (typeof deltaSec !== 'number' || !Number.isFinite(deltaSec)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Seek delta must be a finite number.');
  }
  const state = store.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_EMPTY_FILE, 'Open a video before seeking.');
  }
  const current = previewRefs && previewRefs.video && Number.isFinite(previewRefs.video.currentTime)
    ? previewRefs.video.currentTime
    : state.playheadSec;
  return seekPreviewTo(current + deltaSec);
}

export function stepPreviewFrame(direction) {
  if (direction !== -1 && direction !== 1) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Frame step direction must be -1 or 1.');
  }
  const state = store.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_EMPTY_FILE, 'Open a video before stepping frames.');
  }
  if (previewRefs && previewRefs.video && !previewRefs.video.paused) {
    previewRefs.video.pause();
  }
  const fps = typeof state.source.fps === 'number' && Number.isFinite(state.source.fps) && state.source.fps > 0
    ? state.source.fps
    : 30;
  return stepPreviewBySeconds(direction / fps);
}

export async function playClipRange(startSec, endSec) {
  if (!previewRefs || !previewRefs.video) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Preview is not initialized.');
  }
  const source = store.getState().source;
  if (!source) {
    return fail(ERROR_CODES.E_EMPTY_FILE, 'Open a video before previewing a clip.');
  }
  if (
    typeof startSec !== 'number' ||
    typeof endSec !== 'number' ||
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    startSec < 0 ||
    endSec <= startSec ||
    endSec > source.durationSec + 0.001
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip range is outside the video duration.');
  }

  stopRangePreview();
  const video = previewRefs.video;
  const clampedEnd = Math.min(endSec, source.durationSec);
  activeRange = { startSec, endSec: clampedEnd };

  try {
    video.currentTime = startSec;
    store.dispatch({ type: ACTIONS.SET_PLAYHEAD, payload: startSec });
    syncSeekBarToTime(startSec, source.durationSec);
    await video.play();
    updatePlayButtonLabel(true);
    if (typeof requestAnimationFrame === 'function') {
      rangeRafId = requestAnimationFrame(enforceRangeTick);
    }
    return ok(true);
  } catch (err) {
    stopRangePreview();
    const detail = err instanceof Error ? err.message : String(err);
    return fail(ERROR_CODES.E_UNSUPPORTED_CODEC, `Clip preview could not start (${detail}).`);
  }
}

export async function togglePreviewPlayback() {
  if (!previewRefs || !previewRefs.video) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Preview is not initialized.');
  }
  const video = previewRefs.video;
  if (!store.getState().source) {
    return fail(ERROR_CODES.E_EMPTY_FILE, 'Open a video before playing.');
  }
  stopRangePreview();
  try {
    if (video.paused || video.ended) {
      await video.play();
      updatePlayButtonLabel(true);
      return ok(true);
    }
    video.pause();
    updatePlayButtonLabel(false);
    return ok(false);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(ERROR_CODES.E_UNSUPPORTED_CODEC, `Playback could not start (${detail}).`);
  }
}

export function initPreview(refs) {
  if (!refs || !refs.video) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing preview DOM elements.');
  }
  if (isInitialized) {
    return ok(true);
  }
  previewRefs = refs;
  isInitialized = true;

  const { video, playBtn, seekBar } = previewRefs;

  video.addEventListener('play', () => {
    updatePlayButtonLabel(true);
  });

  video.addEventListener('pause', () => {
    updatePlayButtonLabel(false);
    stopRangePreview();
  });

  video.addEventListener('ended', () => {
    updatePlayButtonLabel(false);
    stopRangePreview();
  });

  video.addEventListener('timeupdate', () => {
    const source = store.getState().source;
    if (!source) {
      return;
    }
    let current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    if (activeRange && current >= activeRange.endSec) {
      current = activeRange.endSec;
      stopRangePreview();
      video.pause();
      video.currentTime = current;
    }
    store.dispatch({ type: ACTIONS.SET_PLAYHEAD, payload: current });
    syncSeekBarToTime(current, source.durationSec);
  });

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      togglePreviewPlayback();
    });
  }

  if (seekBar) {
    seekBar.addEventListener('pointerdown', () => {
      isUserSeeking = true;
    });
    seekBar.addEventListener('pointerup', () => {
      isUserSeeking = false;
    });
    seekBar.addEventListener('pointercancel', () => {
      isUserSeeking = false;
    });
    seekBar.addEventListener('input', () => {
      const source = store.getState().source;
      if (!source || source.durationSec <= 0) {
        return;
      }
      const ratio = Number(seekBar.value) / SEEK_SLIDER_STEPS;
      const targetSec = ratio * source.durationSec;
      if (previewRefs.currentTime) {
        previewRefs.currentTime.textContent = formatSafeTime(targetSec);
      }
    });
    seekBar.addEventListener('change', () => {
      isUserSeeking = false;
      const source = store.getState().source;
      if (!source || source.durationSec <= 0) {
        return;
      }
      const ratio = Number(seekBar.value) / SEEK_SLIDER_STEPS;
      seekPreviewTo(ratio * source.durationSec);
    });
  }

  setPreviewIdle();
  return ok(true);
}
