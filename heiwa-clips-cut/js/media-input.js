/* Stage 2 module: local file picker, drag-and-drop, validation, and object URL lifecycle. */

import { ACTIONS, store } from './store.js';
import { createAppError, ERROR_CODES, fail, notifyToast, ok, reportError } from './errors.js';
import { analyzeVideoFile } from './metadata.js';
import {
  clearPreview,
  loadVideoIntoPreview,
  setPreviewError,
  setPreviewIdle,
  setPreviewReady
} from './preview.js';

let activeFile = null;
let activeObjectUrl = null;
let activeAnalysis = null;
let loadSequence = 0;
let initialized = false;

export function getActiveSourceFile() {
  return activeFile;
}

export function getActiveObjectUrl() {
  return activeObjectUrl;
}

export function getActiveAnalysis() {
  return activeAnalysis;
}

export function revokeActiveObjectUrl() {
  if (!activeObjectUrl) {
    return ok(false);
  }
  try {
    URL.revokeObjectURL(activeObjectUrl);
  } catch {
    /* Ignore revoke errors if URL was already invalidated. */
  }
  activeObjectUrl = null;
  return ok(true);
}

export async function validateBasicVideoFile(file) {
  if (!file || typeof file !== 'object' || typeof file.size !== 'number') {
    return fail(ERROR_CODES.E_EMPTY_FILE);
  }
  if (file.size <= 0) {
    return fail(ERROR_CODES.E_EMPTY_FILE);
  }
  if (typeof file.slice !== 'function') {
    return fail(ERROR_CODES.E_CORRUPT_FILE, 'File object cannot be sliced for streaming reads.');
  }
  try {
    const headBlob = file.slice(0, Math.min(32, file.size));
    const buffer = await headBlob.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      return fail(ERROR_CODES.E_CORRUPT_FILE, 'Could not read bytes from the selected file.');
    }
    return ok(new Uint8Array(buffer));
  } catch {
    return fail(
      ERROR_CODES.E_CORRUPT_FILE,
      'The selected file could not be read from disk.',
      'Check file permissions or re-select the video from local storage.'
    );
  }
}

export function clearSource(onAnalysisChange) {
  loadSequence += 1;
  clearPreview();
  revokeActiveObjectUrl();
  activeFile = null;
  activeAnalysis = null;

  store.dispatch({ type: ACTIONS.RESET_PROJECT });
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });
  setPreviewIdle();

  if (typeof onAnalysisChange === 'function') {
    onAnalysisChange(null);
  }
  return ok(true);
}

function finalizeLoadFailure(appError, onAnalysisChange) {
  clearPreview();
  revokeActiveObjectUrl();
  activeFile = null;
  activeAnalysis = null;

  store.dispatch({ type: ACTIONS.RESET_PROJECT });
  store.dispatch({ type: ACTIONS.SET_UI_ERROR, payload: appError });
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'failure' });
  setPreviewError(appError);

  if (typeof onAnalysisChange === 'function') {
    onAnalysisChange({ error: appError });
  }
  reportError(appError);
  return { ok: false, error: appError };
}

export async function handleSelectedVideoFile(file, onAnalysisChange) {
  const currentSeq = loadSequence + 1;
  loadSequence = currentSeq;

  store.dispatch({ type: ACTIONS.SET_UI_ERROR, payload: null });
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'loading' });

  const basicCheck = await validateBasicVideoFile(file);
  if (currentSeq !== loadSequence) {
    return fail(ERROR_CODES.E_CANCELLED);
  }
  if (!basicCheck.ok) {
    return finalizeLoadFailure(basicCheck.error, onAnalysisChange);
  }

  /* Release any previous source before creating a new object URL so replacing never leaks. */
  clearPreview();
  revokeActiveObjectUrl();
  activeFile = null;
  activeAnalysis = null;

  let nextUrl = null;
  try {
    nextUrl = URL.createObjectURL(file);
  } catch {
    return finalizeLoadFailure(
      createAppError(ERROR_CODES.E_CORRUPT_FILE, 'Could not create an object URL for the selected file.'),
      onAnalysisChange
    );
  }
  activeObjectUrl = nextUrl;

  const videoRes = await loadVideoIntoPreview(nextUrl, file.name);
  if (currentSeq !== loadSequence) {
    if (activeObjectUrl === nextUrl) {
      revokeActiveObjectUrl();
    }
    return fail(ERROR_CODES.E_CANCELLED);
  }

  const capabilities = store.getState().capabilities;
  const analysisRes = await analyzeVideoFile(
    file,
    videoRes.ok ? videoRes.value : null,
    capabilities
  );

  if (currentSeq !== loadSequence) {
    if (activeObjectUrl === nextUrl) {
      revokeActiveObjectUrl();
    }
    return fail(ERROR_CODES.E_CANCELLED);
  }

  if (!analysisRes.ok) {
    const preferredError = !videoRes.ok && videoRes.error.code === ERROR_CODES.E_LOAD_TIMEOUT
      ? videoRes.error
      : analysisRes.error;
    return finalizeLoadFailure(preferredError, onAnalysisChange);
  }

  if (!videoRes.ok) {
    if (!analysisRes.value.compatibility.canDecodeVideo) {
      return finalizeLoadFailure(
        createAppError(
          ERROR_CODES.E_UNSUPPORTED_CODEC,
          `Video codec "${analysisRes.value.source.videoCodec}" cannot be decoded by this browser.`
        ),
        onAnalysisChange
      );
    }
    return finalizeLoadFailure(videoRes.error, onAnalysisChange);
  }

  activeFile = file;
  activeAnalysis = {
    compatibility: analysisRes.value.compatibility,
    warnings: analysisRes.value.warnings,
    error: null
  };

  store.dispatch({ type: ACTIONS.RESET_PROJECT });
  store.dispatch({ type: ACTIONS.SET_SOURCE, payload: analysisRes.value.source });
  store.dispatch({
    type: ACTIONS.SET_DRAFT,
    payload: { startSec: 0, endSec: Math.min(15, analysisRes.value.source.durationSec) }
  });
  store.dispatch({ type: ACTIONS.SET_UI_ERROR, payload: null });
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });

  setPreviewReady(analysisRes.value.source.durationSec);

  if (typeof onAnalysisChange === 'function') {
    onAnalysisChange(activeAnalysis);
  }

  if (!analysisRes.value.compatibility.canDecodeVideo) {
    reportError(
      createAppError(
        ERROR_CODES.E_UNSUPPORTED_CODEC,
        `Preview loaded, but WebCodecs cannot decode "${analysisRes.value.source.videoCodec}" for export.`
      )
    );
  } else {
    notifyToast(
      `Loaded "${analysisRes.value.source.name}"`,
      `${analysisRes.value.source.width}×${analysisRes.value.source.height} • ${analysisRes.value.source.fps} fps`,
      'success',
      3500
    );
  }

  return ok(analysisRes.value);
}

export function initMediaInput(refs, onAnalysisChange) {
  if (!refs || !refs.filePicker || !refs.dropzone) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing media input DOM elements.');
  }
  if (initialized) {
    return ok(true);
  }
  initialized = true;

  const { filePicker, openBtn, replaceBtn, clearBtn, dropzone } = refs;

  const openPicker = () => {
    filePicker.value = '';
    filePicker.click();
  };

  if (openBtn) {
    openBtn.addEventListener('click', openPicker);
  }

  if (replaceBtn) {
    replaceBtn.addEventListener('click', openPicker);
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearSource(onAnalysisChange);
      notifyToast('Source cleared', 'Object URL released and workspace reset.', 'info', 3000);
    });
  }

  filePicker.addEventListener('change', () => {
    const file = filePicker.files && filePicker.files[0] ? filePicker.files[0] : null;
    if (!file) {
      return;
    }
    handleSelectedVideoFile(file, onAnalysisChange);
  });

  let dragDepth = 0;

  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add('dropzone--active');
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropzone.classList.remove('dropzone--active');
    }
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('dropzone--active');
    const files = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : null;
    const file = files && files[0] ? files[0] : null;
    if (!file) {
      return;
    }
    handleSelectedVideoFile(file, onAnalysisChange);
  });

  dropzone.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) {
      return;
    }
    openPicker();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      revokeActiveObjectUrl();
    });
  }

  return ok(true);
}
