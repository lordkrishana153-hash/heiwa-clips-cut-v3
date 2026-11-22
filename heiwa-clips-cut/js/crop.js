/* Stage 5 module: single source of crop/reframe math shared by preview overlay and Stage 6 export. */

import { ACTIONS, store } from './store.js';
import { ERROR_CODES, fail, notifyToast, ok } from './errors.js';
import { clamp } from './time.js';

export const CROP_RATIOS = Object.freeze(['orig', '9:16', '16:9', '1:1', '4:5']);
export const CROP_FITS = Object.freeze(['fill', 'fit']);
export const CROP_BACKGROUNDS = Object.freeze(['none', 'blur']);
export const MIN_CROP_ZOOM = 1;
export const MAX_CROP_ZOOM = 4;

export const DEFAULT_CROP = Object.freeze({
  ratio: 'orig',
  zoom: 1,
  panX: 0.5,
  panY: 0.5,
  fit: 'fill',
  background: 'none'
});

const RATIO_VALUES = Object.freeze({
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5
});

const KEYBOARD_PAN_STEP = 0.05;

let cachedBlurSupport = null;
let cropRefs = null;
let cropInitialized = false;
let previewFramedMode = false;
let liveDragCrop = null;
let dragState = null;
let framedRafId = null;
let stageResizeObserver = null;

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function makeEvenDimension(value, maxEven = null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 2;
  }
  let even = Math.round(value / 2) * 2;
  if (even < 2) {
    even = 2;
  }
  if (typeof maxEven === 'number' && Number.isFinite(maxEven) && maxEven >= 2) {
    const cap = Math.max(2, Math.floor(maxEven / 2) * 2);
    if (even > cap) {
      even = cap;
    }
  }
  return even;
}

export function normalizeCrop(crop) {
  const input = crop && typeof crop === 'object' ? crop : DEFAULT_CROP;
  const ratio = CROP_RATIOS.includes(input.ratio) ? input.ratio : DEFAULT_CROP.ratio;
  const fit = CROP_FITS.includes(input.fit) ? input.fit : DEFAULT_CROP.fit;
  const background = CROP_BACKGROUNDS.includes(input.background)
    ? input.background
    : DEFAULT_CROP.background;

  const zoomRaw = typeof input.zoom === 'number' && Number.isFinite(input.zoom)
    ? input.zoom
    : DEFAULT_CROP.zoom;
  const panXRaw = typeof input.panX === 'number' && Number.isFinite(input.panX)
    ? input.panX
    : DEFAULT_CROP.panX;
  const panYRaw = typeof input.panY === 'number' && Number.isFinite(input.panY)
    ? input.panY
    : DEFAULT_CROP.panY;

  const zoomClamped = clamp(zoomRaw, MIN_CROP_ZOOM, MAX_CROP_ZOOM);
  const panXClamped = clamp(panXRaw, 0, 1);
  const panYClamped = clamp(panYRaw, 0, 1);

  return ok({
    ratio,
    zoom: round4(zoomClamped.ok ? zoomClamped.value : DEFAULT_CROP.zoom),
    panX: round4(panXClamped.ok ? panXClamped.value : DEFAULT_CROP.panX),
    panY: round4(panYClamped.ok ? panYClamped.value : DEFAULT_CROP.panY),
    fit,
    background: fit === 'fit' ? background : 'none'
  });
}

export function isCropDefault(crop) {
  const norm = normalizeCrop(crop).value;
  return (
    norm.ratio === 'orig' &&
    norm.zoom === 1 &&
    norm.panX === 0.5 &&
    norm.panY === 0.5 &&
    norm.fit === 'fill' &&
    norm.background === 'none'
  );
}

export function getTargetAspect(ratio, sourceWidth, sourceHeight) {
  if (
    typeof sourceWidth !== 'number' ||
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    typeof sourceHeight !== 'number' ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0
  ) {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'Source video dimensions must be positive numbers.');
  }
  if (ratio === 'orig') {
    return ok(sourceWidth / sourceHeight);
  }
  if (Object.prototype.hasOwnProperty.call(RATIO_VALUES, ratio)) {
    return ok(RATIO_VALUES[ratio]);
  }
  return fail(ERROR_CODES.E_RANGE_INVALID, `Unsupported crop aspect ratio: ${String(ratio)}`);
}

function computeCoverSourceRect(sourceWidth, sourceHeight, targetAspect, zoom, panX, panY) {
  const sourceAspect = sourceWidth / sourceHeight;
  let baseW = sourceWidth;
  let baseH = sourceHeight;

  if (sourceAspect > targetAspect) {
    baseH = sourceHeight;
    baseW = sourceHeight * targetAspect;
  } else {
    baseW = sourceWidth;
    baseH = sourceWidth / targetAspect;
  }

  const width = Math.min(sourceWidth, baseW / zoom);
  const height = Math.min(sourceHeight, baseH / zoom);
  const maxX = Math.max(0, sourceWidth - width);
  const maxY = Math.max(0, sourceHeight - height);

  return {
    x: round4(maxX * panX),
    y: round4(maxY * panY),
    width: round4(width),
    height: round4(height)
  };
}

export function computeCropPlan(sourceWidth, sourceHeight, crop, maxSide = 1080) {
  const aspectRes = getTargetAspect(
    crop && typeof crop === 'object' && CROP_RATIOS.includes(crop.ratio) ? crop.ratio : 'orig',
    sourceWidth,
    sourceHeight
  );
  if (!aspectRes.ok) {
    return aspectRes;
  }
  if (maxSide !== null && (typeof maxSide !== 'number' || !Number.isFinite(maxSide) || maxSide < 2)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'maxSide must be a finite number >= 2 or null.');
  }

  const norm = normalizeCrop(crop).value;
  const desiredAspect = aspectRes.value;
  const srcLong = Math.max(sourceWidth, sourceHeight);
  const effectiveMaxSide = maxSide === null ? srcLong : Math.min(maxSide, Math.max(srcLong, 2));
  const evenCap = Math.max(2, Math.floor(effectiveMaxSide / 2) * 2);

  let outputWidth = 2;
  let outputHeight = 2;

  if (desiredAspect >= 1) {
    outputWidth = makeEvenDimension(effectiveMaxSide, evenCap);
    outputHeight = makeEvenDimension(outputWidth / desiredAspect, evenCap);
  } else {
    outputHeight = makeEvenDimension(effectiveMaxSide, evenCap);
    outputWidth = makeEvenDimension(outputHeight * desiredAspect, evenCap);
  }

  const outputAspect = outputWidth / outputHeight;
  let sourceRect;
  let destRect;
  let bgSourceRect = null;

  if (norm.fit === 'fit') {
    const srcW = sourceWidth / norm.zoom;
    const srcH = sourceHeight / norm.zoom;
    const srcX = Math.max(0, sourceWidth - srcW) * norm.panX;
    const srcY = Math.max(0, sourceHeight - srcH) * norm.panY;
    sourceRect = {
      x: round4(srcX),
      y: round4(srcY),
      width: round4(srcW),
      height: round4(srcH)
    };

    const fitScale = Math.min(outputWidth / srcW, outputHeight / srcH);
    const destW = srcW * fitScale;
    const destH = srcH * fitScale;
    destRect = {
      x: round4((outputWidth - destW) / 2),
      y: round4((outputHeight - destH) / 2),
      width: round4(destW),
      height: round4(destH)
    };
    bgSourceRect = computeCoverSourceRect(sourceWidth, sourceHeight, outputAspect, 1, 0.5, 0.5);
  } else {
    sourceRect = computeCoverSourceRect(
      sourceWidth,
      sourceHeight,
      outputAspect,
      norm.zoom,
      norm.panX,
      norm.panY
    );
    destRect = {
      x: 0,
      y: 0,
      width: outputWidth,
      height: outputHeight
    };
  }

  const overlayNorm = {
    x: round4(sourceRect.x / sourceWidth),
    y: round4(sourceRect.y / sourceHeight),
    width: round4(sourceRect.width / sourceWidth),
    height: round4(sourceRect.height / sourceHeight)
  };

  return ok({
    outputWidth,
    outputHeight,
    targetAspect: round4(outputAspect),
    crop: norm,
    sourceRect,
    destRect,
    bgSourceRect,
    overlayNorm
  });
}

export function computeVideoContentRect(stageWidth, stageHeight, videoWidth, videoHeight) {
  if (
    typeof stageWidth !== 'number' ||
    !Number.isFinite(stageWidth) ||
    stageWidth <= 0 ||
    typeof stageHeight !== 'number' ||
    !Number.isFinite(stageHeight) ||
    stageHeight <= 0 ||
    typeof videoWidth !== 'number' ||
    !Number.isFinite(videoWidth) ||
    videoWidth <= 0 ||
    typeof videoHeight !== 'number' ||
    !Number.isFinite(videoHeight) ||
    videoHeight <= 0
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Stage and video dimensions must be positive numbers.');
  }

  const scale = Math.min(stageWidth / videoWidth, stageHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return ok({
    x: round4((stageWidth - width) / 2),
    y: round4((stageHeight - height) / 2),
    width: round4(width),
    height: round4(height)
  });
}

export function computePanFromDrag(plan, startCrop, deltaXPx, deltaYPx, contentWidthPx, contentHeightPx) {
  if (!plan || !startCrop || contentWidthPx <= 0 || contentHeightPx <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Invalid drag framing parameters.');
  }
  const slackXNorm = 1 - plan.overlayNorm.width;
  const slackYNorm = 1 - plan.overlayNorm.height;

  let nextPanX = startCrop.panX;
  let nextPanY = startCrop.panY;

  if (slackXNorm > 0.0001) {
    const deltaNormX = deltaXPx / (contentWidthPx * slackXNorm);
    const clampedX = clamp(startCrop.panX + deltaNormX, 0, 1);
    nextPanX = clampedX.ok ? round4(clampedX.value) : startCrop.panX;
  }

  if (slackYNorm > 0.0001) {
    const deltaNormY = deltaYPx / (contentHeightPx * slackYNorm);
    const clampedY = clamp(startCrop.panY + deltaNormY, 0, 1);
    nextPanY = clampedY.ok ? round4(clampedY.value) : startCrop.panY;
  }

  return ok({ panX: nextPanX, panY: nextPanY });
}

export function detectCanvasBlurSupport() {
  if (cachedBlurSupport !== null) {
    return cachedBlurSupport;
  }
  if (typeof document === 'undefined') {
    cachedBlurSupport = false;
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !('filter' in ctx)) {
      cachedBlurSupport = false;
      return false;
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 16, 16);
    ctx.filter = 'blur(4px)';
    if (ctx.filter !== 'blur(4px)') {
      cachedBlurSupport = false;
      return false;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(7, 7, 2, 2);
    const sample = ctx.getImageData(4, 7, 1, 1).data;
    cachedBlurSupport = sample[0] > 0;
    return cachedBlurSupport;
  } catch {
    cachedBlurSupport = false;
    return false;
  }
}

export function drawFramedFrame(ctx, mediaSource, plan, options = {}) {
  if (!ctx || !mediaSource || !plan) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing canvas context, media source, or crop plan.');
  }
  const blurSupported = options.blurSupported !== undefined
    ? Boolean(options.blurSupported)
    : detectCanvasBlurSupport();
  const { outputWidth, outputHeight, crop, sourceRect, destRect, bgSourceRect } = plan;

  ctx.save();
  if ('filter' in ctx) {
    ctx.filter = 'none';
  }
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, outputWidth, outputHeight);

  if (crop.fit === 'fit' && crop.background === 'blur' && blurSupported && bgSourceRect) {
    const overscan = Math.max(16, Math.round(Math.max(outputWidth, outputHeight) * 0.03));
    ctx.save();
    if ('filter' in ctx) {
      ctx.filter = 'blur(16px)';
    }
    ctx.drawImage(
      mediaSource,
      bgSourceRect.x,
      bgSourceRect.y,
      bgSourceRect.width,
      bgSourceRect.height,
      -overscan,
      -overscan,
      outputWidth + overscan * 2,
      outputHeight + overscan * 2
    );
    ctx.restore();
  }

  if ('filter' in ctx) {
    ctx.filter = 'none';
  }
  ctx.drawImage(
    mediaSource,
    sourceRect.x,
    sourceRect.y,
    sourceRect.width,
    sourceRect.height,
    destRect.x,
    destRect.y,
    destRect.width,
    destRect.height
  );
  ctx.restore();
  return ok(true);
}

/* --- Store Mutation Helpers --- */

export function updateSelectedClipCrop(patch, targetStore = store) {
  const state = targetStore.getState();
  if (!state.selectedClipId) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Select a clip before editing crop settings.');
  }
  const clip = state.clips.find((c) => c.id === state.selectedClipId);
  if (!clip) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Selected clip was not found.');
  }
  const merged = normalizeCrop({ ...clip.crop, ...patch }).value;
  return targetStore.dispatch({
    type: ACTIONS.CLIP_UPDATE,
    payload: {
      id: clip.id,
      patch: { crop: merged }
    }
  });
}

export function resetSelectedClipCrop(targetStore = store) {
  return updateSelectedClipCrop({ ...DEFAULT_CROP }, targetStore);
}

export function applyCropToAllClips(crop, targetStore = store) {
  const state = targetStore.getState();
  if (state.clips.length === 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Add at least one clip before applying framing to all clips.');
  }
  const normalized = normalizeCrop(crop).value;
  const nextClips = state.clips.map((clip) => ({
    ...clip,
    crop: { ...normalized }
  }));
  return targetStore.dispatch({
    type: ACTIONS.CLIPS_SET,
    payload: nextClips
  });
}

/* --- DOM Rendering & Preview Overlay Wiring --- */

function getActiveClip(state) {
  if (!state.selectedClipId) {
    return null;
  }
  return state.clips.find((c) => c.id === state.selectedClipId) || null;
}

function getEffectiveCrop(state) {
  if (liveDragCrop) {
    return liveDragCrop;
  }
  const clip = getActiveClip(state);
  return clip ? normalizeCrop(clip.crop).value : { ...DEFAULT_CROP };
}

function stopFramedRenderLoop() {
  if (framedRafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(framedRafId);
    framedRafId = null;
  }
}

function renderFramedCanvasOnce(state) {
  if (!cropRefs || !cropRefs.framedCanvas || !cropRefs.video || !state.source) {
    return;
  }
  const video = cropRefs.video;
  if (video.readyState < 2) {
    return;
  }
  const crop = getEffectiveCrop(state);
  const maxSide = state.exportSettings ? state.exportSettings.maxSide : 1080;
  const planRes = computeCropPlan(state.source.width, state.source.height, crop, Math.min(maxSide, 720));
  if (!planRes.ok) {
    return;
  }
  const plan = planRes.value;
  const canvas = cropRefs.framedCanvas;
  if (canvas.width !== plan.outputWidth || canvas.height !== plan.outputHeight) {
    canvas.width = plan.outputWidth;
    canvas.height = plan.outputHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  drawFramedFrame(ctx, video, plan, { blurSupported: detectCanvasBlurSupport() });
}

function scheduleFramedLoop() {
  stopFramedRenderLoop();
  if (!previewFramedMode || !cropRefs || !cropRefs.video) {
    return;
  }
  const tick = () => {
    framedRafId = null;
    if (!previewFramedMode || !cropRefs || !cropRefs.video) {
      return;
    }
    const state = store.getState();
    renderFramedCanvasOnce(state);
    if (!cropRefs.video.paused && !cropRefs.video.ended && typeof requestAnimationFrame === 'function') {
      framedRafId = requestAnimationFrame(tick);
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    framedRafId = requestAnimationFrame(tick);
  } else {
    renderFramedCanvasOnce(store.getState());
  }
}

export function syncCropOverlay(state) {
  if (!cropRefs || !cropRefs.stage || !cropRefs.overlay || !cropRefs.cropBox) {
    return;
  }
  const clip = getActiveClip(state);
  const hasSource = Boolean(state.source);

  if (!hasSource || !clip) {
    cropRefs.overlay.hidden = true;
    if (cropRefs.framedCanvas) {
      cropRefs.framedCanvas.hidden = true;
    }
    if (cropRefs.video) {
      cropRefs.video.style.visibility = 'visible';
    }
    stopFramedRenderLoop();
    return;
  }

  const crop = getEffectiveCrop(state);
  const maxSide = state.exportSettings ? state.exportSettings.maxSide : 1080;
  const planRes = computeCropPlan(state.source.width, state.source.height, crop, maxSide);
  if (!planRes.ok) {
    cropRefs.overlay.hidden = true;
    return;
  }
  const plan = planRes.value;

  if (previewFramedMode && cropRefs.framedCanvas) {
    cropRefs.overlay.hidden = true;
    cropRefs.framedCanvas.hidden = false;
    if (cropRefs.video) {
      cropRefs.video.style.visibility = 'hidden';
    }
    renderFramedCanvasOnce(state);
    if (cropRefs.video && !cropRefs.video.paused && !cropRefs.video.ended) {
      scheduleFramedLoop();
    }
    return;
  }

  stopFramedRenderLoop();
  if (cropRefs.framedCanvas) {
    cropRefs.framedCanvas.hidden = true;
  }
  if (cropRefs.video) {
    cropRefs.video.style.visibility = 'visible';
  }

  const stageWidth = cropRefs.stage.clientWidth;
  const stageHeight = cropRefs.stage.clientHeight;
  const contentRes = computeVideoContentRect(
    stageWidth,
    stageHeight,
    state.source.width,
    state.source.height
  );
  if (!contentRes.ok) {
    cropRefs.overlay.hidden = true;
    return;
  }
  const content = contentRes.value;

  cropRefs.overlay.style.left = `${content.x}px`;
  cropRefs.overlay.style.top = `${content.y}px`;
  cropRefs.overlay.style.width = `${content.width}px`;
  cropRefs.overlay.style.height = `${content.height}px`;
  cropRefs.overlay.hidden = false;

  cropRefs.cropBox.style.left = `${plan.overlayNorm.x * 100}%`;
  cropRefs.cropBox.style.top = `${plan.overlayNorm.y * 100}%`;
  cropRefs.cropBox.style.width = `${plan.overlayNorm.width * 100}%`;
  cropRefs.cropBox.style.height = `${plan.overlayNorm.height * 100}%`;
}

function setToggleActive(btn, active) {
  if (!btn) {
    return;
  }
  btn.classList.toggle('btn--active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

export function renderCropPanel(state) {
  if (!cropRefs) {
    return;
  }
  const hasSource = Boolean(state.source);
  const clip = getActiveClip(state);
  const enabled = hasSource && Boolean(clip);
  const blurSupported = detectCanvasBlurSupport();
  const crop = getEffectiveCrop(state);

  if (cropRefs.targetBadge) {
    cropRefs.targetBadge.textContent = clip ? clip.name : 'Select a clip';
  }

  if (cropRefs.outputInfo) {
    if (enabled) {
      const maxSide = state.exportSettings ? state.exportSettings.maxSide : 1080;
      const planRes = computeCropPlan(state.source.width, state.source.height, crop, maxSide);
      if (planRes.ok) {
        const p = planRes.value;
        cropRefs.outputInfo.textContent = `${p.outputWidth} × ${p.outputHeight} • ${crop.ratio === 'orig' ? 'Original' : crop.ratio}`;
      }
    } else {
      cropRefs.outputInfo.textContent = hasSource
        ? 'Select or create a clip to edit crop & framing'
        : 'Open a video and add a clip';
    }
  }

  const ratioButtons = [
    [cropRefs.ratioOrigBtn, 'orig'],
    [cropRefs.ratio916Btn, '9:16'],
    [cropRefs.ratio169Btn, '16:9'],
    [cropRefs.ratio11Btn, '1:1'],
    [cropRefs.ratio45Btn, '4:5']
  ];
  for (const [btn, ratio] of ratioButtons) {
    if (btn) {
      btn.disabled = !enabled;
      setToggleActive(btn, enabled && crop.ratio === ratio);
    }
  }

  if (cropRefs.fitFillBtn) {
    cropRefs.fitFillBtn.disabled = !enabled;
    setToggleActive(cropRefs.fitFillBtn, enabled && crop.fit === 'fill');
  }
  if (cropRefs.fitContainBtn) {
    cropRefs.fitContainBtn.disabled = !enabled;
    setToggleActive(cropRefs.fitContainBtn, enabled && crop.fit === 'fit');
  }

  const bgEnabled = enabled && crop.fit === 'fit';
  if (cropRefs.bgNoneBtn) {
    cropRefs.bgNoneBtn.disabled = !bgEnabled;
    setToggleActive(cropRefs.bgNoneBtn, bgEnabled && crop.background === 'none');
  }
  if (cropRefs.bgBlurBtn) {
    cropRefs.bgBlurBtn.hidden = !blurSupported;
    cropRefs.bgBlurBtn.disabled = !bgEnabled || !blurSupported;
    setToggleActive(cropRefs.bgBlurBtn, bgEnabled && blurSupported && crop.background === 'blur');
  }
  if (cropRefs.blurNote) {
    cropRefs.blurNote.hidden = blurSupported;
  }

  if (cropRefs.zoomSlider) {
    cropRefs.zoomSlider.disabled = !enabled;
    if (!dragState) {
      cropRefs.zoomSlider.value = String(crop.zoom);
    }
  }
  if (cropRefs.zoomValue) {
    cropRefs.zoomValue.textContent = `${crop.zoom.toFixed(2)}×`;
  }
  if (cropRefs.panReadout) {
    const px = Math.round(crop.panX * 100);
    const py = Math.round(crop.panY * 100);
    cropRefs.panReadout.textContent = enabled
      ? `Position ${px}% × ${py}% — drag crop box on preview to reposition`
      : 'Position 50% × 50%';
  }

  if (cropRefs.previewModeBtn) {
    cropRefs.previewModeBtn.disabled = !enabled;
    cropRefs.previewModeBtn.textContent = previewFramedMode ? 'Show Crop Overlay' : 'Preview Framed Output';
    cropRefs.previewModeBtn.setAttribute('aria-pressed', previewFramedMode ? 'true' : 'false');
  }
  if (cropRefs.resetBtn) {
    cropRefs.resetBtn.disabled = !enabled || isCropDefault(crop);
  }
  if (cropRefs.applyAllBtn) {
    cropRefs.applyAllBtn.disabled = !enabled || state.clips.length < 2;
  }

  syncCropOverlay(state);
}

export function initCrop(refs) {
  if (!refs || !refs.stage || !refs.overlay || !refs.cropBox) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing crop DOM elements.');
  }
  if (cropInitialized) {
    return ok(true);
  }
  cropInitialized = true;
  cropRefs = refs;

  const wireRatio = (btn, ratio) => {
    if (!btn) {
      return;
    }
    btn.addEventListener('click', () => {
      liveDragCrop = null;
      updateSelectedClipCrop({ ratio });
    });
  };
  wireRatio(refs.ratioOrigBtn, 'orig');
  wireRatio(refs.ratio916Btn, '9:16');
  wireRatio(refs.ratio169Btn, '16:9');
  wireRatio(refs.ratio11Btn, '1:1');
  wireRatio(refs.ratio45Btn, '4:5');

  if (refs.fitFillBtn) {
    refs.fitFillBtn.addEventListener('click', () => {
      liveDragCrop = null;
      updateSelectedClipCrop({ fit: 'fill', background: 'none' });
    });
  }
  if (refs.fitContainBtn) {
    refs.fitContainBtn.addEventListener('click', () => {
      liveDragCrop = null;
      updateSelectedClipCrop({ fit: 'fit' });
    });
  }
  if (refs.bgNoneBtn) {
    refs.bgNoneBtn.addEventListener('click', () => {
      liveDragCrop = null;
      updateSelectedClipCrop({ fit: 'fit', background: 'none' });
    });
  }
  if (refs.bgBlurBtn) {
    refs.bgBlurBtn.addEventListener('click', () => {
      if (!detectCanvasBlurSupport()) {
        return;
      }
      liveDragCrop = null;
      updateSelectedClipCrop({ fit: 'fit', background: 'blur' });
    });
  }

  if (refs.zoomSlider) {
    refs.zoomSlider.addEventListener('input', () => {
      const state = store.getState();
      const clip = getActiveClip(state);
      if (!clip) {
        return;
      }
      const nextZoom = Number(refs.zoomSlider.value);
      liveDragCrop = normalizeCrop({ ...clip.crop, zoom: nextZoom }).value;
      renderCropPanel(state);
    });
    refs.zoomSlider.addEventListener('change', () => {
      const nextZoom = Number(refs.zoomSlider.value);
      liveDragCrop = null;
      updateSelectedClipCrop({ zoom: nextZoom });
    });
  }

  if (refs.previewModeBtn) {
    refs.previewModeBtn.addEventListener('click', () => {
      previewFramedMode = !previewFramedMode;
      renderCropPanel(store.getState());
    });
  }

  if (refs.resetBtn) {
    refs.resetBtn.addEventListener('click', () => {
      liveDragCrop = null;
      const res = resetSelectedClipCrop();
      if (res.ok) {
        notifyToast('Framing reset', 'Clip crop returned to original full frame.', 'info', 2200);
      }
    });
  }

  if (refs.applyAllBtn) {
    refs.applyAllBtn.addEventListener('click', () => {
      const state = store.getState();
      const clip = getActiveClip(state);
      if (!clip) {
        return;
      }
      liveDragCrop = null;
      const res = applyCropToAllClips(clip.crop);
      if (res.ok) {
        notifyToast(
          'Framing applied to all clips',
          `Updated ${state.clips.length} clips. Press Undo to revert in one step.`,
          'success',
          3000
        );
      }
    });
  }

  /* Drag-to-position directly on the crop box over the video stage */
  refs.cropBox.addEventListener('pointerdown', (event) => {
    const state = store.getState();
    const clip = getActiveClip(state);
    if (!state.source || !clip) {
      return;
    }
    const maxSide = state.exportSettings ? state.exportSettings.maxSide : 1080;
    const planRes = computeCropPlan(state.source.width, state.source.height, clip.crop, maxSide);
    if (!planRes.ok) {
      return;
    }
    const overlayRect = refs.overlay.getBoundingClientRect();
    if (overlayRect.width <= 0 || overlayRect.height <= 0) {
      return;
    }

    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: normalizeCrop(clip.crop).value,
      plan: planRes.value,
      contentWidth: overlayRect.width,
      contentHeight: overlayRect.height
    };
    liveDragCrop = { ...dragState.startCrop };
    refs.cropBox.classList.add('crop-box--dragging');

    if (typeof refs.cropBox.setPointerCapture === 'function') {
      try {
        refs.cropBox.setPointerCapture(event.pointerId);
      } catch {
        /* Ignore pointer capture errors on synthetic events. */
      }
    }
  });

  refs.cropBox.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const panRes = computePanFromDrag(
      dragState.plan,
      dragState.startCrop,
      dx,
      dy,
      dragState.contentWidth,
      dragState.contentHeight
    );
    if (!panRes.ok) {
      return;
    }
    liveDragCrop = {
      ...dragState.startCrop,
      panX: panRes.value.panX,
      panY: panRes.value.panY
    };
    renderCropPanel(store.getState());
  });

  const finishDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const committed = liveDragCrop;
    const changed = committed && (
      committed.panX !== dragState.startCrop.panX ||
      committed.panY !== dragState.startCrop.panY
    );
    dragState = null;
    liveDragCrop = null;
    refs.cropBox.classList.remove('crop-box--dragging');

    if (typeof refs.cropBox.hasPointerCapture === 'function' && refs.cropBox.hasPointerCapture(event.pointerId)) {
      try {
        refs.cropBox.releasePointerCapture(event.pointerId);
      } catch {
        /* Ignore pointer release errors. */
      }
    }

    if (changed) {
      updateSelectedClipCrop({ panX: committed.panX, panY: committed.panY });
    } else {
      renderCropPanel(store.getState());
    }
  };

  refs.cropBox.addEventListener('pointerup', finishDrag);
  refs.cropBox.addEventListener('pointercancel', finishDrag);

  /* Accessible arrow-key nudging when crop box has keyboard focus */
  refs.cropBox.addEventListener('keydown', (event) => {
    const state = store.getState();
    const clip = getActiveClip(state);
    if (!clip) {
      return;
    }
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') {
      dx = -KEYBOARD_PAN_STEP;
    } else if (event.key === 'ArrowRight') {
      dx = KEYBOARD_PAN_STEP;
    } else if (event.key === 'ArrowUp') {
      dy = -KEYBOARD_PAN_STEP;
    } else if (event.key === 'ArrowDown') {
      dy = KEYBOARD_PAN_STEP;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const norm = normalizeCrop(clip.crop).value;
    const nextX = clamp(norm.panX + dx, 0, 1);
    const nextY = clamp(norm.panY + dy, 0, 1);
    updateSelectedClipCrop({
      panX: nextX.ok ? round4(nextX.value) : norm.panX,
      panY: nextY.ok ? round4(nextY.value) : norm.panY
    });
  });

  /* Keep framed canvas preview in sync with <video> playback and seeking */
  if (refs.video) {
    refs.video.addEventListener('play', () => {
      if (previewFramedMode) {
        scheduleFramedLoop();
      }
    });
    refs.video.addEventListener('pause', () => {
      stopFramedRenderLoop();
      if (previewFramedMode) {
        renderFramedCanvasOnce(store.getState());
      }
    });
    refs.video.addEventListener('seeked', () => {
      if (previewFramedMode) {
        renderFramedCanvasOnce(store.getState());
      }
    });
    refs.video.addEventListener('loadeddata', () => {
      syncCropOverlay(store.getState());
    });
  }

  if (typeof ResizeObserver === 'function') {
    stageResizeObserver = new ResizeObserver(() => {
      syncCropOverlay(store.getState());
    });
    stageResizeObserver.observe(refs.stage);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      syncCropOverlay(store.getState());
    });
  }

  renderCropPanel(store.getState());
  return ok(true);
}
