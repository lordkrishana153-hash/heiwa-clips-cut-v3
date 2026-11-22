/* Application bootstrap and wiring only. */

import { ACTIONS, store } from './store.js';
import { describeCapabilities, detectCapabilities } from './capabilities.js';
import { createAppError, ERROR_CODES, notifyToast, reportError } from './errors.js';
import { formatTimestamp } from './time.js';
import { formatFileSize } from './metadata.js';
import { getActiveAnalysis, initMediaInput } from './media-input.js';
import {
  initPreview,
  playClipRange,
  seekPreviewTo,
  stepPreviewBySeconds,
  stepPreviewFrame,
  togglePreviewPlayback
} from './preview.js';
import {
  getAdjacentClip,
  initClips,
  renderClipsPanel,
  selectClip,
  setDraftMarkerFromPlayhead,
  syncDraftInputsFromState
} from './clips.js';
import { initTimeline, renderTimeline, updateTimelinePlayhead } from './timeline.js';
import { initCrop, renderCropPanel } from './crop.js';
import {
  initExportEngine,
  isExportQueueRunning,
  refreshExportPreflight,
  renderExportEnginePanel,
  resetExportEngineForSourceChange
} from './export-queue.js';
import { initShortcuts, SHORTCUT_DEFINITIONS } from './shortcuts.js';
import {
  checkAndOfferRecovery,
  handleSourceClearedForStorage,
  handleSourceLoadedForRecovery,
  initStorageController,
  recordExportHistory,
  scheduleProjectAutosave
} from './storage.js';
import { initPwa } from './pwa.js';
import { initDialogs, openInfoDialog } from './ui/dialogs.js';
import { announceStatus, initLayout, syncUiStatusAttribute } from './ui/layout.js';

const STATUS_LABELS = Object.freeze({
  idle: 'Idle',
  loading: 'Loading',
  ready: 'Ready',
  processing: 'Processing',
  waiting: 'Waiting',
  success: 'Success',
  failure: 'Error',
  cancelled: 'Cancelled',
  recovery: 'Recovery'
});

const SEEK_STEP_SMALL_SEC = 1;
const SEEK_STEP_LARGE_SEC = 5;

function getDomRefs() {
  return {
    workspaceShell: document.getElementById('status-workspace-shell'),
    appBadge: document.getElementById('status-app-badge'),
    storagePill: document.getElementById('status-storage-pill'),
    shortcutsBtn: document.getElementById('status-shortcuts-btn'),
    dialogEl: document.getElementById('status-dialog'),
    capabilitiesList: document.getElementById('status-capabilities-list'),
    recheckBtn: document.getElementById('status-recheck-btn'),
    stageSummary: document.getElementById('status-stage-summary'),
    liveRegion: document.getElementById('status-live'),
    recoveryBanner: document.getElementById('status-recovery-banner'),
    recoveryText: document.getElementById('status-recovery-text'),
    recoveryOpenBtn: document.getElementById('status-recovery-open-btn'),
    recoveryDiscardBtn: document.getElementById('status-recovery-discard-btn'),
    storageInfo: document.getElementById('status-storage-info'),
    storagePersistBtn: document.getElementById('status-storage-persist-btn'),
    historyClearBtn: document.getElementById('status-history-clear-btn'),
    historyEmpty: document.getElementById('status-history-empty'),
    historyList: document.getElementById('status-history-list'),
    networkPill: document.getElementById('status-network-pill'),
    pwaInstallBtn: document.getElementById('status-pwa-install-btn'),
    pwaUpdateBanner: document.getElementById('status-pwa-update-banner'),
    pwaUpdateBtn: document.getElementById('status-pwa-update-btn'),
    pwaDismissBtn: document.getElementById('status-pwa-dismiss-btn'),

    filePicker: document.getElementById('input-file-picker'),
    dropzone: document.getElementById('input-dropzone'),
    openBtn: document.getElementById('input-open-btn'),
    replaceBtn: document.getElementById('input-replace-btn'),
    clearBtn: document.getElementById('input-clear-btn'),
    fileNameBadge: document.getElementById('input-file-name'),
    metadataGrid: document.getElementById('input-metadata-grid'),
    compatibilityBox: document.getElementById('input-compatibility-box'),
    warningsList: document.getElementById('input-warnings-list'),
    inputErrorBox: document.getElementById('input-error-box'),

    previewStage: document.getElementById('preview-stage'),
    video: document.getElementById('preview-video'),
    emptyState: document.getElementById('preview-empty'),
    loadingState: document.getElementById('preview-loading'),
    errorState: document.getElementById('preview-error'),
    playBtn: document.getElementById('preview-play-btn'),
    frameBackBtn: document.getElementById('preview-frame-back-btn'),
    frameFwdBtn: document.getElementById('preview-frame-fwd-btn'),
    prevClipBtn: document.getElementById('preview-prev-clip-btn'),
    jumpStartBtn: document.getElementById('preview-jump-start-btn'),
    jumpEndBtn: document.getElementById('preview-jump-end-btn'),
    nextClipBtn: document.getElementById('preview-next-clip-btn'),
    currentTime: document.getElementById('preview-current-time'),
    durationTime: document.getElementById('preview-duration-time'),
    seekBar: document.getElementById('preview-seek-bar'),

    tlZoomOutBtn: document.getElementById('tl-zoom-out-btn'),
    tlZoomResetBtn: document.getElementById('tl-zoom-reset-btn'),
    tlZoomInBtn: document.getElementById('tl-zoom-in-btn'),
    tlPanLeftBtn: document.getElementById('tl-pan-left-btn'),
    tlPanRightBtn: document.getElementById('tl-pan-right-btn'),
    tlViewport: document.getElementById('tl-viewport'),
    tlTrack: document.getElementById('tl-track'),
    tlRuler: document.getElementById('tl-ruler'),
    tlDraftBar: document.getElementById('tl-draft-bar'),
    tlClipsLayer: document.getElementById('tl-clips-layer'),
    tlPlayhead: document.getElementById('tl-playhead'),
    tlEmptyHint: document.getElementById('tl-empty-hint'),

    cropFramedCanvas: document.getElementById('crop-framed-canvas'),
    cropOverlay: document.getElementById('crop-overlay'),
    cropBox: document.getElementById('crop-box'),
    cropTargetBadge: document.getElementById('crop-target-badge'),
    cropOutputInfo: document.getElementById('crop-output-info'),
    cropRatioOrigBtn: document.getElementById('crop-ratio-orig'),
    cropRatio916Btn: document.getElementById('crop-ratio-9-16'),
    cropRatio169Btn: document.getElementById('crop-ratio-16-9'),
    cropRatio11Btn: document.getElementById('crop-ratio-1-1'),
    cropRatio45Btn: document.getElementById('crop-ratio-4-5'),
    cropFitFillBtn: document.getElementById('crop-fit-fill'),
    cropFitContainBtn: document.getElementById('crop-fit-contain'),
    cropBgNoneBtn: document.getElementById('crop-bg-none'),
    cropBgBlurBtn: document.getElementById('crop-bg-blur'),
    cropBlurNote: document.getElementById('crop-blur-note'),
    cropZoomSlider: document.getElementById('crop-zoom-slider'),
    cropZoomValue: document.getElementById('crop-zoom-value'),
    cropPanReadout: document.getElementById('crop-pan-readout'),
    cropPreviewModeBtn: document.getElementById('crop-preview-mode-btn'),
    cropResetBtn: document.getElementById('crop-reset-btn'),
    cropApplyAllBtn: document.getElementById('crop-apply-all-btn'),

    clipCountBadge: document.getElementById('clip-count-badge'),
    clipUndoBtn: document.getElementById('clip-undo-btn'),
    clipRedoBtn: document.getElementById('clip-redo-btn'),
    clipDraftStart: document.getElementById('clip-draft-start'),
    clipDraftEnd: document.getElementById('clip-draft-end'),
    clipSetStartBtn: document.getElementById('clip-set-start-btn'),
    clipSetEndBtn: document.getElementById('clip-set-end-btn'),
    clipResetDraftBtn: document.getElementById('clip-draft-reset-btn'),
    clipPreset15Btn: document.getElementById('clip-preset-15'),
    clipPreset30Btn: document.getElementById('clip-preset-30'),
    clipPreset60Btn: document.getElementById('clip-preset-60'),
    clipCustomPresetInput: document.getElementById('clip-preset-custom-sec'),
    clipCustomPresetBtn: document.getElementById('clip-preset-custom-btn'),
    clipAddBtn: document.getElementById('clip-add-btn'),
    clipQuickAddBtn: document.getElementById('clip-quick-add-btn'),
    clipDraftErrorBox: document.getElementById('clip-draft-error'),
    clipCountWarning: document.getElementById('clip-count-warning'),
    clipEmptyState: document.getElementById('clip-empty-state'),
    clipListEl: document.getElementById('clip-list'),

    exportFormatMp4Btn: document.getElementById('export-format-mp4'),
    exportFormatWebmBtn: document.getElementById('export-format-webm'),
    exportModePreciseBtn: document.getElementById('export-mode-precise'),
    exportModeFastBtn: document.getElementById('export-mode-fast'),
    exportFastNote: document.getElementById('export-fast-note'),
    exportRes480Btn: document.getElementById('export-res-480'),
    exportRes720Btn: document.getElementById('export-res-720'),
    exportRes1080Btn: document.getElementById('export-res-1080'),
    exportRes1920Btn: document.getElementById('export-res-1920'),
    exportQualityLowBtn: document.getElementById('export-quality-low'),
    exportQualityMediumBtn: document.getElementById('export-quality-medium'),
    exportQualityHighBtn: document.getElementById('export-quality-high'),
    exportPreflightBtn: document.getElementById('export-preflight-btn'),
    exportPreflightBox: document.getElementById('export-preflight-box'),
    exportAllBtn: document.getElementById('export-all-btn'),
    exportSelectedBtn: document.getElementById('export-selected-btn'),
    exportCancelBtn: document.getElementById('export-cancel-btn'),
    exportRetryFailedBtn: document.getElementById('export-retry-failed-btn'),
    exportClearQueueBtn: document.getElementById('export-clear-queue-btn'),
    exportQueueSummary: document.getElementById('export-queue-summary'),
    exportQueueProgress: document.getElementById('export-queue-progress'),
    exportQueueEmpty: document.getElementById('export-queue-empty'),
    exportQueueList: document.getElementById('export-queue-list'),
    dlPanel: document.getElementById('dl-panel'),
    dlAllBtn: document.getElementById('dl-all-btn'),
    dlZipBtn: document.getElementById('dl-zip-btn'),
    dlPhoneNote: document.getElementById('dl-phone-note'),
    dlStatusBox: document.getElementById('dl-status-box')
  };
}

function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function renderStatusBadge(badgeEl, status) {
  if (!badgeEl) {
    return;
  }
  const label = STATUS_LABELS[status] || 'Idle';
  badgeEl.textContent = label;
  badgeEl.className = `status-pill status-pill--${status}`;
}

function renderCapabilityStrip(listEl, items) {
  if (!listEl) {
    return;
  }
  clearChildren(listEl);
  for (const item of items) {
    const li = document.createElement('li');
    li.className = `cap-chip cap-chip--${item.status}`;
    li.textContent = item.shortText;
    listEl.appendChild(li);
  }
}

function renderCapabilityCards(gridEl, items) {
  if (!gridEl) {
    return;
  }
  clearChildren(gridEl);
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'cap-card';

    const header = document.createElement('div');
    header.className = 'cap-card__header';

    const nameEl = document.createElement('h3');
    nameEl.className = 'cap-card__name';
    nameEl.textContent = item.label;

    const chipEl = document.createElement('span');
    chipEl.className = `cap-chip cap-chip--${item.status}`;
    chipEl.textContent = item.status === 'ok' ? 'Supported' : item.status === 'warn' ? 'Limited' : 'Unavailable';

    header.appendChild(nameEl);
    header.appendChild(chipEl);

    const detailEl = document.createElement('p');
    detailEl.className = 'cap-card__detail';
    detailEl.textContent = item.detail;

    card.appendChild(header);
    card.appendChild(detailEl);
    gridEl.appendChild(card);
  }
}

function renderInputError(boxEl, appError) {
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

function renderCompatibility(boxEl, compatibility) {
  if (!boxEl) {
    return;
  }
  if (!compatibility) {
    boxEl.hidden = true;
    clearChildren(boxEl);
    return;
  }
  clearChildren(boxEl);
  boxEl.className = `alert-box alert-box--${compatibility.status}`;

  const titleEl = document.createElement('p');
  titleEl.className = 'alert-box__title';
  titleEl.textContent = `Compatibility: ${compatibility.canDecode ? 'Can decode' : 'Cannot decode'} • ${compatibility.canEncode ? 'Can encode' : 'Cannot encode'}`;

  const detailEl = document.createElement('p');
  detailEl.textContent = compatibility.verdict;

  boxEl.appendChild(titleEl);
  boxEl.appendChild(detailEl);
  boxEl.hidden = false;
}

function renderWarnings(listEl, warnings) {
  if (!listEl) {
    return;
  }
  if (!Array.isArray(warnings) || warnings.length === 0) {
    listEl.hidden = true;
    clearChildren(listEl);
    return;
  }
  clearChildren(listEl);
  for (const warning of warnings) {
    const li = document.createElement('li');
    li.className = 'warning-item';
    li.textContent = warning.message;
    listEl.appendChild(li);
  }
  listEl.hidden = false;
}

function renderMetadata(gridEl, source) {
  if (!gridEl) {
    return;
  }
  if (!source) {
    gridEl.hidden = true;
    clearChildren(gridEl);
    return;
  }
  clearChildren(gridEl);

  const durationRes = formatTimestamp(source.durationSec);
  const sizeRes = formatFileSize(source.size);

  const rows = [
    { label: 'Duration', value: durationRes.ok ? durationRes.value : 'Unknown' },
    { label: 'Resolution', value: `${source.width} × ${source.height}` },
    { label: 'Frame Rate', value: `${source.fps} fps` },
    { label: 'Video Codec', value: source.videoCodec || 'Unknown' },
    { label: 'Audio Codec', value: source.audioCodec || 'None' },
    { label: 'File Size', value: sizeRes.ok ? sizeRes.value : `${source.size} B` }
  ];

  for (const row of rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'meta-item';

    const dt = document.createElement('dt');
    dt.className = 'meta-item__label';
    dt.textContent = row.label;

    const dd = document.createElement('dd');
    dd.className = 'meta-item__value';
    dd.textContent = row.value;

    wrapper.appendChild(dt);
    wrapper.appendChild(dd);
    gridEl.appendChild(wrapper);
  }
  gridEl.hidden = false;
}

function renderSourcePanel(refs, state, analysis) {
  const hasSource = Boolean(state.source);
  if (refs.fileNameBadge) {
    refs.fileNameBadge.textContent = hasSource ? state.source.name : 'No video loaded';
  }
  if (refs.replaceBtn) {
    refs.replaceBtn.disabled = !hasSource;
  }
  if (refs.clearBtn) {
    refs.clearBtn.disabled = !hasSource && !state.ui.error;
  }

  renderMetadata(refs.metadataGrid, state.source);
  renderCompatibility(refs.compatibilityBox, analysis ? analysis.compatibility : null);
  renderWarnings(refs.warningsList, analysis ? analysis.warnings : []);
  renderInputError(refs.inputErrorBox, state.ui.error);
}

function renderTransportControls(refs, state) {
  const hasSource = Boolean(state.source);
  const selectedClip = state.selectedClipId
    ? state.clips.find((c) => c.id === state.selectedClipId) || null
    : null;
  const hasPrev = hasSource && getAdjacentClip(state.clips, state.selectedClipId, -1).ok;
  const hasNext = hasSource && getAdjacentClip(state.clips, state.selectedClipId, 1).ok;

  if (refs.frameBackBtn) {
    refs.frameBackBtn.disabled = !hasSource;
  }
  if (refs.frameFwdBtn) {
    refs.frameFwdBtn.disabled = !hasSource;
  }
  if (refs.jumpStartBtn) {
    refs.jumpStartBtn.disabled = !hasSource || !selectedClip;
  }
  if (refs.jumpEndBtn) {
    refs.jumpEndBtn.disabled = !hasSource || !selectedClip;
  }
  if (refs.prevClipBtn) {
    refs.prevClipBtn.disabled = !hasPrev;
  }
  if (refs.nextClipBtn) {
    refs.nextClipBtn.disabled = !hasNext;
  }
}

function openShortcutsDialog() {
  openInfoDialog({
    title: 'Keyboard Shortcuts',
    lead: 'Shortcuts are disabled automatically while typing inside text fields or dialogs.',
    items: SHORTCUT_DEFINITIONS,
    closeLabel: 'Done'
  });
}

const renderCache = {
  status: null,
  capabilities: null,
  source: undefined,
  analysis: undefined,
  error: undefined,
  clips: undefined,
  selectedClipId: undefined,
  draft: undefined,
  exportSettings: undefined,
  queue: undefined,
  zoom: undefined,
  playheadSec: undefined
};

function renderState(refs, state) {
  if (renderCache.status !== state.ui.status) {
    renderCache.status = state.ui.status;
    renderStatusBadge(refs.appBadge, state.ui.status);
    syncUiStatusAttribute(refs.workspaceShell, state.ui.status);
  }

  const capabilitiesChanged = renderCache.capabilities !== state.capabilities;
  if (capabilitiesChanged) {
    renderCache.capabilities = state.capabilities;
    const described = describeCapabilities(state.capabilities);
    if (described.ok) {
      renderCapabilityStrip(refs.capabilitiesList, described.value);
      renderCapabilityCards(refs.stageSummary, described.value);
    }
  }

  const analysis = getActiveAnalysis();
  const sourceChanged = renderCache.source !== state.source;
  const draftChanged = renderCache.draft !== state.draft;
  const clipsChanged = renderCache.clips !== state.clips || renderCache.selectedClipId !== state.selectedClipId;
  const settingsChanged = renderCache.exportSettings !== state.exportSettings;
  const queueChanged = renderCache.queue !== state.queue;
  const zoomChanged = renderCache.zoom !== state.ui.zoom;

  if (sourceChanged || renderCache.analysis !== analysis || renderCache.error !== state.ui.error) {
    renderCache.source = state.source;
    renderCache.analysis = analysis;
    renderCache.error = state.ui.error;
    renderSourcePanel(refs, state, analysis);
    if (sourceChanged) {
      resetExportEngineForSourceChange();
      syncDraftInputsFromState(state);
      renderClipsPanel(state);
    }
  }

  if (draftChanged) {
    renderCache.draft = state.draft;
    syncDraftInputsFromState(state);
  }

  if (clipsChanged) {
    renderCache.clips = state.clips;
    renderCache.selectedClipId = state.selectedClipId;
    renderClipsPanel(state);
  }

  if (sourceChanged || clipsChanged) {
    renderTransportControls(refs, state);
  }

  if (sourceChanged || clipsChanged || settingsChanged) {
    renderCache.exportSettings = state.exportSettings;
    renderCropPanel(state);
  }

  if (sourceChanged || clipsChanged || settingsChanged || capabilitiesChanged || queueChanged) {
    renderCache.queue = state.queue;
    renderExportEnginePanel(state);
    if ((sourceChanged || clipsChanged || capabilitiesChanged) && !isExportQueueRunning()) {
      refreshExportPreflight(false);
    }
  }

  if (sourceChanged || draftChanged || clipsChanged || zoomChanged) {
    renderCache.zoom = state.ui.zoom;
    renderCache.playheadSec = state.playheadSec;
    renderTimeline(state, zoomChanged);
  } else if (renderCache.playheadSec !== state.playheadSec) {
    renderCache.playheadSec = state.playheadSec;
    updateTimelinePlayhead(state);
  }

  if (sourceChanged || draftChanged || clipsChanged || settingsChanged || zoomChanged) {
    scheduleProjectAutosave(state);
  }
}

async function runCapabilityProbe(refs, announceSuccess) {
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'loading' });
  try {
    const result = await detectCapabilities();
    if (!result.ok) {
      const appError = reportError(result.error);
      store.dispatch({ type: ACTIONS.SET_UI_ERROR, payload: appError });
      store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'failure' });
      return;
    }

    const caps = result.value;
    store.dispatch({ type: ACTIONS.SET_CAPABILITIES, payload: caps });
    store.dispatch({ type: ACTIONS.SET_UI_ERROR, payload: null });
    store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });

    if (!caps.webcodecs) {
      reportError(createAppError(ERROR_CODES.E_NO_WEBCODECS));
    } else if (announceSuccess) {
      notifyToast('Capabilities refreshed', 'All browser capability probes completed.', 'success', 3500);
    }

    announceStatus(
      refs.liveRegion,
      caps.webcodecs
        ? 'Browser capabilities checked. WebCodecs is available.'
        : 'Browser capabilities checked. WebCodecs is not available in this browser.'
    );
  } catch (err) {
    const appError = reportError(err, { fallbackCode: ERROR_CODES.E_NO_WEBCODECS });
    store.dispatch({ type: ACTIONS.SET_UI_ERROR, payload: appError });
    store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'failure' });
  }
}

function wireTransportButtons(refs) {
  if (refs.frameBackBtn) {
    refs.frameBackBtn.addEventListener('click', () => {
      stepPreviewFrame(-1);
    });
  }
  if (refs.frameFwdBtn) {
    refs.frameFwdBtn.addEventListener('click', () => {
      stepPreviewFrame(1);
    });
  }
  if (refs.jumpStartBtn) {
    refs.jumpStartBtn.addEventListener('click', () => {
      const state = store.getState();
      const clip = state.clips.find((c) => c.id === state.selectedClipId);
      if (clip) {
        seekPreviewTo(clip.startSec);
      }
    });
  }
  if (refs.jumpEndBtn) {
    refs.jumpEndBtn.addEventListener('click', () => {
      const state = store.getState();
      const clip = state.clips.find((c) => c.id === state.selectedClipId);
      if (clip) {
        seekPreviewTo(clip.endSec);
      }
    });
  }
  if (refs.prevClipBtn) {
    refs.prevClipBtn.addEventListener('click', () => {
      const state = store.getState();
      const res = getAdjacentClip(state.clips, state.selectedClipId, -1);
      if (res.ok) {
        selectClip(res.value.id);
        seekPreviewTo(res.value.startSec);
      }
    });
  }
  if (refs.nextClipBtn) {
    refs.nextClipBtn.addEventListener('click', () => {
      const state = store.getState();
      const res = getAdjacentClip(state.clips, state.selectedClipId, 1);
      if (res.ok) {
        selectClip(res.value.id);
        seekPreviewTo(res.value.startSec);
      }
    });
  }
}

function bootstrap() {
  const refs = getDomRefs();

  const layoutInit = initLayout({ workspaceShell: refs.workspaceShell });
  if (!layoutInit.ok) {
    reportError(layoutInit.error);
  }

  const dialogInit = initDialogs({ dialogEl: refs.dialogEl });
  if (!dialogInit.ok) {
    reportError(dialogInit.error);
  }

  const previewInit = initPreview({
    video: refs.video,
    emptyState: refs.emptyState,
    loadingState: refs.loadingState,
    errorState: refs.errorState,
    playBtn: refs.playBtn,
    currentTime: refs.currentTime,
    durationTime: refs.durationTime,
    seekBar: refs.seekBar
  });
  if (!previewInit.ok) {
    reportError(previewInit.error);
  }

  const storageInit = initStorageController(
    {
      storagePill: refs.storagePill,
      recoveryBanner: refs.recoveryBanner,
      recoveryText: refs.recoveryText,
      recoveryOpenBtn: refs.recoveryOpenBtn,
      recoveryDiscardBtn: refs.recoveryDiscardBtn,
      storageInfo: refs.storageInfo,
      persistBtn: refs.storagePersistBtn,
      historyClearBtn: refs.historyClearBtn,
      historyEmpty: refs.historyEmpty,
      historyList: refs.historyList
    },
    {
      onPickRecoveryFile() {
        if (refs.filePicker) {
          refs.filePicker.value = '';
          refs.filePicker.click();
        }
      }
    }
  );
  if (!storageInit.ok) {
    reportError(storageInit.error);
  }

  const pwaInit = initPwa(
    {
      networkPill: refs.networkPill,
      installBtn: refs.pwaInstallBtn,
      updateBanner: refs.pwaUpdateBanner,
      updateBtn: refs.pwaUpdateBtn,
      dismissBtn: refs.pwaDismissBtn
    },
    {
      isExportRunning() {
        return isExportQueueRunning();
      }
    }
  );
  if (!pwaInit.ok) {
    reportError(pwaInit.error);
  }

  const inputInit = initMediaInput(
    {
      filePicker: refs.filePicker,
      dropzone: refs.dropzone,
      openBtn: refs.openBtn,
      replaceBtn: refs.replaceBtn,
      clearBtn: refs.clearBtn
    },
    (analysis) => {
      const currentState = store.getState();
      renderSourcePanel(refs, currentState, analysis);
      if (analysis === null) {
        handleSourceClearedForStorage();
      } else if (analysis && !analysis.error && currentState.source) {
        handleSourceLoadedForRecovery(currentState.source);
      }
    }
  );
  if (!inputInit.ok) {
    reportError(inputInit.error);
  }

  const clipsInit = initClips(
    {
      countBadge: refs.clipCountBadge,
      undoBtn: refs.clipUndoBtn,
      redoBtn: refs.clipRedoBtn,
      draftStart: refs.clipDraftStart,
      draftEnd: refs.clipDraftEnd,
      setStartBtn: refs.clipSetStartBtn,
      setEndBtn: refs.clipSetEndBtn,
      resetDraftBtn: refs.clipResetDraftBtn,
      preset15Btn: refs.clipPreset15Btn,
      preset30Btn: refs.clipPreset30Btn,
      preset60Btn: refs.clipPreset60Btn,
      customPresetInput: refs.clipCustomPresetInput,
      customPresetBtn: refs.clipCustomPresetBtn,
      addClipBtn: refs.clipAddBtn,
      quickAddBtn: refs.clipQuickAddBtn,
      draftErrorBox: refs.clipDraftErrorBox,
      countWarning: refs.clipCountWarning,
      emptyState: refs.clipEmptyState,
      listEl: refs.clipListEl
    },
    {
      onSelectClip(clip) {
        seekPreviewTo(clip.startSec);
      },
      async onPreviewClip(clip) {
        const res = await playClipRange(clip.startSec, clip.endSec);
        if (!res.ok) {
          reportError(res.error);
        }
      }
    }
  );
  if (!clipsInit.ok) {
    reportError(clipsInit.error);
  }

  const cropInit = initCrop({
    stage: refs.previewStage,
    video: refs.video,
    framedCanvas: refs.cropFramedCanvas,
    overlay: refs.cropOverlay,
    cropBox: refs.cropBox,
    targetBadge: refs.cropTargetBadge,
    outputInfo: refs.cropOutputInfo,
    ratioOrigBtn: refs.cropRatioOrigBtn,
    ratio916Btn: refs.cropRatio916Btn,
    ratio169Btn: refs.cropRatio169Btn,
    ratio11Btn: refs.cropRatio11Btn,
    ratio45Btn: refs.cropRatio45Btn,
    fitFillBtn: refs.cropFitFillBtn,
    fitContainBtn: refs.cropFitContainBtn,
    bgNoneBtn: refs.cropBgNoneBtn,
    bgBlurBtn: refs.cropBgBlurBtn,
    blurNote: refs.cropBlurNote,
    zoomSlider: refs.cropZoomSlider,
    zoomValue: refs.cropZoomValue,
    panReadout: refs.cropPanReadout,
    previewModeBtn: refs.cropPreviewModeBtn,
    resetBtn: refs.cropResetBtn,
    applyAllBtn: refs.cropApplyAllBtn
  });
  if (!cropInit.ok) {
    reportError(cropInit.error);
  }

  const exportInit = initExportEngine(
    {
      formatMp4Btn: refs.exportFormatMp4Btn,
      formatWebmBtn: refs.exportFormatWebmBtn,
      modePreciseBtn: refs.exportModePreciseBtn,
      modeFastBtn: refs.exportModeFastBtn,
      fastNote: refs.exportFastNote,
      res480Btn: refs.exportRes480Btn,
      res720Btn: refs.exportRes720Btn,
      res1080Btn: refs.exportRes1080Btn,
      res1920Btn: refs.exportRes1920Btn,
      qualityLowBtn: refs.exportQualityLowBtn,
      qualityMediumBtn: refs.exportQualityMediumBtn,
      qualityHighBtn: refs.exportQualityHighBtn,
      preflightBtn: refs.exportPreflightBtn,
      preflightBox: refs.exportPreflightBox,
      exportAllBtn: refs.exportAllBtn,
      exportSelectedBtn: refs.exportSelectedBtn,
      exportCancelBtn: refs.exportCancelBtn,
      exportRetryFailedBtn: refs.exportRetryFailedBtn,
      exportClearQueueBtn: refs.exportClearQueueBtn,
      queueSummary: refs.exportQueueSummary,
      queueProgress: refs.exportQueueProgress,
      queueEmpty: refs.exportQueueEmpty,
      queueList: refs.exportQueueList,
      dlPanel: refs.dlPanel,
      dlAllBtn: refs.dlAllBtn,
      dlZipBtn: refs.dlZipBtn,
      dlPhoneNote: refs.dlPhoneNote,
      dlStatusBox: refs.dlStatusBox
    },
    {
      onExportRecord(record) {
        recordExportHistory(record);
      }
    }
  );
  if (!exportInit.ok) {
    reportError(exportInit.error);
  }

  const timelineInit = initTimeline(
    {
      zoomOutBtn: refs.tlZoomOutBtn,
      zoomResetBtn: refs.tlZoomResetBtn,
      zoomInBtn: refs.tlZoomInBtn,
      panLeftBtn: refs.tlPanLeftBtn,
      panRightBtn: refs.tlPanRightBtn,
      viewport: refs.tlViewport,
      track: refs.tlTrack,
      ruler: refs.tlRuler,
      draftBar: refs.tlDraftBar,
      clipsLayer: refs.tlClipsLayer,
      playhead: refs.tlPlayhead,
      emptyHint: refs.tlEmptyHint
    },
    {
      onSeek(targetSec) {
        seekPreviewTo(targetSec);
      },
      onSelectClip(clipId) {
        selectClip(clipId);
        const clip = store.getState().clips.find((c) => c.id === clipId);
        if (clip) {
          seekPreviewTo(clip.startSec);
        }
      }
    }
  );
  if (!timelineInit.ok) {
    reportError(timelineInit.error);
  }

  wireTransportButtons(refs);

  const shortcutsInit = initShortcuts({
    'toggle-play': () => {
      if (store.getState().source) {
        togglePreviewPlayback();
      }
    },
    'seek-back-small': () => {
      if (store.getState().source) {
        stepPreviewBySeconds(-SEEK_STEP_SMALL_SEC);
      }
    },
    'seek-forward-small': () => {
      if (store.getState().source) {
        stepPreviewBySeconds(SEEK_STEP_SMALL_SEC);
      }
    },
    'seek-back-large': () => {
      if (store.getState().source) {
        stepPreviewBySeconds(-SEEK_STEP_LARGE_SEC);
      }
    },
    'seek-forward-large': () => {
      if (store.getState().source) {
        stepPreviewBySeconds(SEEK_STEP_LARGE_SEC);
      }
    },
    'frame-back': () => {
      if (store.getState().source) {
        stepPreviewFrame(-1);
      }
    },
    'frame-forward': () => {
      if (store.getState().source) {
        stepPreviewFrame(1);
      }
    },
    'set-start': () => {
      const res = setDraftMarkerFromPlayhead('start');
      if (res.ok) {
        const formatted = formatTimestamp(res.value.startSec);
        announceStatus(refs.liveRegion, `Draft start set to ${formatted.ok ? formatted.value : '00:00:00.000'}.`);
      }
    },
    'set-end': () => {
      const res = setDraftMarkerFromPlayhead('end');
      if (res.ok) {
        const formatted = formatTimestamp(res.value.endSec);
        announceStatus(refs.liveRegion, `Draft end set to ${formatted.ok ? formatted.value : '00:00:00.000'}.`);
      }
    },
    undo: () => {
      store.dispatch({ type: ACTIONS.UNDO });
    },
    redo: () => {
      store.dispatch({ type: ACTIONS.REDO });
    },
    'show-shortcuts': () => {
      openShortcutsDialog();
    }
  });
  if (!shortcutsInit.ok) {
    reportError(shortcutsInit.error);
  }

  if (refs.shortcutsBtn) {
    refs.shortcutsBtn.addEventListener('click', () => {
      openShortcutsDialog();
    });
  }

  const subResult = store.subscribe((nextState) => {
    renderState(refs, nextState);
  });
  if (!subResult.ok) {
    reportError(subResult.error);
    return;
  }

  renderState(refs, store.getState());

  if (refs.recheckBtn) {
    refs.recheckBtn.addEventListener('click', () => {
      runCapabilityProbe(refs, true);
    });
  }

  runCapabilityProbe(refs, false).then(() => {
    checkAndOfferRecovery();
  });
}

bootstrap();
