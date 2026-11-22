/* Stage 4 module: interactive timeline rendering, seek, zoom, pan, and touch pinch-zoom. */

import { ACTIONS, store } from './store.js';
import { ERROR_CODES, fail, ok } from './errors.js';
import { clamp, formatTimestamp } from './time.js';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;
export const ZOOM_STEP_FACTOR = 1.5;

const TICK_INTERVALS_SEC = Object.freeze([
  0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600
]);
const MIN_TICK_SPACING_PX = 84;
const PAN_VIEWPORT_FRACTION = 0.5;

let tlRefs = null;
let tlCallbacks = null;
let tlInitialized = false;
let resizeObserver = null;
let activePointers = new Map();
let isScrubbing = false;
let scrubPointerId = null;
let pinchState = null;

function roundMs(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

function formatTickLabel(seconds) {
  const res = formatTimestamp(Math.max(0, seconds));
  if (!res.ok) {
    return '00:00';
  }
  const full = res.value;
  if (seconds < 3600) {
    const body = full.slice(3, 8);
    const ms = full.slice(9);
    return ms === '000' ? body : `${body}.${ms.slice(0, 1)}`;
  }
  return full.slice(0, 8);
}

export function clampZoom(zoom) {
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Timeline zoom must be a finite number.');
  }
  const clamped = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  if (!clamped.ok) {
    return clamped;
  }
  return ok(Math.round(clamped.value * 100) / 100);
}

export function computeTimelineMetrics(durationSec, zoom, viewportWidthPx) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Timeline requires a positive video duration.');
  }
  if (typeof viewportWidthPx !== 'number' || !Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Timeline viewport width must be positive.');
  }
  const zoomRes = clampZoom(zoom);
  if (!zoomRes.ok) {
    return zoomRes;
  }
  const safeZoom = zoomRes.value;
  const trackWidthPx = Math.max(viewportWidthPx, Math.round(viewportWidthPx * safeZoom));
  const pixelsPerSec = trackWidthPx / durationSec;

  return ok({
    zoom: safeZoom,
    viewportWidthPx,
    trackWidthPx,
    pixelsPerSec
  });
}

export function timeToX(timeSec, durationSec, trackWidthPx) {
  if (
    typeof timeSec !== 'number' ||
    !Number.isFinite(timeSec) ||
    typeof durationSec !== 'number' ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    typeof trackWidthPx !== 'number' ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Invalid inputs for timeline timeToX conversion.');
  }
  const clamped = clamp(timeSec, 0, durationSec);
  if (!clamped.ok) {
    return clamped;
  }
  return ok((clamped.value / durationSec) * trackWidthPx);
}

export function xToTime(xPx, durationSec, trackWidthPx) {
  if (
    typeof xPx !== 'number' ||
    !Number.isFinite(xPx) ||
    typeof durationSec !== 'number' ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    typeof trackWidthPx !== 'number' ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Invalid inputs for timeline xToTime conversion.');
  }
  const ratioRes = clamp(xPx / trackWidthPx, 0, 1);
  if (!ratioRes.ok) {
    return ratioRes;
  }
  return ok(roundMs(ratioRes.value * durationSec));
}

export function computeScrollLeftForPlayhead(playheadSec, durationSec, trackWidthPx, viewportWidthPx) {
  const xRes = timeToX(playheadSec, durationSec, trackWidthPx);
  if (!xRes.ok) {
    return xRes;
  }
  if (typeof viewportWidthPx !== 'number' || !Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Viewport width must be positive.');
  }
  const maxScroll = Math.max(0, trackWidthPx - viewportWidthPx);
  const desired = xRes.value - viewportWidthPx * 0.5;
  const clamped = clamp(desired, 0, maxScroll);
  return clamped.ok ? ok(Math.round(clamped.value)) : clamped;
}

export function computeTickInterval(durationSec, pixelsPerSec) {
  if (
    typeof durationSec !== 'number' ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    typeof pixelsPerSec !== 'number' ||
    !Number.isFinite(pixelsPerSec) ||
    pixelsPerSec <= 0
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Invalid timeline tick interval inputs.');
  }
  for (const interval of TICK_INTERVALS_SEC) {
    if (interval * pixelsPerSec >= MIN_TICK_SPACING_PX) {
      return ok(interval);
    }
  }
  return ok(TICK_INTERVALS_SEC[TICK_INTERVALS_SEC.length - 1]);
}

export function computePinchZoom(initialZoom, startDistance, currentDistance) {
  if (
    typeof startDistance !== 'number' ||
    !Number.isFinite(startDistance) ||
    startDistance <= 0 ||
    typeof currentDistance !== 'number' ||
    !Number.isFinite(currentDistance) ||
    currentDistance <= 0
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Pinch distances must be positive numbers.');
  }
  const baseRes = clampZoom(initialZoom);
  if (!baseRes.ok) {
    return baseRes;
  }
  const scale = currentDistance / startDistance;
  return clampZoom(baseRes.value * scale);
}

function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function getViewportWidth() {
  if (!tlRefs || !tlRefs.viewport) {
    return 0;
  }
  return Math.max(tlRefs.viewport.clientWidth, 1);
}

function getCurrentMetrics(state) {
  if (!state.source || state.source.durationSec <= 0) {
    return null;
  }
  const width = getViewportWidth();
  const res = computeTimelineMetrics(state.source.durationSec, state.ui.zoom, width);
  return res.ok ? res.value : null;
}

function renderRuler(rulerEl, durationSec, metrics) {
  if (!rulerEl) {
    return;
  }
  clearChildren(rulerEl);
  const stepRes = computeTickInterval(durationSec, metrics.pixelsPerSec);
  if (!stepRes.ok) {
    return;
  }
  const step = stepRes.value;
  const maxTicks = 400;
  let count = 0;

  for (let sec = 0; sec <= durationSec + 0.0001 && count < maxTicks; sec += step) {
    const clampedSec = Math.min(sec, durationSec);
    const xRes = timeToX(clampedSec, durationSec, metrics.trackWidthPx);
    if (!xRes.ok) {
      continue;
    }
    const tick = document.createElement('span');
    tick.className = 'tl-tick';
    tick.style.left = `${xRes.value}px`;
    tick.textContent = formatTickLabel(clampedSec);
    rulerEl.appendChild(tick);
    count += 1;
  }
}

function renderDraftRange(draftBarEl, draft, durationSec, trackWidthPx) {
  if (!draftBarEl) {
    return;
  }
  if (!draft || draft.endSec <= draft.startSec) {
    draftBarEl.hidden = true;
    return;
  }
  const startRes = timeToX(draft.startSec, durationSec, trackWidthPx);
  const endRes = timeToX(draft.endSec, durationSec, trackWidthPx);
  if (!startRes.ok || !endRes.ok) {
    draftBarEl.hidden = true;
    return;
  }
  const widthPx = Math.max(3, endRes.value - startRes.value);
  draftBarEl.style.left = `${startRes.value}px`;
  draftBarEl.style.width = `${widthPx}px`;
  draftBarEl.hidden = false;
}

function renderClipBars(layerEl, clips, selectedClipId, durationSec, trackWidthPx) {
  if (!layerEl) {
    return;
  }
  clearChildren(layerEl);

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const startRes = timeToX(clip.startSec, durationSec, trackWidthPx);
    const endRes = timeToX(clip.endSec, durationSec, trackWidthPx);
    if (!startRes.ok || !endRes.ok) {
      continue;
    }

    const widthPx = Math.max(6, endRes.value - startRes.value);
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = clip.id === selectedClipId ? 'tl-clip tl-clip--selected' : 'tl-clip';
    bar.style.left = `${startRes.value}px`;
    bar.style.width = `${widthPx}px`;
    bar.dataset.tlClipId = clip.id;
    bar.setAttribute('aria-pressed', clip.id === selectedClipId ? 'true' : 'false');

    const startLabel = formatTimestamp(clip.startSec);
    const endLabel = formatTimestamp(clip.endSec);
    const rangeText = `${startLabel.ok ? startLabel.value : '00:00:00.000'} to ${endLabel.ok ? endLabel.value : '00:00:00.000'}`;
    bar.setAttribute('aria-label', `Select ${clip.name}, ${rangeText}`);
    bar.title = `${clip.name} (${rangeText})`;

    const textEl = document.createElement('span');
    textEl.className = 'tl-clip__label';
    textEl.textContent = clip.name;
    bar.appendChild(textEl);

    layerEl.appendChild(bar);
  }
}

function updateTrackAria(state) {
  if (!tlRefs || !tlRefs.track) {
    return;
  }
  const duration = state.source ? state.source.durationSec : 0;
  const playhead = Math.min(state.playheadSec, duration);
  const formatted = formatTimestamp(playhead);
  tlRefs.track.setAttribute('aria-valuemin', '0');
  tlRefs.track.setAttribute('aria-valuemax', String(roundMs(duration)));
  tlRefs.track.setAttribute('aria-valuenow', String(roundMs(playhead)));
  tlRefs.track.setAttribute('aria-valuetext', formatted.ok ? formatted.value : '00:00:00.000');
}

export function updateTimelinePlayhead(state) {
  if (!tlRefs || !tlRefs.playhead) {
    return;
  }
  const metrics = getCurrentMetrics(state);
  if (!metrics) {
    tlRefs.playhead.hidden = true;
    updateTrackAria(state);
    return;
  }
  const xRes = timeToX(state.playheadSec, state.source.durationSec, metrics.trackWidthPx);
  if (!xRes.ok) {
    return;
  }
  tlRefs.playhead.style.left = `${xRes.value}px`;
  tlRefs.playhead.hidden = false;
  updateTrackAria(state);

  if (tlRefs.viewport && metrics.zoom > 1 && !isScrubbing) {
    const viewLeft = tlRefs.viewport.scrollLeft;
    const viewRight = viewLeft + metrics.viewportWidthPx;
    if (xRes.value < viewLeft + 24 || xRes.value > viewRight - 24) {
      const scrollRes = computeScrollLeftForPlayhead(
        state.playheadSec,
        state.source.durationSec,
        metrics.trackWidthPx,
        metrics.viewportWidthPx
      );
      if (scrollRes.ok) {
        tlRefs.viewport.scrollLeft = scrollRes.value;
      }
    }
  }
}

export function renderTimeline(state, keepPlayheadCentered = false) {
  if (!tlRefs) {
    return;
  }
  const hasSource = Boolean(state.source && state.source.durationSec > 0);
  const zoom = state.ui.zoom || MIN_ZOOM;

  if (tlRefs.zoomOutBtn) {
    tlRefs.zoomOutBtn.disabled = !hasSource || zoom <= MIN_ZOOM;
  }
  if (tlRefs.zoomInBtn) {
    tlRefs.zoomInBtn.disabled = !hasSource || zoom >= MAX_ZOOM;
  }
  if (tlRefs.zoomResetBtn) {
    tlRefs.zoomResetBtn.disabled = !hasSource || zoom === MIN_ZOOM;
    tlRefs.zoomResetBtn.textContent = `${zoom.toFixed(1)}× Reset`;
  }
  if (tlRefs.panLeftBtn) {
    tlRefs.panLeftBtn.disabled = !hasSource || zoom <= MIN_ZOOM;
  }
  if (tlRefs.panRightBtn) {
    tlRefs.panRightBtn.disabled = !hasSource || zoom <= MIN_ZOOM;
  }
  if (tlRefs.emptyHint) {
    tlRefs.emptyHint.hidden = hasSource;
  }

  if (!hasSource) {
    if (tlRefs.track) {
      tlRefs.track.style.width = '100%';
    }
    if (tlRefs.ruler) {
      clearChildren(tlRefs.ruler);
    }
    if (tlRefs.clipsLayer) {
      clearChildren(tlRefs.clipsLayer);
    }
    if (tlRefs.draftBar) {
      tlRefs.draftBar.hidden = true;
    }
    if (tlRefs.playhead) {
      tlRefs.playhead.hidden = true;
    }
    updateTrackAria(state);
    return;
  }

  const metrics = getCurrentMetrics(state);
  if (!metrics) {
    return;
  }

  if (tlRefs.track) {
    tlRefs.track.style.width = `${metrics.trackWidthPx}px`;
  }

  renderRuler(tlRefs.ruler, state.source.durationSec, metrics);
  renderDraftRange(tlRefs.draftBar, state.draft, state.source.durationSec, metrics.trackWidthPx);
  renderClipBars(tlRefs.clipsLayer, state.clips, state.selectedClipId, state.source.durationSec, metrics.trackWidthPx);

  if (keepPlayheadCentered && tlRefs.viewport) {
    const scrollRes = computeScrollLeftForPlayhead(
      state.playheadSec,
      state.source.durationSec,
      metrics.trackWidthPx,
      metrics.viewportWidthPx
    );
    if (scrollRes.ok) {
      tlRefs.viewport.scrollLeft = scrollRes.value;
    }
  }

  updateTimelinePlayhead(state);
}

export function setTimelineZoom(nextZoom, targetStore = store) {
  const zoomRes = clampZoom(nextZoom);
  if (!zoomRes.ok) {
    return zoomRes;
  }
  const dispatchRes = targetStore.dispatch({ type: ACTIONS.SET_UI_ZOOM, payload: zoomRes.value });
  if (!dispatchRes.ok) {
    return dispatchRes;
  }
  renderTimeline(targetStore.getState(), true);
  return ok(zoomRes.value);
}

function seekFromClientX(clientX) {
  const state = store.getState();
  if (!state.source || !tlRefs || !tlRefs.track) {
    return;
  }
  const rect = tlRefs.track.getBoundingClientRect();
  if (rect.width <= 0) {
    return;
  }
  const localX = clientX - rect.left;
  const timeRes = xToTime(localX, state.source.durationSec, rect.width);
  if (!timeRes.ok) {
    return;
  }
  if (tlCallbacks && typeof tlCallbacks.onSeek === 'function') {
    tlCallbacks.onSeek(timeRes.value);
  }
}

function getTwoPointerDistance() {
  const points = Array.from(activePointers.values());
  if (points.length < 2) {
    return 0;
  }
  const dx = points[0].x - points[1].x;
  const dy = points[0].y - points[1].y;
  return Math.hypot(dx, dy);
}

function panViewport(direction) {
  if (!tlRefs || !tlRefs.viewport) {
    return;
  }
  const stepPx = Math.max(80, Math.round(tlRefs.viewport.clientWidth * PAN_VIEWPORT_FRACTION));
  tlRefs.viewport.scrollLeft += direction * stepPx;
}

export function initTimeline(refs, callbacks = {}) {
  if (!refs || !refs.viewport || !refs.track) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing timeline DOM elements.');
  }
  if (tlInitialized) {
    return ok(true);
  }
  tlInitialized = true;
  tlRefs = refs;
  tlCallbacks = callbacks;

  if (refs.zoomInBtn) {
    refs.zoomInBtn.addEventListener('click', () => {
      const current = store.getState().ui.zoom || MIN_ZOOM;
      setTimelineZoom(current * ZOOM_STEP_FACTOR);
    });
  }

  if (refs.zoomOutBtn) {
    refs.zoomOutBtn.addEventListener('click', () => {
      const current = store.getState().ui.zoom || MIN_ZOOM;
      setTimelineZoom(current / ZOOM_STEP_FACTOR);
    });
  }

  if (refs.zoomResetBtn) {
    refs.zoomResetBtn.addEventListener('click', () => {
      setTimelineZoom(MIN_ZOOM);
    });
  }

  if (refs.panLeftBtn) {
    refs.panLeftBtn.addEventListener('click', () => panViewport(-1));
  }

  if (refs.panRightBtn) {
    refs.panRightBtn.addEventListener('click', () => panViewport(1));
  }

  /* Delegated clip click on timeline clips layer */
  if (refs.clipsLayer) {
    refs.clipsLayer.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-tl-clip-id]') : null;
      if (!target) {
        return;
      }
      event.stopPropagation();
      const clipId = target.dataset.tlClipId;
      if (clipId && tlCallbacks && typeof tlCallbacks.onSelectClip === 'function') {
        tlCallbacks.onSelectClip(clipId);
      }
    });
  }

  /* Pointer events on timeline track: single-pointer seek, two-pointer pinch zoom */
  refs.track.addEventListener('pointerdown', (event) => {
    const state = store.getState();
    if (!state.source) {
      return;
    }
    const clickedClip = event.target instanceof Element ? event.target.closest('[data-tl-clip-id]') : null;
    if (clickedClip && activePointers.size === 0) {
      return;
    }

    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size === 2) {
      isScrubbing = false;
      scrubPointerId = null;
      const dist = getTwoPointerDistance();
      if (dist > 4) {
        pinchState = {
          startDistance: dist,
          initialZoom: state.ui.zoom || MIN_ZOOM
        };
      }
      return;
    }

    if (activePointers.size === 1) {
      isScrubbing = true;
      scrubPointerId = event.pointerId;
      if (typeof refs.track.setPointerCapture === 'function') {
        try {
          refs.track.setPointerCapture(event.pointerId);
        } catch {
          /* Ignore pointer capture errors on synthetic events. */
        }
      }
      seekFromClientX(event.clientX);
    }
  });

  refs.track.addEventListener('pointermove', (event) => {
    if (!activePointers.has(event.pointerId)) {
      return;
    }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size >= 2 && pinchState) {
      const dist = getTwoPointerDistance();
      const zoomRes = computePinchZoom(pinchState.initialZoom, pinchState.startDistance, dist);
      if (zoomRes.ok) {
        setTimelineZoom(zoomRes.value);
      }
      return;
    }

    if (isScrubbing && scrubPointerId === event.pointerId) {
      seekFromClientX(event.clientX);
    }
  });

  const endPointer = (event) => {
    activePointers.delete(event.pointerId);
    if (scrubPointerId === event.pointerId) {
      isScrubbing = false;
      scrubPointerId = null;
      if (typeof refs.track.hasPointerCapture === 'function' && refs.track.hasPointerCapture(event.pointerId)) {
        try {
          refs.track.releasePointerCapture(event.pointerId);
        } catch {
          /* Ignore release errors. */
        }
      }
    }
    if (activePointers.size < 2) {
      pinchState = null;
    }
  };

  refs.track.addEventListener('pointerup', endPointer);
  refs.track.addEventListener('pointercancel', endPointer);

  /* Wheel: Ctrl/Meta + wheel zooms; Shift + wheel or horizontal trackpad pans */
  refs.viewport.addEventListener('wheel', (event) => {
    const state = store.getState();
    if (!state.source) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const current = state.ui.zoom || MIN_ZOOM;
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      setTimelineZoom(current * factor);
      return;
    }
    if (event.shiftKey && event.deltaY !== 0) {
      event.preventDefault();
      refs.viewport.scrollLeft += event.deltaY;
    }
  }, { passive: false });

  /* Track responsive resize cleanly */
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      renderTimeline(store.getState(), false);
    });
    resizeObserver.observe(refs.viewport);
  } else {
    window.addEventListener('resize', () => {
      renderTimeline(store.getState(), false);
    });
  }

  renderTimeline(store.getState(), false);
  return ok(true);
}
