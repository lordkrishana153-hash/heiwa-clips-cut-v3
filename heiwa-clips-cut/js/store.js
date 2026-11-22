/* Central state store following frozen contract 3.1 with undo/redo history (up to 100 clip snapshots). */

import { ERROR_CODES, fail, ok } from './errors.js';

export const MAX_HISTORY = 100;

export const ACTIONS = Object.freeze({
  SET_SOURCE: 'SET_SOURCE',
  SET_PLAYHEAD: 'SET_PLAYHEAD',
  SET_DRAFT: 'SET_DRAFT',
  CLIPS_SET: 'CLIPS_SET',
  CLIPS_REPLACE_NO_HISTORY: 'CLIPS_REPLACE_NO_HISTORY',
  CLIP_ADD: 'CLIP_ADD',
  CLIP_UPDATE: 'CLIP_UPDATE',
  CLIP_DELETE: 'CLIP_DELETE',
  CLIP_REORDER: 'CLIP_REORDER',
  SET_SELECTED_CLIP: 'SET_SELECTED_CLIP',
  SET_EXPORT_SETTINGS: 'SET_EXPORT_SETTINGS',
  SET_QUEUE: 'SET_QUEUE',
  SET_UI_STATUS: 'SET_UI_STATUS',
  SET_UI_ZOOM: 'SET_UI_ZOOM',
  SET_UI_ERROR: 'SET_UI_ERROR',
  SET_CAPABILITIES: 'SET_CAPABILITIES',
  UNDO: 'UNDO',
  REDO: 'REDO',
  HISTORY_CLEAR: 'HISTORY_CLEAR',
  RESET_PROJECT: 'RESET_PROJECT'
});

const VALID_UI_STATUSES = new Set([
  'idle',
  'loading',
  'ready',
  'processing',
  'waiting',
  'success',
  'failure',
  'cancelled',
  'recovery'
]);

function cloneClip(clip) {
  return {
    ...clip,
    crop: clip && clip.crop ? { ...clip.crop } : {
      ratio: 'orig',
      zoom: 1,
      panX: 0.5,
      panY: 0.5,
      fit: 'fill',
      background: 'none'
    }
  };
}

function cloneClips(clips) {
  if (!Array.isArray(clips)) {
    return [];
  }
  return clips.map(cloneClip);
}

export function createInitialState() {
  return {
    source: null,
    playheadSec: 0,
    draft: { startSec: 0, endSec: 0 },
    clips: [],
    selectedClipId: null,
    exportSettings: {
      format: 'mp4',
      mode: 'precise',
      maxSide: 1080,
      quality: 'high'
    },
    queue: [],
    ui: {
      status: 'idle',
      zoom: 1,
      error: null
    },
    capabilities: {
      webcodecs: false,
      videoEncode: { h264: false, vp9: false },
      audioEncode: { aac: false, opus: false },
      worker: false,
      indexedDb: false,
      fileSystemAccess: false,
      opfs: false,
      persist: false
    }
  };
}

function pushBounded(stack, snapshot) {
  const next = stack.concat([snapshot]);
  if (next.length > MAX_HISTORY) {
    return next.slice(next.length - MAX_HISTORY);
  }
  return next;
}

function syncSelectedClipId(clips, currentSelectedId) {
  if (currentSelectedId === null) {
    return null;
  }
  const exists = clips.some((clip) => clip.id === currentSelectedId);
  return exists ? currentSelectedId : null;
}

export function createStore(initialOverrides = null) {
  let state = createInitialState();
  if (initialOverrides && typeof initialOverrides === 'object') {
    state = {
      ...state,
      ...initialOverrides,
      clips: cloneClips(initialOverrides.clips || state.clips)
    };
  }

  let past = [];
  let future = [];
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) {
      listener(state);
    }
  }

  function applyClipMutation(nextClips, preferredSelectedId) {
    past = pushBounded(past, cloneClips(state.clips));
    future = [];
    const clonedNext = cloneClips(nextClips);
    const nextSelected = preferredSelectedId !== undefined
      ? syncSelectedClipId(clonedNext, preferredSelectedId)
      : syncSelectedClipId(clonedNext, state.selectedClipId);
    state = {
      ...state,
      clips: clonedNext,
      selectedClipId: nextSelected
    };
    notify();
    return ok(state);
  }

  function getState() {
    return state;
  }

  function getHistoryStatus() {
    return {
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      undoCount: past.length,
      redoCount: future.length
    };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      return fail(ERROR_CODES.E_RANGE_INVALID, 'Store subscriber must be a function.');
    }
    listeners.add(listener);
    const unsubscribe = () => {
      listeners.delete(listener);
    };
    return ok(unsubscribe);
  }

  function dispatch(action) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
      return fail(ERROR_CODES.E_RANGE_INVALID, 'Store action must be an object with a string type.');
    }

    const { type, payload } = action;

    switch (type) {
      case ACTIONS.SET_SOURCE: {
        state = {
          ...state,
          source: payload ? { ...payload } : null
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_PLAYHEAD: {
        if (typeof payload !== 'number' || !Number.isFinite(payload) || payload < 0) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Playhead time must be a non-negative finite number.');
        }
        state = { ...state, playheadSec: payload };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_DRAFT: {
        if (!payload || typeof payload !== 'object') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Draft range payload must be an object.');
        }
        const startSec = typeof payload.startSec === 'number' ? payload.startSec : state.draft.startSec;
        const endSec = typeof payload.endSec === 'number' ? payload.endSec : state.draft.endSec;
        state = { ...state, draft: { startSec, endSec } };
        notify();
        return ok(state);
      }

      case ACTIONS.CLIPS_SET: {
        if (!Array.isArray(payload)) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'CLIPS_SET payload must be an array.');
        }
        return applyClipMutation(payload);
      }

      case ACTIONS.CLIPS_REPLACE_NO_HISTORY: {
        if (!Array.isArray(payload)) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'CLIPS_REPLACE_NO_HISTORY payload must be an array.');
        }
        const clonedNext = cloneClips(payload);
        state = {
          ...state,
          clips: clonedNext,
          selectedClipId: syncSelectedClipId(clonedNext, state.selectedClipId)
        };
        notify();
        return ok(state);
      }

      case ACTIONS.CLIP_ADD: {
        if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'CLIP_ADD requires a clip object with an id.');
        }
        const nextClips = state.clips.concat([cloneClip(payload)]);
        return applyClipMutation(nextClips, payload.id);
      }

      case ACTIONS.CLIP_UPDATE: {
        if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'CLIP_UPDATE requires an id and patch.');
        }
        const index = state.clips.findIndex((clip) => clip.id === payload.id);
        if (index === -1) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip to update was not found.');
        }
        const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
        const current = state.clips[index];
        const updated = cloneClip({
          ...current,
          ...patch,
          id: current.id,
          crop: patch.crop ? { ...current.crop, ...patch.crop } : current.crop
        });
        const nextClips = state.clips.slice();
        nextClips[index] = updated;
        return applyClipMutation(nextClips);
      }

      case ACTIONS.CLIP_DELETE: {
        if (typeof payload !== 'string' || !payload) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'CLIP_DELETE requires a clip id string.');
        }
        const nextClips = state.clips.filter((clip) => clip.id !== payload);
        if (nextClips.length === state.clips.length) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip to delete was not found.');
        }
        return applyClipMutation(nextClips);
      }

      case ACTIONS.CLIP_REORDER: {
        if (!payload || typeof payload !== 'object') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'CLIP_REORDER requires fromIndex and toIndex.');
        }
        const { fromIndex, toIndex } = payload;
        const count = state.clips.length;
        if (
          !Number.isInteger(fromIndex) ||
          !Number.isInteger(toIndex) ||
          fromIndex < 0 ||
          fromIndex >= count ||
          toIndex < 0 ||
          toIndex >= count
        ) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Reorder indices are out of range.');
        }
        if (fromIndex === toIndex) {
          return ok(state);
        }
        const nextClips = state.clips.slice();
        const [moved] = nextClips.splice(fromIndex, 1);
        nextClips.splice(toIndex, 0, moved);
        return applyClipMutation(nextClips);
      }

      case ACTIONS.SET_SELECTED_CLIP: {
        if (payload !== null && typeof payload !== 'string') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Selected clip id must be a string or null.');
        }
        state = {
          ...state,
          selectedClipId: syncSelectedClipId(state.clips, payload)
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_EXPORT_SETTINGS: {
        if (!payload || typeof payload !== 'object') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Export settings payload must be an object.');
        }
        state = {
          ...state,
          exportSettings: { ...state.exportSettings, ...payload }
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_QUEUE: {
        if (!Array.isArray(payload)) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Queue payload must be an array.');
        }
        state = {
          ...state,
          queue: payload.map((job) => ({ ...job }))
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_UI_STATUS: {
        if (typeof payload !== 'string' || !VALID_UI_STATUSES.has(payload)) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Invalid UI status value.');
        }
        state = {
          ...state,
          ui: { ...state.ui, status: payload }
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_UI_ZOOM: {
        if (typeof payload !== 'number' || !Number.isFinite(payload) || payload <= 0) {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Timeline zoom must be a positive finite number.');
        }
        state = {
          ...state,
          ui: { ...state.ui, zoom: payload }
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_UI_ERROR: {
        state = {
          ...state,
          ui: { ...state.ui, error: payload ? { ...payload } : null }
        };
        notify();
        return ok(state);
      }

      case ACTIONS.SET_CAPABILITIES: {
        if (!payload || typeof payload !== 'object') {
          return fail(ERROR_CODES.E_RANGE_INVALID, 'Capabilities payload must be an object.');
        }
        state = {
          ...state,
          capabilities: {
            ...state.capabilities,
            ...payload,
            videoEncode: {
              ...state.capabilities.videoEncode,
              ...(payload.videoEncode || {})
            },
            audioEncode: {
              ...state.capabilities.audioEncode,
              ...(payload.audioEncode || {})
            }
          }
        };
        notify();
        return ok(state);
      }

      case ACTIONS.UNDO: {
        if (past.length === 0) {
          return ok(state);
        }
        const restored = past[past.length - 1];
        past = past.slice(0, past.length - 1);
        future = pushBounded(future, cloneClips(state.clips));
        const nextClips = cloneClips(restored);
        state = {
          ...state,
          clips: nextClips,
          selectedClipId: syncSelectedClipId(nextClips, state.selectedClipId)
        };
        notify();
        return ok(state);
      }

      case ACTIONS.REDO: {
        if (future.length === 0) {
          return ok(state);
        }
        const restored = future[future.length - 1];
        future = future.slice(0, future.length - 1);
        past = pushBounded(past, cloneClips(state.clips));
        const nextClips = cloneClips(restored);
        state = {
          ...state,
          clips: nextClips,
          selectedClipId: syncSelectedClipId(nextClips, state.selectedClipId)
        };
        notify();
        return ok(state);
      }

      case ACTIONS.HISTORY_CLEAR: {
        past = [];
        future = [];
        notify();
        return ok(state);
      }

      case ACTIONS.RESET_PROJECT: {
        const preservedCaps = state.capabilities;
        state = {
          ...createInitialState(),
          capabilities: preservedCaps
        };
        past = [];
        future = [];
        notify();
        return ok(state);
      }

      default:
        return fail(ERROR_CODES.E_RANGE_INVALID, `Unknown store action type: ${type}`);
    }
  }

  return Object.freeze({
    getState,
    getHistoryStatus,
    subscribe,
    dispatch
  });
}

export const store = createStore();
