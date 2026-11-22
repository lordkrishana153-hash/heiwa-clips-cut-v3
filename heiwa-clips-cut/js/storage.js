/* Stage 8 module: IndexedDB project autosave, reload recovery, persistent storage, and export history metadata. */

import { ACTIONS, store } from './store.js';
import { createAppError, ERROR_CODES, fail, notifyToast, ok, reportError } from './errors.js';
import { formatTimestamp } from './time.js';
import { formatFileSize } from './metadata.js';
import { openConfirmDialog } from './ui/dialogs.js';

export const STORAGE_DB_NAME = 'heiwa-clips-cut-db';
export const STORAGE_DB_VERSION = 1;
export const STORE_PROJECTS = 'projects';
export const STORE_EXPORT_HISTORY = 'exportHistory';
export const ACTIVE_PROJECT_KEY = 'active';
export const AUTOSAVE_DEBOUNCE_MS = 500;
export const MAX_EXPORT_HISTORY = 100;
export const RECOVERY_DURATION_TOLERANCE_SEC = 0.5;
const MIN_RECONCILED_CLIP_SEC = 0.05;

const VALID_RATIOS = new Set(['orig', '9:16', '16:9', '1:1', '4:5']);
const VALID_FITS = new Set(['fill', 'contain']);
const VALID_BACKGROUNDS = new Set(['none', 'blur']);
const VALID_FORMATS = new Set(['mp4', 'webm']);
const VALID_MODES = new Set(['precise', 'fast']);
const VALID_QUALITIES = new Set(['low', 'medium', 'high']);
const VALID_DELIVERIES = new Set(['exported', 'downloaded', 'zipped']);

let cachedDb = null;
let cachedDbName = null;
let controllerInitialized = false;
let controllerRefs = null;
let controllerCallbacks = {};
let autosaveArmed = false;
let autosaveTimerId = null;
let pendingSaveState = null;
let storageUnavailableReported = false;
let storageFullReported = false;
let persistRequestedOnce = false;
let pendingRecovery = null;
let storageUiState = {
  mode: 'idle',
  lastSavedAt: 0,
  persisted: false,
  persistSupported: false,
  usageBytes: null,
  quotaBytes: null,
  historyCount: 0
};

export function isStorageAvailable(idbFactory) {
  const factory = idbFactory !== undefined
    ? idbFactory
    : (typeof indexedDB !== 'undefined' ? indexedDB : null);
  return Boolean(factory && typeof factory.open === 'function');
}

export function classifyStorageError(err) {
  const name = err && typeof err === 'object' && typeof err.name === 'string' ? err.name : '';
  const msg = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : '';
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return createAppError(ERROR_CODES.E_STORAGE_FULL);
  }
  return createAppError(
    ERROR_CODES.E_STORAGE_UNAVAILABLE,
    msg ? `IndexedDB storage could not be accessed (${msg}).` : undefined
  );
}

function sanitizeCrop(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    ratio: VALID_RATIOS.has(src.ratio) ? src.ratio : 'orig',
    zoom: typeof src.zoom === 'number' && Number.isFinite(src.zoom)
      ? Math.max(1, Math.min(4, src.zoom))
      : 1,
    panX: typeof src.panX === 'number' && Number.isFinite(src.panX)
      ? Math.max(0, Math.min(1, src.panX))
      : 0.5,
    panY: typeof src.panY === 'number' && Number.isFinite(src.panY)
      ? Math.max(0, Math.min(1, src.panY))
      : 0.5,
    fit: VALID_FITS.has(src.fit) ? src.fit : 'fill',
    background: VALID_BACKGROUNDS.has(src.background) ? src.background : 'none'
  };
}

function sanitizeClipForStorage(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const startSec = Number(raw.startSec);
  const endSec = Number(raw.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    return null;
  }
  const safeStatus = raw.processStatus === 'done' ? 'done' : 'idle';
  const safeExportStatus = raw.exportStatus === 'downloaded' || raw.exportStatus === 'zipped'
    ? raw.exportStatus
    : 'none';
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `clip_rec_${index + 1}`,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : `Clip ${index + 1}`,
    startSec: Math.round(startSec * 1000) / 1000,
    endSec: Math.round(endSec * 1000) / 1000,
    crop: sanitizeCrop(raw.crop),
    processStatus: safeStatus,
    exportStatus: safeExportStatus,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  };
}

function sanitizeSourceMeta(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const size = Number(raw.size);
  const durationSec = Number(raw.durationSec);
  if (!name || !Number.isFinite(size) || size < 0 || !Number.isFinite(durationSec) || durationSec <= 0) {
    return null;
  }
  return {
    name,
    size,
    durationSec: Math.round(durationSec * 1000) / 1000,
    width: Number.isFinite(Number(raw.width)) ? Math.max(0, Math.round(Number(raw.width))) : 0,
    height: Number.isFinite(Number(raw.height)) ? Math.max(0, Math.round(Number(raw.height))) : 0,
    fps: Number.isFinite(Number(raw.fps)) && Number(raw.fps) > 0 ? Number(raw.fps) : 30,
    videoCodec: typeof raw.videoCodec === 'string' ? raw.videoCodec : 'unknown',
    audioCodec: typeof raw.audioCodec === 'string' ? raw.audioCodec : null
  };
}

function sanitizeExportSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const maxSide = [480, 720, 1080, 1920].includes(Number(src.maxSide)) ? Number(src.maxSide) : 1080;
  return {
    format: VALID_FORMATS.has(src.format) ? src.format : 'mp4',
    mode: VALID_MODES.has(src.mode) ? src.mode : 'precise',
    maxSide,
    quality: VALID_QUALITIES.has(src.quality) ? src.quality : 'high'
  };
}

export function buildProjectSnapshot(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Cannot build project snapshot from empty state.');
  }
  const sourceMeta = sanitizeSourceMeta(state.source);
  const clips = Array.isArray(state.clips)
    ? state.clips.map(sanitizeClipForStorage).filter(Boolean)
    : [];
  const selectedClipId = typeof state.selectedClipId === 'string' && clips.some((c) => c.id === state.selectedClipId)
    ? state.selectedClipId
    : (clips[0] ? clips[0].id : null);
  const rawDraft = state.draft && typeof state.draft === 'object' ? state.draft : { startSec: 0, endSec: 0 };
  const draftStart = Number.isFinite(Number(rawDraft.startSec)) && Number(rawDraft.startSec) >= 0 ? Number(rawDraft.startSec) : 0;
  const draftEnd = Number.isFinite(Number(rawDraft.endSec)) && Number(rawDraft.endSec) >= 0 ? Number(rawDraft.endSec) : 0;
  const rawZoom = state.ui && typeof state.ui.zoom === 'number' && Number.isFinite(state.ui.zoom) ? state.ui.zoom : 1;

  return ok({
    id: ACTIVE_PROJECT_KEY,
    schemaVersion: 1,
    savedAt: Number.isFinite(nowMs) ? nowMs : Date.now(),
    sourceMeta,
    clips,
    selectedClipId,
    draft: {
      startSec: Math.round(draftStart * 1000) / 1000,
      endSec: Math.round(draftEnd * 1000) / 1000
    },
    exportSettings: sanitizeExportSettings(state.exportSettings),
    zoom: Math.max(1, Math.min(20, rawZoom))
  });
}

export function isSnapshotRecoverable(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }
  const hasSource = Boolean(snapshot.sourceMeta && snapshot.sourceMeta.name);
  const hasClips = Array.isArray(snapshot.clips) && snapshot.clips.length > 0;
  return hasSource || hasClips;
}

export function validateProjectSnapshot(raw) {
  if (!raw || typeof raw !== 'object') {
    return fail(ERROR_CODES.E_STORAGE_UNAVAILABLE, 'Saved project record is empty or invalid.');
  }
  const built = buildProjectSnapshot(
    {
      source: raw.sourceMeta,
      clips: raw.clips,
      selectedClipId: raw.selectedClipId,
      draft: raw.draft,
      exportSettings: raw.exportSettings,
      ui: { zoom: raw.zoom }
    },
    typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now()
  );
  if (!built.ok) {
    return built;
  }
  return ok(built.value);
}

export function compareSourceFileToSnapshot(snapshotSourceMeta, loadedSource) {
  if (!loadedSource || typeof loadedSource !== 'object') {
    return fail(ERROR_CODES.E_EMPTY_FILE, 'Loaded source metadata is missing.');
  }
  if (!snapshotSourceMeta || typeof snapshotSourceMeta !== 'object') {
    return ok({ exactMatch: true, mismatches: [] });
  }
  const mismatches = [];
  if (snapshotSourceMeta.name !== loadedSource.name) {
    mismatches.push(`filename differs (saved "${snapshotSourceMeta.name}", opened "${loadedSource.name}")`);
  }
  if (Number(snapshotSourceMeta.size) !== Number(loadedSource.size)) {
    const savedSize = formatFileSize(snapshotSourceMeta.size);
    const loadedSize = formatFileSize(loadedSource.size);
    mismatches.push(
      `file size differs (saved ${savedSize.ok ? savedSize.value : snapshotSourceMeta.size}, opened ${loadedSize.ok ? loadedSize.value : loadedSource.size})`
    );
  }
  const durDiff = Math.abs(Number(snapshotSourceMeta.durationSec) - Number(loadedSource.durationSec));
  if (!Number.isFinite(durDiff) || durDiff > RECOVERY_DURATION_TOLERANCE_SEC) {
    const savedDur = formatTimestamp(snapshotSourceMeta.durationSec);
    const loadedDur = formatTimestamp(loadedSource.durationSec);
    mismatches.push(
      `duration differs (saved ${savedDur.ok ? savedDur.value : snapshotSourceMeta.durationSec}s, opened ${loadedDur.ok ? loadedDur.value : loadedSource.durationSec}s)`
    );
  }
  return ok({
    exactMatch: mismatches.length === 0,
    mismatches
  });
}

export function reconcileRecoveredClips(clips, durationSec) {
  if (!Array.isArray(clips)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Recovered clips must be an array.');
  }
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'Target video duration must be positive.');
  }
  const result = [];
  let keptCount = 0;
  let clampedCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < clips.length; i += 1) {
    const clean = sanitizeClipForStorage(clips[i], i);
    if (!clean) {
      droppedCount += 1;
      continue;
    }
    if (clean.startSec >= durationSec - MIN_RECONCILED_CLIP_SEC) {
      droppedCount += 1;
      continue;
    }
    if (clean.endSec > durationSec) {
      const clampedEnd = Math.round(durationSec * 1000) / 1000;
      if (clampedEnd - clean.startSec < MIN_RECONCILED_CLIP_SEC) {
        droppedCount += 1;
        continue;
      }
      result.push({ ...clean, endSec: clampedEnd });
      clampedCount += 1;
    } else {
      result.push(clean);
      keptCount += 1;
    }
  }
  return ok({ clips: result, keptCount, clampedCount, droppedCount });
}

export function createExportHistoryRecord(input, nowMs = Date.now()) {
  if (!input || typeof input !== 'object') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Export history record input is required.');
  }
  const filename = typeof input.filename === 'string' && input.filename.trim()
    ? input.filename.trim().slice(0, 140)
    : '';
  if (!filename) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Export history record requires a filename.');
  }
  const outputBytes = Number(input.outputBytes);
  const startSec = Number(input.startSec);
  const endSec = Number(input.endSec);
  const durationSec = Number(input.durationSec);
  const createdAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  const id = typeof input.id === 'string' && input.id.trim()
    ? input.id.trim()
    : `hist_${createdAt}_${Math.random().toString(36).slice(2, 8)}`;

  return ok({
    id,
    createdAt,
    sourceName: typeof input.sourceName === 'string' ? input.sourceName.trim().slice(0, 120) : '',
    clipName: typeof input.clipName === 'string' && input.clipName.trim() ? input.clipName.trim().slice(0, 80) : 'Clip',
    filename,
    startSec: Number.isFinite(startSec) && startSec >= 0 ? Math.round(startSec * 1000) / 1000 : 0,
    endSec: Number.isFinite(endSec) && endSec >= 0 ? Math.round(endSec * 1000) / 1000 : 0,
    durationSec: Number.isFinite(durationSec) && durationSec >= 0 ? Math.round(durationSec * 1000) / 1000 : 0,
    format: VALID_FORMATS.has(input.format) ? input.format : 'mp4',
    mode: VALID_MODES.has(input.mode) ? input.mode : 'precise',
    outputBytes: Number.isFinite(outputBytes) && outputBytes >= 0 ? Math.round(outputBytes) : 0,
    delivery: VALID_DELIVERIES.has(input.delivery) ? input.delivery : 'exported'
  });
}

/* --- IndexedDB Low-Level Wrapper --- */

function idbRequestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function idbTxComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function closeStorageDb() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* Ignore close errors. */
    }
    cachedDb = null;
    cachedDbName = null;
  }
  return ok(true);
}

export async function openStorageDb(options = {}) {
  const idb = options.idb !== undefined ? options.idb : (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const dbName = typeof options.dbName === 'string' && options.dbName ? options.dbName : STORAGE_DB_NAME;

  if (!isStorageAvailable(idb)) {
    return fail(ERROR_CODES.E_STORAGE_UNAVAILABLE);
  }
  if (!options.idb && cachedDb && cachedDbName === dbName) {
    return ok(cachedDb);
  }

  try {
    const db = await new Promise((resolve, reject) => {
      const req = idb.open(dbName, STORAGE_DB_VERSION);
      req.onupgradeneeded = () => {
        const upgradeDb = req.result;
        if (!upgradeDb.objectStoreNames.contains(STORE_PROJECTS)) {
          upgradeDb.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        }
        if (!upgradeDb.objectStoreNames.contains(STORE_EXPORT_HISTORY)) {
          upgradeDb.createObjectStore(STORE_EXPORT_HISTORY, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    });

    db.onversionchange = () => {
      db.close();
      if (cachedDb === db) {
        cachedDb = null;
        cachedDbName = null;
      }
    };

    if (!options.idb) {
      cachedDb = db;
      cachedDbName = dbName;
    }
    return ok(db);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function saveProjectSnapshot(state, options = {}) {
  const snapRes = buildProjectSnapshot(state, options.nowMs);
  if (!snapRes.ok) {
    return snapRes;
  }
  const dbRes = await openStorageDb(options);
  if (!dbRes.ok) {
    return dbRes;
  }
  try {
    const tx = dbRes.value.transaction(STORE_PROJECTS, 'readwrite');
    const txDone = idbTxComplete(tx);
    tx.objectStore(STORE_PROJECTS).put(snapRes.value);
    await txDone;
    return ok(snapRes.value);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function loadProjectSnapshot(options = {}) {
  const dbRes = await openStorageDb(options);
  if (!dbRes.ok) {
    return dbRes;
  }
  try {
    const tx = dbRes.value.transaction(STORE_PROJECTS, 'readonly');
    const raw = await idbRequestToPromise(tx.objectStore(STORE_PROJECTS).get(ACTIVE_PROJECT_KEY));
    if (!raw) {
      return ok(null);
    }
    const valid = validateProjectSnapshot(raw);
    return valid.ok ? ok(valid.value) : ok(null);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function clearProjectSnapshot(options = {}) {
  const dbRes = await openStorageDb(options);
  if (!dbRes.ok) {
    return dbRes;
  }
  try {
    const tx = dbRes.value.transaction(STORE_PROJECTS, 'readwrite');
    const txDone = idbTxComplete(tx);
    tx.objectStore(STORE_PROJECTS).delete(ACTIVE_PROJECT_KEY);
    await txDone;
    return ok(true);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function appendExportHistoryEntry(input, options = {}) {
  const recRes = createExportHistoryRecord(input, options.nowMs);
  if (!recRes.ok) {
    return recRes;
  }
  const dbRes = await openStorageDb(options);
  if (!dbRes.ok) {
    return dbRes;
  }
  try {
    const tx = dbRes.value.transaction(STORE_EXPORT_HISTORY, 'readwrite');
    const txDone = idbTxComplete(tx);
    const os = tx.objectStore(STORE_EXPORT_HISTORY);
    os.put(recRes.value);
    const getAllReq = os.getAll();
    getAllReq.onsuccess = () => {
      const all = getAllReq.result;
      if (Array.isArray(all) && all.length > MAX_EXPORT_HISTORY) {
        all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const excess = all.slice(MAX_EXPORT_HISTORY);
        for (const oldItem of excess) {
          if (oldItem && oldItem.id) {
            os.delete(oldItem.id);
          }
        }
      }
    };
    await txDone;
    return ok(recRes.value);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function listExportHistory(options = {}) {
  const dbRes = await openStorageDb(options);
  if (!dbRes.ok) {
    return dbRes;
  }
  try {
    const tx = dbRes.value.transaction(STORE_EXPORT_HISTORY, 'readonly');
    const rows = await idbRequestToPromise(tx.objectStore(STORE_EXPORT_HISTORY).getAll());
    const sorted = Array.isArray(rows)
      ? rows.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      : [];
    return ok(sorted);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function clearExportHistory(options = {}) {
  const dbRes = await openStorageDb(options);
  if (!dbRes.ok) {
    return dbRes;
  }
  try {
    const tx = dbRes.value.transaction(STORE_EXPORT_HISTORY, 'readwrite');
    const txDone = idbTxComplete(tx);
    tx.objectStore(STORE_EXPORT_HISTORY).clear();
    await txDone;
    return ok(true);
  } catch (err) {
    return { ok: false, error: classifyStorageError(err) };
  }
}

export async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') {
    return ok({ supported: false, persisted: false });
  }
  try {
    let already = false;
    if (typeof navigator.storage.persisted === 'function') {
      already = Boolean(await navigator.storage.persisted());
    }
    if (already) {
      return ok({ supported: true, persisted: true });
    }
    const granted = Boolean(await navigator.storage.persist());
    return ok({ supported: true, persisted: granted });
  } catch {
    return ok({ supported: false, persisted: false });
  }
}

export async function getStorageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return ok({ supported: false, usageBytes: null, quotaBytes: null });
  }
  try {
    const est = await navigator.storage.estimate();
    return ok({
      supported: true,
      usageBytes: typeof est.usage === 'number' && Number.isFinite(est.usage) ? est.usage : null,
      quotaBytes: typeof est.quota === 'number' && Number.isFinite(est.quota) ? est.quota : null
    });
  } catch {
    return ok({ supported: false, usageBytes: null, quotaBytes: null });
  }
}

/* --- Autosave, Recovery & Export History UI Controller --- */

function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function formatClockTime(epochMs) {
  if (!epochMs || !Number.isFinite(epochMs)) {
    return '';
  }
  try {
    return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function formatDateTime(epochMs) {
  if (!epochMs || !Number.isFinite(epochMs)) {
    return 'Unknown time';
  }
  try {
    return new Date(epochMs).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'Recently';
  }
}

function renderStorageStatusUi() {
  if (!controllerRefs) {
    return;
  }
  const { storagePill, storageInfo, persistBtn, recoveryBanner, recoveryText } = controllerRefs;

  if (storagePill) {
    const mode = storageUiState.mode;
    let label = 'Autosave: Ready';
    let mod = 'idle';
    if (mode === 'saving') {
      label = 'Autosave: Saving…';
      mod = 'loading';
    } else if (mode === 'saved') {
      label = `Saved ${formatClockTime(storageUiState.lastSavedAt)}`;
      mod = 'success';
    } else if (mode === 'full') {
      label = 'Storage Full';
      mod = 'failure';
    } else if (mode === 'unavailable') {
      label = 'Autosave Off';
      mod = 'cancelled';
    }
    storagePill.textContent = label;
    storagePill.className = `status-pill status-pill--${mod}`;
  }

  if (storageInfo) {
    const parts = [];
    if (storageUiState.mode === 'unavailable') {
      parts.push('IndexedDB is unavailable in this browser mode (autosave disabled).');
    } else if (storageUiState.mode === 'full') {
      parts.push('Browser storage quota is full; free space or clear export history.');
    } else {
      parts.push(
        storageUiState.lastSavedAt > 0
          ? `Project metadata autosaved at ${formatClockTime(storageUiState.lastSavedAt)} (video files are never stored).`
          : 'Autosaves clip ranges, crop settings, and export preferences locally in IndexedDB.'
      );
    }
    if (storageUiState.persistSupported) {
      parts.push(storageUiState.persisted ? 'Storage: Persistent' : 'Storage: Best-effort');
    }
    if (storageUiState.usageBytes !== null && storageUiState.quotaBytes !== null) {
      const u = formatFileSize(storageUiState.usageBytes);
      const q = formatFileSize(storageUiState.quotaBytes);
      if (u.ok && q.ok) {
        parts.push(`Browser quota: ${u.value} / ${q.value}`);
      }
    }
    storageInfo.textContent = parts.join(' • ');
  }

  if (persistBtn) {
    persistBtn.hidden = !storageUiState.persistSupported || storageUiState.persisted;
    persistBtn.disabled = !storageUiState.persistSupported || storageUiState.persisted;
  }

  if (recoveryBanner && recoveryText) {
    if (pendingRecovery) {
      const meta = pendingRecovery.sourceMeta;
      const clipCount = pendingRecovery.clips.length;
      if (meta) {
        const sizeRes = formatFileSize(meta.size);
        const durRes = formatTimestamp(meta.durationSec);
        recoveryText.textContent = `Recovery pending: re-select "${meta.name}" (${sizeRes.ok ? sizeRes.value : `${meta.size} B`}, ${durRes.ok ? durRes.value : `${meta.durationSec}s`}) to re-attach ${clipCount} saved ${clipCount === 1 ? 'clip' : 'clips'}.`;
      } else {
        recoveryText.textContent = `Recovery pending: open a video file to re-attach ${clipCount} saved ${clipCount === 1 ? 'clip' : 'clips'}.`;
      }
      recoveryBanner.hidden = false;
    } else {
      recoveryBanner.hidden = true;
    }
  }
}

function renderExportHistoryList(rows) {
  if (!controllerRefs) {
    return;
  }
  const { historyList, historyEmpty, historyClearBtn } = controllerRefs;
  const list = Array.isArray(rows) ? rows : [];
  storageUiState.historyCount = list.length;

  if (historyEmpty) {
    historyEmpty.hidden = list.length > 0;
  }
  if (historyClearBtn) {
    historyClearBtn.disabled = list.length === 0;
  }
  if (!historyList) {
    return;
  }
  clearChildren(historyList);

  for (const row of list) {
    const li = makeEl('li', 'history-item');

    const head = makeEl('div', 'history-item__head');
    head.appendChild(makeEl('span', 'history-item__name', row.filename || row.clipName || 'Clip'));
    const pillMod = row.delivery === 'downloaded' || row.delivery === 'zipped' ? 'success' : 'ready';
    head.appendChild(makeEl('span', `status-pill status-pill--${pillMod}`, row.delivery || 'exported'));
    li.appendChild(head);

    const sizeRes = formatFileSize(row.outputBytes || 0);
    const metaParts = [
      formatDateTime(row.createdAt),
      row.clipName || 'Clip',
      `${row.durationSec || 0}s`,
      `${String(row.format || 'mp4').toUpperCase()} (${row.mode || 'precise'})`,
      sizeRes.ok ? sizeRes.value : `${row.outputBytes || 0} B`
    ];
    if (row.sourceName) {
      metaParts.push(`from ${row.sourceName}`);
    }
    li.appendChild(makeEl('p', 'history-item__meta', metaParts.join(' • ')));
    historyList.appendChild(li);
  }
}

async function refreshStorageMetrics() {
  const estRes = await getStorageEstimate();
  if (estRes.ok && estRes.value.supported) {
    storageUiState.usageBytes = estRes.value.usageBytes;
    storageUiState.quotaBytes = estRes.value.quotaBytes;
  }
  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persisted === 'function') {
    storageUiState.persistSupported = typeof navigator.storage.persist === 'function';
    try {
      storageUiState.persisted = Boolean(await navigator.storage.persisted());
    } catch {
      storageUiState.persisted = false;
    }
  }
  renderStorageStatusUi();
}

function handleStorageWriteFailure(appError) {
  if (appError.code === ERROR_CODES.E_STORAGE_FULL) {
    storageUiState.mode = 'full';
    renderStorageStatusUi();
    if (!storageFullReported) {
      storageFullReported = true;
      reportError(appError);
    }
    return;
  }
  storageUiState.mode = 'unavailable';
  renderStorageStatusUi();
  if (!storageUnavailableReported) {
    storageUnavailableReported = true;
    reportError(appError);
  }
}

export async function flushProjectAutosave(stateOverride) {
  if (autosaveTimerId !== null) {
    clearTimeout(autosaveTimerId);
    autosaveTimerId = null;
  }
  if (!autosaveArmed || pendingRecovery) {
    pendingSaveState = null;
    return ok(false);
  }
  const targetState = stateOverride || pendingSaveState || store.getState();
  pendingSaveState = null;

  const snapRes = buildProjectSnapshot(targetState);
  if (!snapRes.ok) {
    return snapRes;
  }
  if (!isSnapshotRecoverable(snapRes.value)) {
    const cleared = await clearProjectSnapshot();
    if (!cleared.ok) {
      handleStorageWriteFailure(cleared.error);
      return cleared;
    }
    storageUiState.mode = 'idle';
    storageUiState.lastSavedAt = 0;
    renderStorageStatusUi();
    return ok(false);
  }

  storageUiState.mode = 'saving';
  renderStorageStatusUi();

  const writeRes = await saveProjectSnapshot(targetState);
  if (!writeRes.ok) {
    handleStorageWriteFailure(writeRes.error);
    return writeRes;
  }

  storageFullReported = false;
  storageUiState.mode = 'saved';
  storageUiState.lastSavedAt = writeRes.value.savedAt;

  if (!persistRequestedOnce) {
    persistRequestedOnce = true;
    const persistRes = await requestPersistentStorage();
    if (persistRes.ok) {
      storageUiState.persistSupported = persistRes.value.supported;
      storageUiState.persisted = persistRes.value.persisted;
    }
  }
  await refreshStorageMetrics();
  return ok(writeRes.value);
}

export function scheduleProjectAutosave(state) {
  if (!autosaveArmed || pendingRecovery) {
    return ok(false);
  }
  pendingSaveState = state || store.getState();
  if (autosaveTimerId !== null) {
    clearTimeout(autosaveTimerId);
  }
  autosaveTimerId = setTimeout(() => {
    autosaveTimerId = null;
    flushProjectAutosave();
  }, AUTOSAVE_DEBOUNCE_MS);
  return ok(true);
}

export function isRecoveryPending() {
  return Boolean(pendingRecovery);
}

async function discardPendingRecovery(silent = false) {
  pendingRecovery = null;
  await clearProjectSnapshot();
  if (store.getState().ui.status === 'recovery') {
    store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });
  }
  renderStorageStatusUi();
  if (!silent) {
    notifyToast('Saved session discarded', 'Starting with a clean workspace.', 'info', 3000);
  }
  return ok(true);
}

export async function checkAndOfferRecovery() {
  await refreshStorageMetrics();
  await refreshExportHistoryUi();

  if (!isStorageAvailable()) {
    storageUiState.mode = 'unavailable';
    autosaveArmed = false;
    renderStorageStatusUi();
    if (!storageUnavailableReported) {
      storageUnavailableReported = true;
      reportError(createAppError(ERROR_CODES.E_STORAGE_UNAVAILABLE));
    }
    return ok(null);
  }

  const loaded = await loadProjectSnapshot();
  if (!loaded.ok) {
    handleStorageWriteFailure(loaded.error);
    autosaveArmed = true;
    return loaded;
  }

  const snapshot = loaded.value;
  if (!snapshot || !isSnapshotRecoverable(snapshot)) {
    autosaveArmed = true;
    renderStorageStatusUi();
    return ok(null);
  }

  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'recovery' });

  const meta = snapshot.sourceMeta;
  const clipCount = snapshot.clips.length;
  const whenText = formatDateTime(snapshot.savedAt);
  const filePart = meta
    ? `"${meta.name}" (${formatFileSize(meta.size).value || `${meta.size} B`}, ${formatTimestamp(meta.durationSec).value || `${meta.durationSec}s`})`
    : 'a previous video';

  const confirmRes = await openConfirmDialog({
    title: 'Restore Previous Session?',
    message: `Found an autosaved project from ${whenText} for ${filePart} with ${clipCount} ${clipCount === 1 ? 'clip' : 'clips'}. Browsers cannot reopen local video files automatically—restore your clips and re-select the video file?`,
    confirmLabel: 'Restore session',
    cancelLabel: 'Discard saved'
  });

  if (!confirmRes.ok || !confirmRes.value) {
    await discardPendingRecovery(false);
    autosaveArmed = true;
    return ok(null);
  }

  pendingRecovery = snapshot;
  store.dispatch({ type: ACTIONS.SET_EXPORT_SETTINGS, payload: snapshot.exportSettings });
  autosaveArmed = true;
  renderStorageStatusUi();
  notifyToast(
    'Session ready to re-attach',
    meta ? `Open "${meta.name}" to restore ${clipCount} clip(s).` : 'Open your video file to restore clips.',
    'info',
    5000
  );
  return ok(snapshot);
}

function applyRecoveredSnapshotToStore(snapshot, clipsToApply, durationSec) {
  const safeStart = Math.max(0, Math.min(snapshot.draft.startSec, durationSec));
  const safeEnd = Math.max(safeStart, Math.min(snapshot.draft.endSec, durationSec));
  const preferredSelected = snapshot.selectedClipId && clipsToApply.some((c) => c.id === snapshot.selectedClipId)
    ? snapshot.selectedClipId
    : (clipsToApply[0] ? clipsToApply[0].id : null);

  store.dispatch({ type: ACTIONS.SET_EXPORT_SETTINGS, payload: snapshot.exportSettings });
  store.dispatch({ type: ACTIONS.CLIPS_REPLACE_NO_HISTORY, payload: clipsToApply });
  store.dispatch({ type: ACTIONS.SET_SELECTED_CLIP, payload: preferredSelected });
  store.dispatch({ type: ACTIONS.SET_DRAFT, payload: { startSec: safeStart, endSec: safeEnd } });
  store.dispatch({ type: ACTIONS.SET_UI_ZOOM, payload: snapshot.zoom || 1 });
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });
}

export async function handleSourceLoadedForRecovery(loadedSource) {
  if (!pendingRecovery || !loadedSource) {
    return ok(false);
  }
  const snapshot = pendingRecovery;
  const cmpRes = compareSourceFileToSnapshot(snapshot.sourceMeta, loadedSource);
  const reconciledRes = reconcileRecoveredClips(snapshot.clips, loadedSource.durationSec);
  if (!cmpRes.ok || !reconciledRes.ok) {
    return ok(false);
  }

  const { exactMatch, mismatches } = cmpRes.value;
  const { clips, clampedCount, droppedCount } = reconciledRes.value;

  if (exactMatch && clampedCount === 0 && droppedCount === 0) {
    pendingRecovery = null;
    applyRecoveredSnapshotToStore(snapshot, clips, loadedSource.durationSec);
    renderStorageStatusUi();
    await flushProjectAutosave(store.getState());
    notifyToast(
      'Session restored',
      `Matched "${loadedSource.name}" and re-attached ${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}.`,
      'success',
      4500
    );
    return ok(true);
  }

  const adjustSummary = (clampedCount > 0 || droppedCount > 0)
    ? ` Adjusting to this video will clamp ${clampedCount} clip(s) and drop ${droppedCount} out-of-range clip(s).`
    : ' All clip ranges fit within this video.';

  const confirmRes = await openConfirmDialog({
    title: 'Selected Video Does Not Match Saved Project',
    message: `Mismatch detected: ${mismatches.join('; ')}.${adjustSummary} Apply the saved clips to this video anyway, or keep recovery pending so you can pick the original file?`,
    confirmLabel: 'Apply to this video',
    cancelLabel: 'Keep recovery pending'
  });

  if (!confirmRes.ok || !confirmRes.value) {
    notifyToast('Recovery kept pending', 'Open the original video file or discard recovery in the banner.', 'info', 4000);
    return ok(false);
  }

  pendingRecovery = null;
  applyRecoveredSnapshotToStore(snapshot, clips, loadedSource.durationSec);
  renderStorageStatusUi();
  await flushProjectAutosave(store.getState());
  notifyToast(
    'Recovered clips applied',
    `${clips.length} clip(s) attached${clampedCount > 0 ? ` (${clampedCount} clamped)` : ''}${droppedCount > 0 ? ` (${droppedCount} dropped)` : ''}.`,
    clampedCount > 0 || droppedCount > 0 ? 'warning' : 'success',
    5000
  );
  return ok(true);
}

export async function handleSourceClearedForStorage() {
  if (pendingRecovery) {
    return ok(false);
  }
  await clearProjectSnapshot();
  storageUiState.mode = 'idle';
  storageUiState.lastSavedAt = 0;
  renderStorageStatusUi();
  return ok(true);
}

export async function refreshExportHistoryUi() {
  const listRes = await listExportHistory();
  if (!listRes.ok) {
    renderExportHistoryList([]);
    return listRes;
  }
  renderExportHistoryList(listRes.value);
  return listRes;
}

export async function recordExportHistory(input) {
  if (!isStorageAvailable()) {
    return ok(false);
  }
  const addRes = await appendExportHistoryEntry(input);
  if (!addRes.ok) {
    handleStorageWriteFailure(addRes.error);
    return addRes;
  }
  await refreshExportHistoryUi();
  await refreshStorageMetrics();
  return addRes;
}

export function initStorageController(refs, callbacks = {}) {
  if (!refs) {
    return fail(ERROR_CODES.E_STORAGE_UNAVAILABLE, 'Missing storage UI DOM elements.');
  }
  if (controllerInitialized) {
    return ok(true);
  }
  controllerInitialized = true;
  controllerRefs = refs;
  controllerCallbacks = callbacks || {};

  if (refs.recoveryOpenBtn) {
    refs.recoveryOpenBtn.addEventListener('click', () => {
      if (typeof controllerCallbacks.onPickRecoveryFile === 'function') {
        controllerCallbacks.onPickRecoveryFile();
      }
    });
  }

  if (refs.recoveryDiscardBtn) {
    refs.recoveryDiscardBtn.addEventListener('click', async () => {
      await discardPendingRecovery(false);
    });
  }

  if (refs.persistBtn) {
    refs.persistBtn.addEventListener('click', async () => {
      const res = await requestPersistentStorage();
      if (res.ok) {
        storageUiState.persistSupported = res.value.supported;
        storageUiState.persisted = res.value.persisted;
        renderStorageStatusUi();
        notifyToast(
          res.value.persisted ? 'Persistent storage granted' : 'Persistent storage not granted',
          res.value.persisted
            ? 'The browser will try not to evict your autosaved projects automatically.'
            : 'Your browser kept best-effort storage; installing as a PWA often enables persistence.',
          res.value.persisted ? 'success' : 'info',
          4000
        );
      }
    });
  }

  if (refs.historyClearBtn) {
    refs.historyClearBtn.addEventListener('click', async () => {
      const confirmRes = await openConfirmDialog({
        title: 'Clear Export History?',
        message: 'Remove all saved export history entries from local IndexedDB storage? Already downloaded video files on your device are not affected.',
        confirmLabel: 'Clear history',
        cancelLabel: 'Keep'
      });
      if (!confirmRes.ok || !confirmRes.value) {
        return;
      }
      const res = await clearExportHistory();
      if (!res.ok) {
        reportError(res.error);
        return;
      }
      await refreshExportHistoryUi();
      await refreshStorageMetrics();
      notifyToast('Export history cleared', 'All local export history metadata removed.', 'info', 3000);
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushProjectAutosave();
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      flushProjectAutosave();
    });
  }

  renderStorageStatusUi();
  return ok(true);
}
