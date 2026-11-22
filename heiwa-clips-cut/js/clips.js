/* Stage 3 module: clip CRUD, validation, presets, rapid creation, reordering, and inline editing. */

import { ACTIONS, store } from './store.js';
import { ERROR_CODES, fail, notifyToast, ok } from './errors.js';
import { clamp, formatTimestamp, parseTimestamp } from './time.js';

export const CLIP_WARN_THRESHOLD = 200;
export const DURATION_PRESETS = Object.freeze([15, 30, 60]);
export const DEFAULT_QUICK_DURATION_SEC = 15;

let lastUsedDurationSec = DEFAULT_QUICK_DURATION_SEC;
let editingClipId = null;
let editingError = null;
let draftError = null;
let dragSourceIndex = null;
let clipsInitialized = false;
let clipRefs = null;
let clipCallbacks = null;
let clipIdCounter = 0;

function roundMs(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

function formatSafeTime(seconds) {
  const res = formatTimestamp(seconds);
  return res.ok ? res.value : '00:00:00.000';
}

export function getLastUsedDurationSec() {
  return lastUsedDurationSec;
}

export function setLastUsedDurationSec(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Duration preset must be a positive number of seconds.');
  }
  lastUsedDurationSec = roundMs(seconds);
  return ok(lastUsedDurationSec);
}

export function createClipId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `clip_${crypto.randomUUID()}`;
  }
  clipIdCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `clip_${Date.now().toString(36)}_${clipIdCounter}_${rand}`;
}

export function createDefaultCrop() {
  return {
    ratio: 'orig',
    zoom: 1,
    panX: 0.5,
    panY: 0.5,
    fit: 'fill',
    background: 'none'
  };
}

export function shouldWarnClipCount(count) {
  return typeof count === 'number' && count >= CLIP_WARN_THRESHOLD;
}

export function validateClipRange(startSec, endSec, durationSec) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Open a valid video before setting clip ranges.');
  }
  if (
    typeof startSec !== 'number' ||
    !Number.isFinite(startSec) ||
    typeof endSec !== 'number' ||
    !Number.isFinite(endSec)
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip start and end must be finite numbers.');
  }
  const s = roundMs(startSec);
  const e = roundMs(endSec);
  const maxDur = roundMs(durationSec);

  if (s < 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Start time cannot be negative.');
  }
  if (e > maxDur) {
    return fail(
      ERROR_CODES.E_RANGE_INVALID,
      `End time (${formatSafeTime(e)}) exceeds video duration (${formatSafeTime(maxDur)}).`
    );
  }
  if (e <= s) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'End time must be strictly greater than start time.');
  }

  return ok({ startSec: s, endSec: e });
}

export function parseAndValidateRange(startInput, endInput, durationSec) {
  const startRes = parseTimestamp(startInput);
  if (!startRes.ok) {
    return fail(
      ERROR_CODES.E_TIME_PARSE,
      `Start time is invalid. ${startRes.error.message}`,
      startRes.error.hint
    );
  }

  const endRes = parseTimestamp(endInput);
  if (!endRes.ok) {
    return fail(
      ERROR_CODES.E_TIME_PARSE,
      `End time is invalid. ${endRes.error.message}`,
      endRes.error.hint
    );
  }

  return validateClipRange(startRes.value, endRes.value, durationSec);
}

export function computePresetRange(startSec, presetSec, durationSec) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Open a valid video before applying a duration preset.');
  }
  if (typeof presetSec !== 'number' || !Number.isFinite(presetSec) || presetSec <= 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Preset duration must be greater than 0 seconds.');
  }
  if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Start time must be a valid non-negative timestamp.');
  }

  const maxDur = roundMs(durationSec);
  const clampedStartRes = clamp(roundMs(startSec), 0, maxDur);
  if (!clampedStartRes.ok) {
    return clampedStartRes;
  }
  const s = clampedStartRes.value;
  if (s >= maxDur) {
    return fail(
      ERROR_CODES.E_RANGE_INVALID,
      'Start position is already at the end of the video; seek earlier to apply a preset.'
    );
  }

  const clampedEndRes = clamp(roundMs(s + presetSec), s, maxDur);
  if (!clampedEndRes.ok) {
    return clampedEndRes;
  }
  const e = roundMs(clampedEndRes.value);
  if (e <= s) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip duration after clamping is zero.');
  }

  return ok({
    startSec: s,
    endSec: e,
    appliedDurationSec: roundMs(e - s),
    wasClamped: roundMs(s + presetSec) > maxDur
  });
}

export function buildClip({ name, startSec, endSec, durationSec, existingCount = 0, crop = null }) {
  const rangeRes = validateClipRange(startSec, endSec, durationSec);
  if (!rangeRes.ok) {
    return rangeRes;
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const finalName = trimmedName || `Clip ${existingCount + 1}`;
  const finalCrop = crop && typeof crop === 'object'
    ? { ...createDefaultCrop(), ...crop }
    : createDefaultCrop();

  return ok({
    id: createClipId(),
    name: finalName,
    startSec: rangeRes.value.startSec,
    endSec: rangeRes.value.endSec,
    crop: finalCrop,
    processStatus: 'idle',
    exportStatus: 'none'
  });
}

export function addClip(startInput, endInput, name = '', targetStore = store) {
  const state = targetStore.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Open a local video before adding clips.');
  }
  const parsed = parseAndValidateRange(startInput, endInput, state.source.durationSec);
  if (!parsed.ok) {
    return parsed;
  }

  const clipRes = buildClip({
    name,
    startSec: parsed.value.startSec,
    endSec: parsed.value.endSec,
    durationSec: state.source.durationSec,
    existingCount: state.clips.length
  });
  if (!clipRes.ok) {
    return clipRes;
  }

  const dispatchRes = targetStore.dispatch({ type: ACTIONS.CLIP_ADD, payload: clipRes.value });
  if (!dispatchRes.ok) {
    return dispatchRes;
  }

  const clipDuration = roundMs(clipRes.value.endSec - clipRes.value.startSec);
  if (clipDuration > 0) {
    lastUsedDurationSec = clipDuration;
  }

  return ok(clipRes.value);
}

export function quickAddClipAtPlayhead(targetStore = store) {
  const state = targetStore.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Open a local video before creating a quick clip.');
  }
  const presetRes = computePresetRange(
    state.playheadSec,
    lastUsedDurationSec,
    state.source.durationSec
  );
  if (!presetRes.ok) {
    return presetRes;
  }

  const clipRes = buildClip({
    name: '',
    startSec: presetRes.value.startSec,
    endSec: presetRes.value.endSec,
    durationSec: state.source.durationSec,
    existingCount: state.clips.length
  });
  if (!clipRes.ok) {
    return clipRes;
  }

  const dispatchRes = targetStore.dispatch({ type: ACTIONS.CLIP_ADD, payload: clipRes.value });
  if (!dispatchRes.ok) {
    return dispatchRes;
  }

  targetStore.dispatch({
    type: ACTIONS.SET_DRAFT,
    payload: { startSec: clipRes.value.startSec, endSec: clipRes.value.endSec }
  });
  return ok(clipRes.value);
}

export function updateClipDetails(id, { name, startInput, endInput }, targetStore = store) {
  const state = targetStore.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'No source video is loaded.');
  }
  const existing = state.clips.find((c) => c.id === id);
  if (!existing) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip was not found.');
  }

  const parsed = parseAndValidateRange(startInput, endInput, state.source.durationSec);
  if (!parsed.ok) {
    return parsed;
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const nextName = trimmedName || existing.name;

  const dispatchRes = targetStore.dispatch({
    type: ACTIONS.CLIP_UPDATE,
    payload: {
      id,
      patch: {
        name: nextName,
        startSec: parsed.value.startSec,
        endSec: parsed.value.endSec
      }
    }
  });
  if (!dispatchRes.ok) {
    return dispatchRes;
  }
  return ok(dispatchRes.value.clips.find((c) => c.id === id));
}

export function duplicateClip(id, targetStore = store) {
  const state = targetStore.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'No source video is loaded.');
  }
  const existing = state.clips.find((c) => c.id === id);
  if (!existing) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip to duplicate was not found.');
  }

  const clipRes = buildClip({
    name: `${existing.name} (copy)`,
    startSec: existing.startSec,
    endSec: existing.endSec,
    durationSec: state.source.durationSec,
    existingCount: state.clips.length,
    crop: existing.crop
  });
  if (!clipRes.ok) {
    return clipRes;
  }

  const dispatchRes = targetStore.dispatch({ type: ACTIONS.CLIP_ADD, payload: clipRes.value });
  if (!dispatchRes.ok) {
    return dispatchRes;
  }
  return ok(clipRes.value);
}

export function deleteClip(id, targetStore = store) {
  return targetStore.dispatch({ type: ACTIONS.CLIP_DELETE, payload: id });
}

export function reorderClip(fromIndex, toIndex, targetStore = store) {
  return targetStore.dispatch({
    type: ACTIONS.CLIP_REORDER,
    payload: { fromIndex, toIndex }
  });
}

export function selectClip(id, targetStore = store) {
  return targetStore.dispatch({ type: ACTIONS.SET_SELECTED_CLIP, payload: id });
}

export function getAdjacentClip(clips, selectedClipId, direction) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'No clips are available to navigate.');
  }
  if (direction !== -1 && direction !== 1) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Navigation direction must be -1 or 1.');
  }
  const currentIndex = selectedClipId ? clips.findIndex((c) => c.id === selectedClipId) : -1;
  if (currentIndex === -1) {
    return ok(direction > 0 ? clips[0] : clips[clips.length - 1]);
  }
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= clips.length) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Already at the boundary of the clip list.');
  }
  return ok(clips[nextIndex]);
}

export function setDraftMarkerFromPlayhead(edge, targetStore = store) {
  if (edge !== 'start' && edge !== 'end') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Marker edge must be "start" or "end".');
  }
  const state = targetStore.getState();
  if (!state.source) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Open a local video before setting markers.');
  }
  const markerSec = roundMs(state.playheadSec);
  const nextDraft = edge === 'start'
    ? { startSec: markerSec, endSec: state.draft.endSec }
    : { startSec: state.draft.startSec, endSec: markerSec };

  draftError = null;
  const dispatchRes = targetStore.dispatch({
    type: ACTIONS.SET_DRAFT,
    payload: nextDraft
  });
  if (!dispatchRes.ok) {
    return dispatchRes;
  }
  if (targetStore === store) {
    syncDraftInputsFromState(targetStore.getState());
    renderClipsPanel(targetStore.getState());
  }
  return ok(nextDraft);
}

/* --- DOM Rendering & Event Wiring --- */

function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function renderInlineError(boxEl, appError) {
  if (!boxEl) {
    return;
  }
  if (!appError) {
    boxEl.hidden = true;
    clearChildren(boxEl);
    return;
  }
  clearChildren(boxEl);
  const titleEl = document.createElement('p');
  titleEl.className = 'alert-box__title';
  titleEl.textContent = `${appError.code}: ${appError.message}`;

  const hintEl = document.createElement('p');
  hintEl.textContent = appError.hint;

  boxEl.appendChild(titleEl);
  boxEl.appendChild(hintEl);
  boxEl.hidden = false;
}

function updateQuickButtonText() {
  if (!clipRefs || !clipRefs.quickAddBtn) {
    return;
  }
  const label = Number.isInteger(lastUsedDurationSec)
    ? `${lastUsedDurationSec}s`
    : `${lastUsedDurationSec}s`;
  clipRefs.quickAddBtn.textContent = `Quick +${label} at Playhead`;
}

export function syncDraftInputsFromState(state) {
  if (!clipRefs) {
    return;
  }
  if (clipRefs.draftStart) {
    clipRefs.draftStart.value = formatSafeTime(state.draft.startSec);
  }
  if (clipRefs.draftEnd) {
    clipRefs.draftEnd.value = formatSafeTime(state.draft.endSec);
  }
}

function renderClipEditor(clip, cardEl) {
  const editor = document.createElement('div');
  editor.className = 'clip-editor';
  editor.dataset.clipId = clip.id;

  const fields = document.createElement('div');
  fields.className = 'clip-editor__fields';

  const makeField = (labelText, fieldName, value) => {
    const label = document.createElement('label');
    label.className = 'field-group';
    const span = document.createElement('span');
    span.className = 'field-group__label';
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.dataset.editField = fieldName;
    input.value = value;
    label.appendChild(span);
    label.appendChild(input);
    return label;
  };

  fields.appendChild(makeField('Clip name', 'name', clip.name));
  fields.appendChild(makeField('Start (HH:MM:SS.mmm)', 'start', formatSafeTime(clip.startSec)));
  fields.appendChild(makeField('End (HH:MM:SS.mmm)', 'end', formatSafeTime(clip.endSec)));

  editor.appendChild(fields);

  if (editingError) {
    const errBox = document.createElement('div');
    errBox.className = 'alert-box alert-box--error';
    errBox.setAttribute('role', 'alert');
    const titleEl = document.createElement('p');
    titleEl.className = 'alert-box__title';
    titleEl.textContent = `${editingError.code}: ${editingError.message}`;
    const hintEl = document.createElement('p');
    hintEl.textContent = editingError.hint;
    errBox.appendChild(titleEl);
    errBox.appendChild(hintEl);
    editor.appendChild(errBox);
  }

  const actions = document.createElement('div');
  actions.className = 'clip-editor__actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn--primary btn--compact';
  saveBtn.dataset.clipAction = 'save-edit';
  saveBtn.dataset.clipId = clip.id;
  saveBtn.textContent = 'Save changes';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn--ghost btn--compact';
  cancelBtn.dataset.clipAction = 'cancel-edit';
  cancelBtn.dataset.clipId = clip.id;
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  editor.appendChild(actions);

  cardEl.appendChild(editor);
}

function renderClipItem(clip, index, totalCount, isSelected) {
  const li = document.createElement('li');
  li.className = isSelected ? 'clip-card clip-card--selected' : 'clip-card';
  li.draggable = editingClipId !== clip.id;
  li.dataset.clipId = clip.id;
  li.dataset.clipIndex = String(index);

  const topRow = document.createElement('div');
  topRow.className = 'clip-card__top';

  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.className = 'clip-card__select';
  infoBtn.dataset.clipAction = 'select';
  infoBtn.dataset.clipId = clip.id;
  infoBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

  const indexSpan = document.createElement('span');
  indexSpan.className = 'clip-card__index';
  indexSpan.textContent = `#${index + 1}`;

  const titleWrap = document.createElement('span');
  titleWrap.className = 'clip-card__title-wrap';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'clip-card__name';
  nameSpan.textContent = clip.name;

  const durSec = Math.max(0, roundMs(clip.endSec - clip.startSec));
  const rangeSpan = document.createElement('span');
  rangeSpan.className = 'clip-card__range';
  rangeSpan.textContent = `${formatSafeTime(clip.startSec)} → ${formatSafeTime(clip.endSec)} (${durSec.toFixed(2)}s)`;

  titleWrap.appendChild(nameSpan);
  titleWrap.appendChild(rangeSpan);
  infoBtn.appendChild(indexSpan);
  infoBtn.appendChild(titleWrap);
  topRow.appendChild(infoBtn);

  const actions = document.createElement('div');
  actions.className = 'clip-card__actions';

  const makeActionBtn = (label, action, disabled = false, extraClass = '') => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn--secondary btn--compact ${extraClass}`.trim();
    btn.dataset.clipAction = action;
    btn.dataset.clipId = clip.id;
    btn.dataset.clipIndex = String(index);
    btn.disabled = disabled;
    btn.textContent = label;
    return btn;
  };

  actions.appendChild(makeActionBtn('Preview', 'preview'));
  actions.appendChild(makeActionBtn('Edit', 'edit'));
  actions.appendChild(makeActionBtn('Duplicate', 'duplicate'));
  actions.appendChild(makeActionBtn('Up', 'move-up', index === 0));
  actions.appendChild(makeActionBtn('Down', 'move-down', index === totalCount - 1));
  actions.appendChild(makeActionBtn('Delete', 'delete', false, 'btn--danger-ghost'));

  li.appendChild(topRow);
  li.appendChild(actions);

  if (editingClipId === clip.id) {
    renderClipEditor(clip, li);
  }

  return li;
}

export function renderClipsPanel(state) {
  if (!clipRefs) {
    return;
  }
  const hasSource = Boolean(state.source);
  const history = store.getHistoryStatus();

  if (clipRefs.undoBtn) {
    clipRefs.undoBtn.disabled = !history.canUndo;
    clipRefs.undoBtn.textContent = history.undoCount > 0 ? `Undo (${history.undoCount})` : 'Undo';
  }
  if (clipRefs.redoBtn) {
    clipRefs.redoBtn.disabled = !history.canRedo;
    clipRefs.redoBtn.textContent = history.redoCount > 0 ? `Redo (${history.redoCount})` : 'Redo';
  }

  const draftControls = [
    clipRefs.draftStart,
    clipRefs.draftEnd,
    clipRefs.setStartBtn,
    clipRefs.setEndBtn,
    clipRefs.resetDraftBtn,
    clipRefs.preset15Btn,
    clipRefs.preset30Btn,
    clipRefs.preset60Btn,
    clipRefs.customPresetInput,
    clipRefs.customPresetBtn,
    clipRefs.addClipBtn,
    clipRefs.quickAddBtn
  ];
  for (const el of draftControls) {
    if (el) {
      el.disabled = !hasSource;
    }
  }

  updateQuickButtonText();
  renderInlineError(clipRefs.draftErrorBox, draftError);

  if (clipRefs.countBadge) {
    clipRefs.countBadge.textContent = `${state.clips.length} ${state.clips.length === 1 ? 'clip' : 'clips'}`;
  }

  if (clipRefs.countWarning) {
    const warn = shouldWarnClipCount(state.clips.length);
    clipRefs.countWarning.hidden = !warn;
    if (warn) {
      clipRefs.countWarning.textContent = `Large clip list (${state.clips.length} clips). There is no fixed limit, but exporting 200+ clips at once may take longer and use more memory.`;
    }
  }

  if (clipRefs.emptyState) {
    clipRefs.emptyState.hidden = state.clips.length > 0;
  }

  if (clipRefs.listEl) {
    clearChildren(clipRefs.listEl);
    for (let i = 0; i < state.clips.length; i += 1) {
      const clip = state.clips[i];
      const itemEl = renderClipItem(clip, i, state.clips.length, clip.id === state.selectedClipId);
      clipRefs.listEl.appendChild(itemEl);
    }
  }
}

function applyPresetSeconds(presetSec) {
  const state = store.getState();
  if (!state.source) {
    draftError = fail(ERROR_CODES.E_RANGE_INVALID, 'Open a local video first.').error;
    renderClipsPanel(state);
    return;
  }

  const startRaw = clipRefs.draftStart ? clipRefs.draftStart.value : String(state.draft.startSec);
  const startParsed = parseTimestamp(startRaw);
  if (!startParsed.ok) {
    draftError = startParsed.error;
    renderClipsPanel(state);
    return;
  }

  const rangeRes = computePresetRange(startParsed.value, presetSec, state.source.durationSec);
  if (!rangeRes.ok) {
    draftError = rangeRes.error;
    renderClipsPanel(state);
    return;
  }

  draftError = null;
  lastUsedDurationSec = roundMs(presetSec);
  store.dispatch({
    type: ACTIONS.SET_DRAFT,
    payload: { startSec: rangeRes.value.startSec, endSec: rangeRes.value.endSec }
  });
  syncDraftInputsFromState(store.getState());
  renderClipsPanel(store.getState());
}

function handleListClick(event) {
  const target = event.target instanceof Element ? event.target.closest('[data-clip-action]') : null;
  if (!target) {
    return;
  }
  const action = target.dataset.clipAction;
  const clipId = target.dataset.clipId;
  const index = Number(target.dataset.clipIndex);
  const state = store.getState();

  if (action === 'select' && clipId) {
    selectClip(clipId);
    const clip = store.getState().clips.find((c) => c.id === clipId);
    if (clip && clipCallbacks && typeof clipCallbacks.onSelectClip === 'function') {
      clipCallbacks.onSelectClip(clip);
    }
    return;
  }

  if (action === 'preview' && clipId) {
    selectClip(clipId);
    const clip = state.clips.find((c) => c.id === clipId);
    if (clip && clipCallbacks && typeof clipCallbacks.onPreviewClip === 'function') {
      clipCallbacks.onPreviewClip(clip);
    }
    return;
  }

  if (action === 'edit' && clipId) {
    editingClipId = editingClipId === clipId ? null : clipId;
    editingError = null;
    selectClip(clipId);
    renderClipsPanel(store.getState());
    return;
  }

  if (action === 'cancel-edit') {
    editingClipId = null;
    editingError = null;
    renderClipsPanel(store.getState());
    return;
  }

  if (action === 'save-edit' && clipId) {
    const editorEl = target.closest('.clip-editor');
    if (!editorEl) {
      return;
    }
    const nameInput = editorEl.querySelector('[data-edit-field="name"]');
    const startInput = editorEl.querySelector('[data-edit-field="start"]');
    const endInput = editorEl.querySelector('[data-edit-field="end"]');

    const result = updateClipDetails(clipId, {
      name: nameInput ? nameInput.value : '',
      startInput: startInput ? startInput.value : '',
      endInput: endInput ? endInput.value : ''
    });

    if (!result.ok) {
      /* Preserve invalid user text and show inline message without modifying store. */
      editingError = result.error;
      const existingErr = editorEl.querySelector('.alert-box--error');
      if (existingErr) {
        existingErr.remove();
      }
      const errBox = document.createElement('div');
      errBox.className = 'alert-box alert-box--error';
      errBox.setAttribute('role', 'alert');
      const titleEl = document.createElement('p');
      titleEl.className = 'alert-box__title';
      titleEl.textContent = `${result.error.code}: ${result.error.message}`;
      const hintEl = document.createElement('p');
      hintEl.textContent = result.error.hint;
      errBox.appendChild(titleEl);
      errBox.appendChild(hintEl);
      const actionsEl = editorEl.querySelector('.clip-editor__actions');
      editorEl.insertBefore(errBox, actionsEl);
      return;
    }

    editingClipId = null;
    editingError = null;
    renderClipsPanel(store.getState());
    notifyToast('Clip updated', `"${result.value.name}" saved.`, 'success', 2500);
    return;
  }

  if (action === 'duplicate' && clipId) {
    const res = duplicateClip(clipId);
    if (!res.ok) {
      draftError = res.error;
      renderClipsPanel(store.getState());
    }
    return;
  }

  if (action === 'move-up' && Number.isInteger(index) && index > 0) {
    reorderClip(index, index - 1);
    return;
  }

  if (action === 'move-down' && Number.isInteger(index) && index < state.clips.length - 1) {
    reorderClip(index, index + 1);
    return;
  }

  if (action === 'delete' && clipId) {
    if (editingClipId === clipId) {
      editingClipId = null;
      editingError = null;
    }
    deleteClip(clipId);
  }
}

export function initClips(refs, callbacks = {}) {
  if (!refs || !refs.listEl) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing clip studio DOM elements.');
  }
  if (clipsInitialized) {
    return ok(true);
  }
  clipsInitialized = true;
  clipRefs = refs;
  clipCallbacks = callbacks;

  if (refs.setStartBtn) {
    refs.setStartBtn.addEventListener('click', () => {
      setDraftMarkerFromPlayhead('start');
    });
  }

  if (refs.setEndBtn) {
    refs.setEndBtn.addEventListener('click', () => {
      setDraftMarkerFromPlayhead('end');
    });
  }

  if (refs.resetDraftBtn) {
    refs.resetDraftBtn.addEventListener('click', () => {
      const state = store.getState();
      if (!state.source) {
        return;
      }
      draftError = null;
      store.dispatch({
        type: ACTIONS.SET_DRAFT,
        payload: { startSec: 0, endSec: Math.min(DEFAULT_QUICK_DURATION_SEC, state.source.durationSec) }
      });
      syncDraftInputsFromState(store.getState());
      renderClipsPanel(store.getState());
    });
  }

  const handleDraftBlurOrChange = () => {
    const state = store.getState();
    if (!state.source || !refs.draftStart || !refs.draftEnd) {
      return;
    }
    const check = parseAndValidateRange(refs.draftStart.value, refs.draftEnd.value, state.source.durationSec);
    if (!check.ok) {
      draftError = check.error;
      renderInlineError(refs.draftErrorBox, draftError);
      return;
    }
    draftError = null;
    renderInlineError(refs.draftErrorBox, null);
    store.dispatch({ type: ACTIONS.SET_DRAFT, payload: check.value });
  };

  if (refs.draftStart) {
    refs.draftStart.addEventListener('change', handleDraftBlurOrChange);
  }
  if (refs.draftEnd) {
    refs.draftEnd.addEventListener('change', handleDraftBlurOrChange);
  }

  if (refs.preset15Btn) {
    refs.preset15Btn.addEventListener('click', () => applyPresetSeconds(15));
  }
  if (refs.preset30Btn) {
    refs.preset30Btn.addEventListener('click', () => applyPresetSeconds(30));
  }
  if (refs.preset60Btn) {
    refs.preset60Btn.addEventListener('click', () => applyPresetSeconds(60));
  }

  if (refs.customPresetBtn) {
    refs.customPresetBtn.addEventListener('click', () => {
      const raw = refs.customPresetInput ? refs.customPresetInput.value.trim() : '';
      const parsed = parseTimestamp(raw);
      if (!parsed.ok || parsed.value <= 0) {
        draftError = fail(
          ERROR_CODES.E_TIME_PARSE,
          'Custom duration must be a positive number of seconds (e.g. 12 or 0:45).'
        ).error;
        renderClipsPanel(store.getState());
        return;
      }
      applyPresetSeconds(parsed.value);
    });
  }

  if (refs.addClipBtn) {
    refs.addClipBtn.addEventListener('click', () => {
      const startVal = refs.draftStart ? refs.draftStart.value : '';
      const endVal = refs.draftEnd ? refs.draftEnd.value : '';
      const res = addClip(startVal, endVal, '');
      if (!res.ok) {
        draftError = res.error;
        renderInlineError(refs.draftErrorBox, draftError);
        return;
      }
      draftError = null;
      renderInlineError(refs.draftErrorBox, null);
      notifyToast('Clip added', `${res.value.name} (${formatSafeTime(res.value.startSec)} → ${formatSafeTime(res.value.endSec)})`, 'success', 2500);
    });
  }

  if (refs.quickAddBtn) {
    refs.quickAddBtn.addEventListener('click', () => {
      const res = quickAddClipAtPlayhead();
      if (!res.ok) {
        draftError = res.error;
        renderInlineError(refs.draftErrorBox, draftError);
        return;
      }
      draftError = null;
      syncDraftInputsFromState(store.getState());
      renderInlineError(refs.draftErrorBox, null);
      notifyToast('Quick clip created', `${res.value.name} added at playhead.`, 'success', 2500);
    });
  }

  if (refs.undoBtn) {
    refs.undoBtn.addEventListener('click', () => {
      editingClipId = null;
      editingError = null;
      store.dispatch({ type: ACTIONS.UNDO });
    });
  }

  if (refs.redoBtn) {
    refs.redoBtn.addEventListener('click', () => {
      editingClipId = null;
      editingError = null;
      store.dispatch({ type: ACTIONS.REDO });
    });
  }

  /* Delegated listeners on clip-list so re-rendering clips never attaches duplicates. */
  refs.listEl.addEventListener('click', handleListClick);

  refs.listEl.addEventListener('dragstart', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.clip-card') : null;
    if (!item || editingClipId === item.dataset.clipId) {
      event.preventDefault();
      return;
    }
    dragSourceIndex = Number(item.dataset.clipIndex);
    item.classList.add('clip-card--dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.dataset.clipId || '');
    }
  });

  refs.listEl.addEventListener('dragover', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.clip-card') : null;
    if (!item || dragSourceIndex === null) {
      return;
    }
    event.preventDefault();
    item.classList.add('clip-card--drag-over');
  });

  refs.listEl.addEventListener('dragleave', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.clip-card') : null;
    if (item) {
      item.classList.remove('clip-card--drag-over');
    }
  });

  refs.listEl.addEventListener('drop', (event) => {
    const item = event.target instanceof Element ? event.target.closest('.clip-card') : null;
    if (!item || dragSourceIndex === null) {
      return;
    }
    event.preventDefault();
    item.classList.remove('clip-card--drag-over');
    const targetIndex = Number(item.dataset.clipIndex);
    const fromIndex = dragSourceIndex;
    dragSourceIndex = null;
    if (Number.isInteger(fromIndex) && Number.isInteger(targetIndex) && fromIndex !== targetIndex) {
      reorderClip(fromIndex, targetIndex);
    }
  });

  refs.listEl.addEventListener('dragend', () => {
    dragSourceIndex = null;
    const cards = refs.listEl.querySelectorAll('.clip-card--dragging, .clip-card--drag-over');
    for (const card of cards) {
      card.classList.remove('clip-card--dragging', 'clip-card--drag-over');
    }
  });

  renderClipsPanel(store.getState());
  return ok(true);
}
