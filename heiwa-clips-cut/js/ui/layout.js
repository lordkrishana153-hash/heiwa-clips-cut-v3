/* Stage 4 UI module: responsive viewport classification, layout mode syncing, and live status announcements. */

import { ERROR_CODES, fail, ok } from '../errors.js';

export const TABLET_MIN_WIDTH = 640;
export const DESKTOP_MIN_WIDTH = 1024;

let layoutRefs = null;
let layoutInitialized = false;

export function classifyViewportWidth(widthPx) {
  if (typeof widthPx !== 'number' || !Number.isFinite(widthPx) || widthPx <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Viewport width must be a positive number.');
  }
  if (widthPx >= DESKTOP_MIN_WIDTH) {
    return ok('desktop');
  }
  if (widthPx >= TABLET_MIN_WIDTH) {
    return ok('tablet');
  }
  return ok('mobile');
}

export function applyLayoutMode(shellEl, widthPx) {
  if (!shellEl) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Workspace shell element is required.');
  }
  const modeRes = classifyViewportWidth(widthPx);
  if (!modeRes.ok) {
    return modeRes;
  }
  shellEl.dataset.layoutMode = modeRes.value;
  return modeRes;
}

export function syncUiStatusAttribute(shellEl, status) {
  if (!shellEl || typeof status !== 'string') {
    return;
  }
  shellEl.dataset.uiStatus = status;
}

export function announceStatus(liveRegionEl, message) {
  if (!liveRegionEl || typeof message !== 'string') {
    return;
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  liveRegionEl.textContent = '';
  liveRegionEl.textContent = trimmed;
}

export function initLayout(refs) {
  if (!refs || !refs.workspaceShell) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing workspace shell DOM element.');
  }
  if (layoutInitialized) {
    return ok(true);
  }
  layoutInitialized = true;
  layoutRefs = refs;

  const update = () => {
    const width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 360;
    applyLayoutMode(layoutRefs.workspaceShell, width);
  };

  update();

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const tabletQuery = window.matchMedia(`(min-width: ${TABLET_MIN_WIDTH}px)`);
    const desktopQuery = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    if (typeof tabletQuery.addEventListener === 'function') {
      tabletQuery.addEventListener('change', update);
      desktopQuery.addEventListener('change', update);
    } else {
      window.addEventListener('resize', update);
    }
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', update);
  }

  return ok(true);
}
