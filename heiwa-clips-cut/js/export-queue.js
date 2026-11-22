/* Stage 6–7 module: adaptive media preflight, sequential export queue, output verification, downloads, and ZIP. */

import { ACTIONS, store } from './store.js';
import { createAppError, ERROR_CODES, fail, normalizeError, notifyToast, ok, reportError } from './errors.js';
import { computeCropPlan, isCropDefault } from './crop.js';
import { detectPhoneDevice, formatFileSize } from './metadata.js';
import { getActiveSourceFile } from './media-input.js';
import {
  computeBitrateProfile,
  isFastModeContainerCompatible,
  normalizeExportSettings,
  VALID_EXPORT_FORMATS,
  VALID_EXPORT_MODES,
  VALID_EXPORT_QUALITIES
} from './export-worker.js';
import {
  buildClipFilename,
  buildZipFilename,
  downloadBatchSequentially,
  downloadBlob,
  revokeAllDownloadUrls,
  sanitizeCustomFilename
} from './download.js';
import { estimateZipTotalBytes, saveZipArchive } from './zip.js';

export const EXPORT_QUEUE_STAGE = 7;
export const EXPORT_MAX_SIDES = Object.freeze([480, 720, 1080, 1920]);
export const VERIFY_DURATION_TOLERANCE_SEC = 0.5;

const SINGLE_CLIP_WARN_BYTES_PHONE = 180 * 1024 * 1024;
const SINGLE_CLIP_LIMIT_BYTES_PHONE = 350 * 1024 * 1024;
const SINGLE_CLIP_WARN_BYTES_DESKTOP = 500 * 1024 * 1024;
const SINGLE_CLIP_LIMIT_BYTES_DESKTOP = 950 * 1024 * 1024;
const BATCH_WARN_BYTES_PHONE = 400 * 1024 * 1024;
const BATCH_WARN_BYTES_DESKTOP = 1_800 * 1024 * 1024;
const CANCEL_FORCE_TERMINATE_MS = 2500;
const VERIFY_METADATA_TIMEOUT_MS = 10_000;

const PHASE_LABELS = Object.freeze({
  queued: 'Waiting in queue',
  'loading-engine': 'Loading Mediabunny engine…',
  analyzing: 'Analyzing source tracks…',
  'copying-video': 'Copying video packets from nearest keyframe…',
  'copying-audio': 'Copying audio packets…',
  encoding: 'Decoding, framing, and encoding frames…',
  finalizing: 'Finalizing output container…',
  verifying: 'Verifying output playback & duration…',
  done: 'Verified & ready',
  failed: 'Failed',
  cancelled: 'Cancelled'
});

const jobOutputs = new Map();

let engineRefs = null;
let engineCallbacks = {};
let engineInitialized = false;
let latestPreflight = null;
let preflightSequence = 0;
let activeJobHandle = null;
let queueRunning = false;
let queueCancelRequested = false;
let downloadBusy = false;
let downloadStatus = null;
let jobIdCounter = 0;
let lastRenderedQueueKey = '';

function round2(value) {
  return Math.round(value * 100) / 100;
}

function createJobId() {
  jobIdCounter += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `job_${crypto.randomUUID()}`;
  }
  return `job_${Date.now().toString(36)}_${jobIdCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeEl(tag, className = '', text = '') {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text) {
    el.textContent = text;
  }
  return el;
}

function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

export function isExportQueueRunning() {
  return queueRunning;
}

export function getJobOutputBlob(jobId) {
  return jobOutputs.get(jobId) || null;
}

export function buildEncoderConfigsForClip(source, clip, settings) {
  if (!source || typeof source !== 'object') {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'Source video metadata is required.');
  }
  if (!clip || typeof clip !== 'object') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip is required.');
  }
  const normSettings = normalizeExportSettings(settings).value;
  const planRes = computeCropPlan(source.width, source.height, clip.crop, normSettings.maxSide);
  if (!planRes.ok) {
    return planRes;
  }
  const plan = planRes.value;
  const profileRes = computeBitrateProfile(plan.outputWidth, plan.outputHeight, normSettings);
  if (!profileRes.ok) {
    return profileRes;
  }
  const profile = profileRes.value;
  const framerate = typeof source.fps === 'number' && Number.isFinite(source.fps) && source.fps > 0
    ? Math.min(120, Math.max(1, Math.round(source.fps)))
    : 30;

  const videoConfigs = profile.videoProbeCodecs.map((codec) => ({
    codec,
    width: plan.outputWidth,
    height: plan.outputHeight,
    bitrate: profile.videoBitrate,
    framerate
  }));

  const hasAudio = source.audioCodec !== null && source.audioCodec !== undefined;
  const audioConfig = hasAudio
    ? { codec: profile.audioProbeCodec, sampleRate: 48000, numberOfChannels: 2, bitrate: profile.audioBitrate }
    : null;

  return ok({ plan, profile, videoConfigs, audioConfig, hasAudio });
}

export function estimateExportBatch(source, clips, settings, options = {}) {
  if (!source || typeof source !== 'object') {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'Source video metadata is required.');
  }
  if (!Array.isArray(clips)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clips must be an array.');
  }
  const norm = normalizeExportSettings(settings).value;
  const isPhone = typeof options.isPhone === 'boolean' ? options.isPhone : detectPhoneDevice();

  let totalDurationSec = 0;
  let totalEstimatedBytes = 0;
  let maxClipBytes = 0;
  const sourceAvgBps = source.durationSec > 0 && source.size > 0
    ? (source.size * 8) / source.durationSec
    : 4_000_000;

  for (const clip of clips) {
    const duration = Math.max(0, (clip.endSec || 0) - (clip.startSec || 0));
    totalDurationSec += duration;
    let clipBps = sourceAvgBps;
    if (norm.mode === 'precise') {
      const cfgRes = buildEncoderConfigsForClip(source, clip, norm);
      if (cfgRes.ok) {
        clipBps = cfgRes.value.profile.videoBitrate + (cfgRes.value.hasAudio ? cfgRes.value.profile.audioBitrate : 0);
      }
    }
    const clipBytes = Math.round((clipBps / 8) * duration * 1.08);
    totalEstimatedBytes += clipBytes;
    if (clipBytes > maxClipBytes) {
      maxClipBytes = clipBytes;
    }
  }

  /* Rough heuristic only; real speed depends on device GPU/CPU and codec. */
  const speedMultiplier = norm.mode === 'fast'
    ? 0.08
    : isPhone
      ? (norm.maxSide >= 1080 ? 1.8 : 1.0)
      : (norm.maxSide >= 1080 ? 0.65 : 0.35);
  const estimatedSecondsMin = Math.max(1, Math.round(totalDurationSec * speedMultiplier * 0.6));
  const estimatedSecondsMax = Math.max(estimatedSecondsMin + 1, Math.round(totalDurationSec * speedMultiplier * 1.8));

  const singleWarn = isPhone ? SINGLE_CLIP_WARN_BYTES_PHONE : SINGLE_CLIP_WARN_BYTES_DESKTOP;
  const singleLimit = isPhone ? SINGLE_CLIP_LIMIT_BYTES_PHONE : SINGLE_CLIP_LIMIT_BYTES_DESKTOP;
  const batchWarn = isPhone ? BATCH_WARN_BYTES_PHONE : BATCH_WARN_BYTES_DESKTOP;

  let memoryRisk = 'ok';
  if (maxClipBytes > singleLimit) {
    memoryRisk = 'error';
  } else if (maxClipBytes > singleWarn || totalEstimatedBytes > batchWarn) {
    memoryRisk = 'warn';
  }

  return ok({
    clipCount: clips.length,
    totalDurationSec: round2(totalDurationSec),
    totalEstimatedBytes,
    maxClipBytes,
    estimatedSecondsMin,
    estimatedSecondsMax,
    memoryRisk,
    isPhone
  });
}

async function defaultProbeVideoConfig(config) {
  if (typeof VideoEncoder !== 'function' || typeof VideoEncoder.isConfigSupported !== 'function') {
    return false;
  }
  try {
    const res = await VideoEncoder.isConfigSupported(config);
    return Boolean(res && res.supported);
  } catch {
    return false;
  }
}

async function defaultProbeAudioConfig(config) {
  if (typeof AudioEncoder !== 'function' || typeof AudioEncoder.isConfigSupported !== 'function') {
    return false;
  }
  try {
    const res = await AudioEncoder.isConfigSupported(config);
    return Boolean(res && res.supported);
  } catch {
    return false;
  }
}

export async function runExportPreflight({
  source,
  clips,
  settings,
  capabilities,
  isPhone,
  probeVideoConfig = defaultProbeVideoConfig,
  probeAudioConfig = defaultProbeAudioConfig
}) {
  const norm = normalizeExportSettings(settings).value;
  const targetClips = Array.isArray(clips) ? clips : [];
  const blockers = [];
  const warnings = [];
  const checkedConfigs = [];

  if (!source || typeof source !== 'object') {
    return ok({
      ready: false,
      settings: norm,
      fastModeAllowed: false,
      fastModeDisabledReason: 'Open a video first.',
      blockers: [createAppError(ERROR_CODES.E_METADATA_INVALID, 'Open a local video before running preflight.')],
      warnings: [],
      estimate: null,
      checkedConfigs
    });
  }

  const anyCropActive = targetClips.some((clip) => !isCropDefault(clip.crop));
  const fastCompatRes = isFastModeContainerCompatible(norm.format, source.videoCodec, source.audioCodec);
  let fastModeAllowed = true;
  let fastModeDisabledReason = '';

  if (anyCropActive) {
    fastModeAllowed = false;
    fastModeDisabledReason = 'Fast mode is disabled because one or more clips use crop, zoom, or aspect ratio reframing. Use Precise mode.';
  } else if (!fastCompatRes.ok) {
    fastModeAllowed = false;
    fastModeDisabledReason = `${fastCompatRes.error.message} ${fastCompatRes.error.hint}`;
  }

  if (targetClips.length === 0) {
    return ok({
      ready: false,
      settings: norm,
      fastModeAllowed,
      fastModeDisabledReason,
      blockers: [createAppError(ERROR_CODES.E_RANGE_INVALID, 'Add at least one clip before exporting.')],
      warnings: [],
      estimate: null,
      checkedConfigs
    });
  }

  if (capabilities && !capabilities.worker) {
    blockers.push(createAppError(ERROR_CODES.E_EXPORT_FAILED, 'Web Workers are unavailable in this browser.', 'Use a modern browser supporting module Web Workers.'));
  }

  if (norm.mode === 'fast') {
    if (!fastModeAllowed) {
      blockers.push(createAppError(anyCropActive ? ERROR_CODES.E_RANGE_INVALID : ERROR_CODES.E_UNSUPPORTED_CODEC, fastModeDisabledReason, 'Switch Export Mode to Precise.'));
    } else {
      warnings.push('Fast mode copies packets from the nearest earlier keyframe; clips may start slightly before your chosen start time.');
    }
  } else if (capabilities && !capabilities.webcodecs) {
    blockers.push(createAppError(ERROR_CODES.E_NO_WEBCODECS));
  } else {
    const uniqueDimConfigs = new Map();
    let sampleAudioConfig = null;
    for (const clip of targetClips) {
      const cfgRes = buildEncoderConfigsForClip(source, clip, norm);
      if (!cfgRes.ok) {
        blockers.push(cfgRes.error);
        continue;
      }
      const { plan, videoConfigs, audioConfig } = cfgRes.value;
      const dimKey = `${plan.outputWidth}x${plan.outputHeight}:${norm.format}:${norm.quality}`;
      if (!uniqueDimConfigs.has(dimKey)) {
        uniqueDimConfigs.set(dimKey, { plan, videoConfigs });
      }
      if (audioConfig && !sampleAudioConfig) {
        sampleAudioConfig = audioConfig;
      }
    }

    const altFormat = norm.format === 'mp4' ? 'WebM (VP9/Opus)' : 'MP4 (H.264/AAC)';
    for (const entry of uniqueDimConfigs.values()) {
      let supportedCodec = null;
      for (const vc of entry.videoConfigs) {
        if (await probeVideoConfig(vc)) {
          supportedCodec = vc.codec;
          break;
        }
      }
      checkedConfigs.push({
        width: entry.plan.outputWidth,
        height: entry.plan.outputHeight,
        codec: supportedCodec || entry.videoConfigs[0].codec,
        supported: Boolean(supportedCodec)
      });
      if (!supportedCodec) {
        blockers.push(createAppError(
          ERROR_CODES.E_ENCODER_UNSUPPORTED,
          `Browser rejected ${norm.format.toUpperCase()} video encoding at ${entry.plan.outputWidth}×${entry.plan.outputHeight}.`,
          `Switch to ${altFormat} or lower Max Resolution to 720p or 480p.`
        ));
      }
    }

    if (sampleAudioConfig && !(await probeAudioConfig(sampleAudioConfig))) {
      blockers.push(createAppError(
        ERROR_CODES.E_ENCODER_UNSUPPORTED,
        `Browser rejected ${sampleAudioConfig.codec} audio encoding.`,
        `Switch format to ${altFormat} and re-run preflight.`
      ));
    }
  }

  const estimateRes = estimateExportBatch(source, targetClips, norm, { isPhone });
  const estimate = estimateRes.ok ? estimateRes.value : null;
  if (estimate) {
    if (estimate.memoryRisk === 'error') {
      blockers.push(createAppError(ERROR_CODES.E_OUT_OF_MEMORY_RISK));
    } else if (estimate.memoryRisk === 'warn') {
      const sizeStr = formatFileSize(estimate.totalEstimatedBytes);
      warnings.push(`Estimated output (${sizeStr.ok ? sizeStr.value : 'large'}) is sizable for browser RAM. Keep this tab active and consider 720p or shorter clips if memory is tight.`);
    }
  }

  return ok({
    ready: blockers.length === 0,
    settings: norm,
    fastModeAllowed,
    fastModeDisabledReason,
    blockers,
    warnings,
    estimate,
    checkedConfigs
  });
}

export function verifyOutputDuration(actualDurationSec, expectedDurationSec, mode = 'precise') {
  if (typeof actualDurationSec !== 'number' || !Number.isFinite(actualDurationSec) || actualDurationSec <= 0) {
    return fail(ERROR_CODES.E_OUTPUT_VERIFY, 'Exported clip reported an unreadable or zero duration.', 'Retry the clip in Precise mode or with a lower resolution.');
  }
  if (typeof expectedDurationSec !== 'number' || !Number.isFinite(expectedDurationSec) || expectedDurationSec <= 0) {
    return fail(ERROR_CODES.E_OUTPUT_VERIFY, 'Expected clip duration is invalid.');
  }

  if (mode === 'fast') {
    const minAllowed = Math.max(0.05, expectedDurationSec - VERIFY_DURATION_TOLERANCE_SEC);
    if (actualDurationSec < minAllowed) {
      return fail(ERROR_CODES.E_OUTPUT_VERIFY, `Fast-copy output duration (${round2(actualDurationSec)}s) is shorter than expected (${round2(expectedDurationSec)}s).`, 'Retry this clip in Precise mode for accurate boundaries.');
    }
    return ok({ durationSec: round2(actualDurationSec), deltaSec: round2(actualDurationSec - expectedDurationSec) });
  }

  if (Math.abs(actualDurationSec - expectedDurationSec) > VERIFY_DURATION_TOLERANCE_SEC) {
    return fail(ERROR_CODES.E_OUTPUT_VERIFY, `Output duration (${round2(actualDurationSec)}s) differs from expected (${round2(expectedDurationSec)}s) by more than ${VERIFY_DURATION_TOLERANCE_SEC}s.`, 'Retry the clip or lower the resolution setting.');
  }
  return ok({ durationSec: round2(actualDurationSec), deltaSec: round2(actualDurationSec - expectedDurationSec) });
}

export async function verifyExportedClipBlob(blob, expectedDurationSec, mode = 'precise') {
  if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
    return fail(ERROR_CODES.E_OUTPUT_EMPTY);
  }
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    const check = verifyOutputDuration(expectedDurationSec, expectedDurationSec, mode);
    return check.ok ? ok({ bytes: blob.size, durationSec: check.value.durationSec, width: 0, height: 0 }) : check;
  }

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  let objectUrl = null;
  let timerId = null;

  try {
    objectUrl = URL.createObjectURL(blob);
    const metadata = await new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) {
          return;
        }
        done = true;
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
        resolve(result);
      };
      const onLoaded = () => finish(ok({ durationSec: video.duration, width: video.videoWidth || 0, height: video.videoHeight || 0 }));
      const onError = () => finish(fail(ERROR_CODES.E_OUTPUT_VERIFY, 'Browser could not load metadata from the exported clip.', 'Retry in Precise mode or switch format between MP4 and WebM.'));
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      timerId = setTimeout(() => {
        finish(fail(ERROR_CODES.E_OUTPUT_VERIFY, 'Timed out while verifying exported clip playback metadata.', 'Retry the clip or lower the export resolution.'));
      }, VERIFY_METADATA_TIMEOUT_MS);
      video.src = objectUrl;
      video.load();
    });

    if (!metadata.ok) {
      return metadata;
    }
    if (metadata.value.width <= 0 || metadata.value.height <= 0) {
      return fail(ERROR_CODES.E_OUTPUT_VERIFY, 'Exported clip has no decodable video frames (0×0).', 'Retry in Precise mode or try the alternate output format.');
    }
    const durCheck = verifyOutputDuration(metadata.value.durationSec, expectedDurationSec, mode);
    if (!durCheck.ok) {
      return durCheck;
    }
    return ok({ bytes: blob.size, durationSec: durCheck.value.durationSec, width: metadata.value.width, height: metadata.value.height });
  } catch (err) {
    const normalized = normalizeError(err, ERROR_CODES.E_OUTPUT_VERIFY);
    return fail(normalized.code, normalized.message, normalized.hint);
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      /* Ignore detached video cleanup error. */
    }
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* Ignore object URL revoke error. */
      }
    }
  }
}

export function runSingleClipExportJob({ file, clip, settings, jobId, onProgress }) {
  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    return fail(ERROR_CODES.E_EMPTY_FILE);
  }
  if (!clip || typeof clip !== 'object') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'A valid clip is required for export.');
  }
  if (typeof Worker !== 'function') {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Web Workers are unavailable in this browser.');
  }

  const resolvedJobId = typeof jobId === 'string' && jobId.trim() ? jobId.trim() : createJobId();
  const normSettings = normalizeExportSettings(settings).value;

  let worker = null;
  let settled = false;
  let cancelTimerId = null;

  const cleanupWorker = () => {
    if (cancelTimerId !== null) {
      clearTimeout(cancelTimerId);
      cancelTimerId = null;
    }
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* Ignore worker termination error. */
      }
      worker = null;
    }
  };

  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const finish = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanupWorker();
    resolvePromise(result);
  };

  try {
    worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err || '');
    return fail(ERROR_CODES.E_EXPORT_FAILED, `Could not start export Web Worker (${detail}).`, 'Serve Heiwa Clips Cut from a local or HTTPS web server (not file://).');
  }

  worker.addEventListener('message', (event) => {
    const msg = event ? event.data : null;
    if (!msg || typeof msg !== 'object' || msg.jobId !== resolvedJobId) {
      return;
    }
    if (msg.type === 'progress') {
      if (typeof onProgress === 'function') {
        onProgress({ jobId: resolvedJobId, pct: msg.pct, phase: msg.phase });
      }
    } else if (msg.type === 'done') {
      finish(ok({ jobId: resolvedJobId, blob: msg.blob, mime: msg.mime, durationSec: msg.durationSec, bytes: msg.bytes }));
    } else if (msg.type === 'cancelled') {
      finish(fail(ERROR_CODES.E_CANCELLED));
    } else if (msg.type === 'error') {
      finish(fail(msg.code || ERROR_CODES.E_EXPORT_FAILED, msg.message, msg.hint));
    }
  });

  worker.addEventListener('error', (event) => {
    finish(fail(ERROR_CODES.E_EXPORT_FAILED, `Export worker crashed: ${event && event.message ? event.message : 'Worker script error.'}`));
  });
  worker.addEventListener('messageerror', () => {
    finish(fail(ERROR_CODES.E_EXPORT_FAILED, 'Could not deserialize message from export worker.'));
  });

  worker.postMessage({ type: 'start', jobId: resolvedJobId, file, clip, settings: normSettings });

  const cancel = () => {
    if (settled || !worker) {
      return;
    }
    try {
      worker.postMessage({ type: 'cancel', jobId: resolvedJobId });
    } catch {
      /* Proceed to forced termination fallback. */
    }
    if (cancelTimerId === null) {
      cancelTimerId = setTimeout(() => finish(fail(ERROR_CODES.E_CANCELLED)), CANCEL_FORCE_TERMINATE_MS);
    }
  };

  return ok({ jobId: resolvedJobId, promise, cancel });
}

/* --- Stage 7 Sequential Queue, Downloads, and ZIP --- */

export function buildQueueJobs({ sourceName, clips, settings }) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'At least one clip is required to build export jobs.');
  }
  const norm = normalizeExportSettings(settings).value;
  const usedNames = new Set();
  const jobs = [];

  for (const clip of clips) {
    const nameRes = buildClipFilename({
      sourceName,
      clipName: clip.name,
      startSec: clip.startSec,
      endSec: clip.endSec,
      format: norm.format,
      existingNames: usedNames
    });
    const filename = nameRes.ok ? nameRes.value : `clip_${jobs.length + 1}.${norm.format}`;
    usedNames.add(filename.toLowerCase());

    /* Frozen 3.3 Job contract fields + safe display/settings metadata. */
    jobs.push({
      id: createJobId(),
      clipId: clip.id,
      clipName: clip.name,
      format: norm.format,
      mode: norm.mode,
      settings: { ...norm },
      status: 'queued',
      progress: 0,
      phase: 'queued',
      error: null,
      outputBytes: 0,
      outputMime: '',
      outputDurationSec: 0,
      filename
    });
  }

  return ok(jobs);
}

export function computeQueueSummary(queue) {
  const list = Array.isArray(queue) ? queue : [];
  let queued = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let totalProgress = 0;
  let totalOutputBytes = 0;

  for (const job of list) {
    if (job.status === 'queued') {
      queued += 1;
    } else if (job.status === 'running') {
      running += 1;
    } else if (job.status === 'done') {
      done += 1;
      totalOutputBytes += job.outputBytes || 0;
    } else if (job.status === 'failed') {
      failed += 1;
    } else if (job.status === 'cancelled') {
      cancelled += 1;
    }
    totalProgress += job.status === 'done' ? 100 : Math.max(0, Math.min(100, job.progress || 0));
  }

  const total = list.length;
  return {
    total,
    queued,
    running,
    done,
    failed,
    cancelled,
    overallPct: total > 0 ? Math.round(totalProgress / total) : 0,
    totalOutputBytes
  };
}

function updateClipStatusMap(statusByClipId, exportByClipId = null) {
  const state = store.getState();
  if (!Array.isArray(state.clips) || state.clips.length === 0) {
    return;
  }
  let changed = false;
  const nextClips = state.clips.map((clip) => {
    const nextProcess = statusByClipId && Object.prototype.hasOwnProperty.call(statusByClipId, clip.id)
      ? statusByClipId[clip.id]
      : clip.processStatus;
    const nextExport = exportByClipId && Object.prototype.hasOwnProperty.call(exportByClipId, clip.id)
      ? exportByClipId[clip.id]
      : clip.exportStatus;
    if (nextProcess !== clip.processStatus || nextExport !== clip.exportStatus) {
      changed = true;
      return { ...clip, processStatus: nextProcess, exportStatus: nextExport };
    }
    return clip;
  });
  if (changed) {
    store.dispatch({ type: ACTIONS.CLIPS_REPLACE_NO_HISTORY, payload: nextClips });
  }
}

function patchJobInStore(jobId, patch) {
  const currentQueue = store.getState().queue;
  let found = false;
  const nextQueue = currentQueue.map((job) => {
    if (job.id !== jobId) {
      return job;
    }
    found = true;
    return { ...job, ...patch };
  });
  if (found) {
    store.dispatch({ type: ACTIONS.SET_QUEUE, payload: nextQueue });
  }
}

function updateActiveJobProgressDomOnly(jobId, pct, phase) {
  if (!engineRefs || !engineRefs.queueList) {
    return;
  }
  const card = engineRefs.queueList.querySelector(`[data-job-id="${jobId}"]`);
  if (!card) {
    return;
  }
  const bar = card.querySelector('.job-card__progress');
  const meta = card.querySelector('.job-card__phase');
  if (bar) {
    bar.value = pct;
  }
  if (meta) {
    meta.textContent = `${pct}% — ${PHASE_LABELS[phase] || phase || 'Processing…'}`;
  }
  if (engineRefs.queueProgress) {
    engineRefs.queueProgress.value = computeQueueSummary(store.getState().queue).overallPct;
  }
}

async function processQueueLoop() {
  if (queueRunning) {
    return;
  }
  const file = getActiveSourceFile();
  if (!file) {
    reportError(createAppError(ERROR_CODES.E_EMPTY_FILE, 'No active video file is loaded for export.'));
    return;
  }

  queueRunning = true;
  queueCancelRequested = false;
  store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'processing' });

  let completedInRun = 0;
  let failedInRun = 0;
  let cancelledInRun = false;

  try {
    while (true) {
      const state = store.getState();
      const nextJob = state.queue.find((j) => j.status === 'queued');
      if (!nextJob) {
        break;
      }
      if (queueCancelRequested) {
        cancelledInRun = true;
        break;
      }

      const clip = state.clips.find((c) => c.id === nextJob.clipId);
      if (!clip) {
        patchJobInStore(nextJob.id, {
          status: 'failed',
          phase: 'failed',
          error: createAppError(ERROR_CODES.E_RANGE_INVALID, 'This clip was removed before it could be exported.', 'Re-add the clip if you still need it.')
        });
        failedInRun += 1;
        continue;
      }

      jobOutputs.delete(nextJob.id);
      patchJobInStore(nextJob.id, { status: 'running', progress: 0, phase: 'loading-engine', error: null, outputBytes: 0, outputMime: '', outputDurationSec: 0 });
      updateClipStatusMap({ [clip.id]: 'running' });

      const jobSettings = nextJob.settings || state.exportSettings;
      const started = runSingleClipExportJob({
        file,
        clip,
        settings: jobSettings,
        jobId: nextJob.id,
        onProgress: ({ pct, phase }) => {
          const cleanPct = Math.max(0, Math.min(99, Math.round(pct)));
          patchJobInStore(nextJob.id, { progress: cleanPct, phase });
          updateActiveJobProgressDomOnly(nextJob.id, cleanPct, phase);
        }
      });

      if (!started.ok) {
        patchJobInStore(nextJob.id, { status: 'failed', phase: 'failed', error: started.error });
        updateClipStatusMap({ [clip.id]: 'failed' });
        failedInRun += 1;
        continue;
      }

      activeJobHandle = started.value;
      const workerResult = await started.value.promise;
      activeJobHandle = null;

      if (queueCancelRequested || (!workerResult.ok && workerResult.error.code === ERROR_CODES.E_CANCELLED)) {
        patchJobInStore(nextJob.id, { status: 'cancelled', phase: 'cancelled', error: null });
        updateClipStatusMap({ [clip.id]: 'cancelled' });
        cancelledInRun = true;
        break;
      }

      if (!workerResult.ok) {
        patchJobInStore(nextJob.id, { status: 'failed', phase: 'failed', error: workerResult.error });
        updateClipStatusMap({ [clip.id]: 'failed' });
        failedInRun += 1;
        continue;
      }

      patchJobInStore(nextJob.id, { progress: 99, phase: 'verifying' });
      const expectedDur = Math.max(0.01, clip.endSec - clip.startSec);
      const verifyRes = await verifyExportedClipBlob(
        workerResult.value.blob,
        expectedDur,
        normalizeExportSettings(jobSettings).value.mode
      );

      if (!verifyRes.ok) {
        patchJobInStore(nextJob.id, { status: 'failed', phase: 'failed', error: verifyRes.error });
        updateClipStatusMap({ [clip.id]: 'failed' });
        failedInRun += 1;
        continue;
      }

      jobOutputs.set(nextJob.id, {
        blob: workerResult.value.blob,
        mime: workerResult.value.mime,
        durationSec: verifyRes.value.durationSec,
        bytes: verifyRes.value.bytes
      });

      patchJobInStore(nextJob.id, {
        status: 'done',
        progress: 100,
        phase: 'done',
        error: null,
        outputBytes: verifyRes.value.bytes,
        outputMime: workerResult.value.mime,
        outputDurationSec: verifyRes.value.durationSec
      });
      updateClipStatusMap({ [clip.id]: 'done' });
      if (typeof engineCallbacks.onExportRecord === 'function') {
        engineCallbacks.onExportRecord({
          sourceName: state.source ? state.source.name : '',
          clipName: clip.name,
          filename: nextJob.filename,
          startSec: clip.startSec,
          endSec: clip.endSec,
          durationSec: verifyRes.value.durationSec,
          format: nextJob.format,
          mode: nextJob.mode,
          outputBytes: verifyRes.value.bytes,
          delivery: 'exported'
        });
      }
      completedInRun += 1;
    }

    if (cancelledInRun) {
      const clipPatches = {};
      const updatedQueue = store.getState().queue.map((job) => {
        if (job.status === 'queued' || job.status === 'running') {
          clipPatches[job.clipId] = 'cancelled';
          return { ...job, status: 'cancelled', phase: 'cancelled', error: null };
        }
        return job;
      });
      store.dispatch({ type: ACTIONS.SET_QUEUE, payload: updatedQueue });
      updateClipStatusMap(clipPatches);
      store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'cancelled' });
      notifyToast('Export queue cancelled', 'Active worker stopped and remaining queued clips cancelled.', 'warning', 3500);
    } else if (failedInRun > 0 && completedInRun === 0) {
      store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'failure' });
      notifyToast('Export finished with errors', `${failedInRun} clip(s) failed. Check each job card to retry.`, 'error', 5000);
    } else if (failedInRun > 0) {
      store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });
      notifyToast('Export partially completed', `${completedInRun} ready to download, ${failedInRun} failed. Click Retry Failed to re-run.`, 'warning', 5000);
    } else if (completedInRun > 0) {
      store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'success' });
      notifyToast('Export complete', `${completedInRun} ${completedInRun === 1 ? 'clip' : 'clips'} verified and ready to download.`, 'success', 4500);
    } else {
      store.dispatch({ type: ACTIONS.SET_UI_STATUS, payload: 'ready' });
    }
  } finally {
    activeJobHandle = null;
    queueRunning = false;
    queueCancelRequested = false;
    if (engineRefs) {
      renderExportEnginePanel(store.getState());
    }
  }
}

export async function startExportQueue(targetClips) {
  if (queueRunning) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'An export batch is already running.');
  }
  const state = store.getState();
  const file = getActiveSourceFile();
  const clipsToRun = Array.isArray(targetClips) ? targetClips : state.clips;

  if (!file || !state.source || clipsToRun.length === 0) {
    const err = createAppError(ERROR_CODES.E_RANGE_INVALID, 'Open a video and add at least one clip before exporting.');
    reportError(err);
    return { ok: false, error: err };
  }

  const preflightRes = await runExportPreflight({
    source: state.source,
    clips: clipsToRun,
    settings: state.exportSettings,
    capabilities: state.capabilities
  });
  latestPreflight = preflightRes.ok ? preflightRes.value : null;

  if (!latestPreflight || !latestPreflight.ready) {
    const firstBlocker = latestPreflight && latestPreflight.blockers[0]
      ? latestPreflight.blockers[0]
      : createAppError(ERROR_CODES.E_EXPORT_FAILED);
    reportError(firstBlocker);
    if (engineRefs) {
      renderExportEnginePanel(store.getState());
    }
    return { ok: false, error: firstBlocker };
  }

  const jobsRes = buildQueueJobs({ sourceName: state.source.name, clips: clipsToRun, settings: state.exportSettings });
  if (!jobsRes.ok) {
    reportError(jobsRes.error);
    return jobsRes;
  }

  jobOutputs.clear();
  downloadStatus = null;
  store.dispatch({ type: ACTIONS.SET_QUEUE, payload: jobsRes.value });

  const statusPatches = {};
  for (const job of jobsRes.value) {
    statusPatches[job.clipId] = 'queued';
  }
  updateClipStatusMap(statusPatches);

  await processQueueLoop();
  return ok(store.getState().queue);
}

export async function retryFailedJobs() {
  if (queueRunning) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Wait for the current export to finish or cancel it first.');
  }
  const state = store.getState();
  const retryable = state.queue.filter((j) => j.status === 'failed' || j.status === 'cancelled');
  if (retryable.length === 0) {
    return ok(false);
  }
  const norm = normalizeExportSettings(state.exportSettings).value;
  const clipStatusPatches = {};
  const nextQueue = state.queue.map((job) => {
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return job;
    }
    jobOutputs.delete(job.id);
    clipStatusPatches[job.clipId] = 'queued';
    return { ...job, status: 'queued', progress: 0, phase: 'queued', error: null, settings: { ...norm }, format: norm.format, mode: norm.mode };
  });

  store.dispatch({ type: ACTIONS.SET_QUEUE, payload: nextQueue });
  updateClipStatusMap(clipStatusPatches);
  await processQueueLoop();
  return ok(true);
}

export async function retrySingleJob(jobId) {
  if (queueRunning) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Wait for the current export to finish or cancel it first.');
  }
  const state = store.getState();
  const target = state.queue.find((j) => j.id === jobId);
  if (!target) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Export job was not found.');
  }
  jobOutputs.delete(jobId);
  const norm = normalizeExportSettings(state.exportSettings).value;
  patchJobInStore(jobId, { status: 'queued', progress: 0, phase: 'queued', error: null, settings: { ...norm }, format: norm.format, mode: norm.mode });
  updateClipStatusMap({ [target.clipId]: 'queued' });
  await processQueueLoop();
  return ok(true);
}

export function updateJobFilename(jobId, rawFilename) {
  const state = store.getState();
  const target = state.queue.find((j) => j.id === jobId);
  if (!target) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Export job was not found.');
  }
  const otherNames = state.queue.filter((j) => j.id !== jobId).map((j) => j.filename);
  const cleanRes = sanitizeCustomFilename(rawFilename, target.format || 'mp4', otherNames);
  if (!cleanRes.ok) {
    return cleanRes;
  }
  patchJobInStore(jobId, { filename: cleanRes.value });
  return ok(cleanRes.value);
}

export function downloadJobById(jobId) {
  const state = store.getState();
  const job = state.queue.find((j) => j.id === jobId);
  const output = jobOutputs.get(jobId);
  if (!job || job.status !== 'done' || !output || !output.blob) {
    const err = createAppError(ERROR_CODES.E_DOWNLOAD_FAILED, 'This clip has no verified file ready in memory.', 'Re-export the clip before downloading.');
    reportError(err);
    return { ok: false, error: err };
  }
  const dlRes = downloadBlob(output.blob, job.filename);
  if (!dlRes.ok) {
    reportError(dlRes.error);
    return dlRes;
  }
  updateClipStatusMap(null, { [job.clipId]: 'downloaded' });
  if (typeof engineCallbacks.onExportRecord === 'function') {
    const clip = state.clips.find((c) => c.id === job.clipId);
    engineCallbacks.onExportRecord({
      sourceName: state.source ? state.source.name : '',
      clipName: job.clipName || (clip ? clip.name : 'Clip'),
      filename: job.filename,
      startSec: clip ? clip.startSec : 0,
      endSec: clip ? clip.endSec : 0,
      durationSec: job.outputDurationSec || 0,
      format: job.format,
      mode: job.mode,
      outputBytes: job.outputBytes || output.bytes || 0,
      delivery: 'downloaded'
    });
  }
  notifyToast('Download started', job.filename, 'success', 2500);
  return dlRes;
}

function getCompletedDownloadEntries() {
  const entries = [];
  for (const job of store.getState().queue) {
    if (job.status !== 'done') {
      continue;
    }
    const output = jobOutputs.get(job.id);
    if (output && output.blob && output.blob.size > 0) {
      entries.push({ id: job.id, clipId: job.clipId, filename: job.filename, blob: output.blob });
    }
  }
  return entries;
}

export async function downloadAllCompletedJobs() {
  if (downloadBusy) {
    return fail(ERROR_CODES.E_DOWNLOAD_FAILED, 'Another download operation is already in progress.');
  }
  const entries = getCompletedDownloadEntries();
  if (entries.length === 0) {
    const err = createAppError(ERROR_CODES.E_DOWNLOAD_FAILED, 'No verified finished clips are ready to download.');
    reportError(err);
    return { ok: false, error: err };
  }

  downloadBusy = true;
  downloadStatus = {
    variant: 'ok',
    title: `Downloading ${entries.length} ${entries.length === 1 ? 'clip' : 'clips'} one by one…`,
    detail: 'Keep this tab open until downloads finish.'
  };
  renderExportEnginePanel(store.getState());

  try {
    const batchRes = await downloadBatchSequentially(entries, {
      onItemDone: (item, index, total) => {
        updateClipStatusMap(null, { [item.clipId]: 'downloaded' });
        if (typeof engineCallbacks.onExportRecord === 'function') {
          const curState = store.getState();
          const job = curState.queue.find((j) => j.id === item.id);
          const clip = curState.clips.find((c) => c.id === item.clipId);
          engineCallbacks.onExportRecord({
            sourceName: curState.source ? curState.source.name : '',
            clipName: job ? job.clipName : (clip ? clip.name : 'Clip'),
            filename: item.filename,
            startSec: clip ? clip.startSec : 0,
            endSec: clip ? clip.endSec : 0,
            durationSec: job ? job.outputDurationSec : 0,
            format: job ? job.format : 'mp4',
            mode: job ? job.mode : 'precise',
            outputBytes: item.blob ? item.blob.size : 0,
            delivery: 'downloaded'
          });
        }
        downloadStatus = {
          variant: 'ok',
          title: `Triggered ${index + 1} of ${total}: ${item.filename}`,
          detail: 'Allow automatic downloads if your browser prompts.'
        };
        renderDownloadStatusBox(engineRefs);
      }
    });

    if (!batchRes.ok) {
      downloadStatus = { variant: 'error', title: `${batchRes.error.code}: ${batchRes.error.message}`, detail: batchRes.error.hint };
      reportError(batchRes.error);
      return batchRes;
    }

    const { downloadedIds, failedItems, multiDownloadNote } = batchRes.value;
    downloadStatus = failedItems.length > 0
      ? { variant: 'warn', title: `Downloaded ${downloadedIds.length} of ${entries.length} clips (${failedItems.length} failed)`, detail: multiDownloadNote || 'Use each clip\'s Download button individually.' }
      : { variant: 'ok', title: `Triggered ${downloadedIds.length} ${downloadedIds.length === 1 ? 'download' : 'downloads'}`, detail: multiDownloadNote || 'All clips saved to your Downloads folder.' };
    return batchRes;
  } finally {
    downloadBusy = false;
    renderExportEnginePanel(store.getState());
  }
}

export async function downloadCompletedAsZip() {
  if (downloadBusy) {
    return fail(ERROR_CODES.E_ZIP_FAILED, 'Another download or ZIP operation is already in progress.');
  }
  const entries = getCompletedDownloadEntries();
  if (entries.length === 0) {
    const err = createAppError(ERROR_CODES.E_ZIP_FAILED, 'Export at least one clip before creating a ZIP archive.');
    reportError(err);
    return { ok: false, error: err };
  }

  const estRes = estimateZipTotalBytes(entries);
  if (!estRes.ok) {
    downloadStatus = { variant: 'error', title: `${estRes.error.code}: ${estRes.error.message}`, detail: estRes.error.hint };
    reportError(estRes.error);
    renderExportEnginePanel(store.getState());
    return estRes;
  }

  const state = store.getState();
  const zipNameRes = buildZipFilename(state.source ? state.source.name : 'heiwa_clips');
  const zipFilename = zipNameRes.ok ? zipNameRes.value : 'heiwa_clips.zip';

  downloadBusy = true;
  downloadStatus = { variant: 'ok', title: `Building store-only ZIP (${entries.length} clips)…`, detail: '0% — Computing CRC-32 checksums…' };
  renderExportEnginePanel(store.getState());

  try {
    const saveRes = await saveZipArchive(entries, zipFilename, {
      onProgress: ({ pct, phase }) => {
        downloadStatus = { variant: 'ok', title: `Creating ${zipFilename} (${pct}%)`, detail: phase };
        renderDownloadStatusBox(engineRefs);
      }
    });

    if (!saveRes.ok) {
      downloadStatus = {
        variant: saveRes.error.code === ERROR_CODES.E_CANCELLED ? 'warn' : 'error',
        title: `${saveRes.error.code}: ${saveRes.error.message}`,
        detail: saveRes.error.hint
      };
      reportError(saveRes.error);
      return saveRes;
    }

    const exportPatches = {};
    for (const item of entries) {
      exportPatches[item.clipId] = 'zipped';
    }
    updateClipStatusMap(null, exportPatches);
    if (typeof engineCallbacks.onExportRecord === 'function') {
      const curState = store.getState();
      engineCallbacks.onExportRecord({
        sourceName: curState.source ? curState.source.name : '',
        clipName: `ZIP Archive (${saveRes.value.entryCount} clips)`,
        filename: saveRes.value.filename,
        startSec: 0,
        endSec: 0,
        durationSec: 0,
        format: curState.exportSettings.format,
        mode: curState.exportSettings.mode,
        outputBytes: saveRes.value.totalBytes,
        delivery: 'zipped'
      });
    }

    const sizeRes = formatFileSize(saveRes.value.totalBytes);
    const methodLabel = saveRes.value.method === 'stream' ? 'streamed directly to disk' : 'assembled as ZIP download';
    downloadStatus = {
      variant: 'ok',
      title: `Saved ${saveRes.value.filename}`,
      detail: `${saveRes.value.entryCount} clips • ${sizeRes.ok ? sizeRes.value : `${saveRes.value.totalBytes} B`} (${methodLabel}, store-only).`
    };
    notifyToast('ZIP ready', `${saveRes.value.filename} (${sizeRes.ok ? sizeRes.value : ''})`, 'success', 4000);
    return saveRes;
  } finally {
    downloadBusy = false;
    renderExportEnginePanel(store.getState());
  }
}

export function clearExportQueue() {
  if (queueRunning) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Cancel the running export before clearing the queue.');
  }
  jobOutputs.clear();
  downloadStatus = null;
  lastRenderedQueueKey = '';
  store.dispatch({ type: ACTIONS.SET_QUEUE, payload: [] });

  const state = store.getState();
  if (state.clips.length > 0) {
    store.dispatch({
      type: ACTIONS.CLIPS_REPLACE_NO_HISTORY,
      payload: state.clips.map((c) => ({ ...c, processStatus: 'idle', exportStatus: 'none' }))
    });
  }
  renderExportEnginePanel(store.getState());
  return ok(true);
}

export function cancelActiveEngineJob() {
  if (!queueRunning && !activeJobHandle) {
    return ok(false);
  }
  queueCancelRequested = true;
  if (activeJobHandle) {
    activeJobHandle.cancel();
  }
  return ok(true);
}

export function resetExportEngineForSourceChange() {
  cancelActiveEngineJob();
  jobOutputs.clear();
  revokeAllDownloadUrls();
  latestPreflight = null;
  downloadStatus = null;
  lastRenderedQueueKey = '';
  if (store.getState().queue.length > 0) {
    store.dispatch({ type: ACTIONS.SET_QUEUE, payload: [] });
  }
  if (engineRefs) {
    renderExportEnginePanel(store.getState());
  }
  return ok(true);
}

/* --- Export Queue & Download UI Rendering --- */

function setToggleActive(btn, active) {
  if (!btn) {
    return;
  }
  btn.classList.toggle('btn--active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function formatDurationRough(minSec, maxSec) {
  const fmt = (sec) => (sec < 60 ? `${sec}s` : (sec % 60 > 0 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 60)}m`));
  return `~${fmt(minSec)}–${fmt(maxSec)} (rough estimate)`;
}

function getSelectedClip(state) {
  if (!Array.isArray(state.clips) || !state.selectedClipId) {
    return null;
  }
  return state.clips.find((c) => c.id === state.selectedClipId) || null;
}

function renderPreflightBox(refs, preflight) {
  if (!refs || !refs.preflightBox) {
    return;
  }
  clearChildren(refs.preflightBox);
  if (!preflight) {
    refs.preflightBox.className = 'alert-box';
    refs.preflightBox.appendChild(makeEl('p', 'alert-box__title', 'Preflight: open a video and add clips to validate encoder support.'));
    return;
  }
  const statusClass = preflight.ready ? (preflight.warnings.length > 0 ? 'alert-box--warn' : 'alert-box--ok') : 'alert-box--error';
  refs.preflightBox.className = `alert-box ${statusClass}`;
  refs.preflightBox.appendChild(makeEl(
    'p',
    'alert-box__title',
    preflight.ready
      ? `Preflight Passed (${preflight.settings.mode === 'fast' ? 'Fast Copy' : 'Precise'} • ${preflight.settings.format.toUpperCase()})`
      : 'Preflight Blocked — Action Needed'
  ));
  if (preflight.estimate) {
    const estSize = formatFileSize(preflight.estimate.totalEstimatedBytes);
    refs.preflightBox.appendChild(makeEl(
      'p',
      '',
      `Clips: ${preflight.estimate.clipCount} • Total duration: ${preflight.estimate.totalDurationSec}s • Est. size: ${estSize.ok ? estSize.value : 'Unknown'} • Est. time: ${formatDurationRough(preflight.estimate.estimatedSecondsMin, preflight.estimate.estimatedSecondsMax)}`
    ));
  }
  for (const blocker of preflight.blockers) {
    refs.preflightBox.appendChild(makeEl('p', '', `${blocker.code}: ${blocker.message} ${blocker.hint}`));
  }
  for (const warning of preflight.warnings) {
    refs.preflightBox.appendChild(makeEl('p', '', `Note: ${warning}`));
  }
}

function renderDownloadStatusBox(refs) {
  if (!refs || !refs.dlStatusBox) {
    return;
  }
  clearChildren(refs.dlStatusBox);
  if (!downloadStatus) {
    refs.dlStatusBox.hidden = true;
    return;
  }
  refs.dlStatusBox.className = `alert-box alert-box--${downloadStatus.variant || 'ok'}`;
  refs.dlStatusBox.appendChild(makeEl('p', 'alert-box__title', downloadStatus.title));
  if (downloadStatus.detail) {
    refs.dlStatusBox.appendChild(makeEl('p', '', downloadStatus.detail));
  }
  refs.dlStatusBox.hidden = false;
}

function buildJobCard(job, index) {
  const li = makeEl('li', `job-card job-card--${job.status}`);
  li.dataset.jobId = job.id;

  const head = makeEl('div', 'job-card__head');
  head.appendChild(makeEl('span', 'job-card__title', `#${index + 1} ${job.clipName || 'Clip'}`));

  const pillMod = job.status === 'done'
    ? 'success'
    : job.status === 'running' || job.status === 'queued'
      ? 'processing'
      : job.status === 'failed'
        ? 'failure'
        : 'cancelled';
  head.appendChild(makeEl('span', `status-pill status-pill--${pillMod}`, job.status));
  li.appendChild(head);

  let phaseText = PHASE_LABELS[job.status] || job.status;
  if (job.status === 'done') {
    const sizeRes = formatFileSize(job.outputBytes);
    phaseText = `Verified • ${job.outputMime || job.format.toUpperCase()} • ${sizeRes.ok ? sizeRes.value : `${job.outputBytes} B`} • ${job.outputDurationSec}s`;
  } else if (job.status === 'running') {
    phaseText = `${job.progress}% — ${PHASE_LABELS[job.phase] || job.phase || 'Processing…'}`;
  } else if (job.status === 'failed' && job.error) {
    phaseText = `${job.error.code}: ${job.error.message} ${job.error.hint}`;
  }
  li.appendChild(makeEl('p', 'job-card__phase', phaseText));

  if (job.status === 'running' || job.status === 'queued') {
    const bar = makeEl('progress', 'export-progress__bar job-card__progress');
    bar.max = 100;
    bar.value = job.progress || 0;
    li.appendChild(bar);
  }

  const fileRow = makeEl('div', 'job-card__file-row');
  const nameLabel = makeEl('label', 'job-card__filename-wrap');
  nameLabel.appendChild(makeEl('span', 'sr-only', `Output filename for ${job.clipName || `clip ${index + 1}`}`));

  const nameInput = makeEl('input', 'text-input job-card__filename-input');
  nameInput.type = 'text';
  nameInput.value = job.filename;
  nameInput.disabled = job.status === 'running' || job.status === 'queued';
  nameInput.dataset.jobFilename = job.id;
  nameLabel.appendChild(nameInput);
  fileRow.appendChild(nameLabel);

  const actions = makeEl('div', 'job-card__actions');
  if (job.status === 'done' && jobOutputs.has(job.id)) {
    const dlBtn = makeEl('button', 'btn btn--primary btn--compact', 'Download');
    dlBtn.type = 'button';
    dlBtn.dataset.jobAction = 'download';
    dlBtn.dataset.jobId = job.id;
    actions.appendChild(dlBtn);
  }
  if ((job.status === 'failed' || job.status === 'cancelled') && !queueRunning) {
    const retryBtn = makeEl('button', 'btn btn--secondary btn--compact', 'Retry');
    retryBtn.type = 'button';
    retryBtn.dataset.jobAction = 'retry';
    retryBtn.dataset.jobId = job.id;
    actions.appendChild(retryBtn);
  }
  fileRow.appendChild(actions);
  li.appendChild(fileRow);
  return li;
}

function buildQueueRenderKey(queue, isRunning) {
  return `${isRunning ? '1' : '0'}|${queue
    .map((j) => `${j.id}:${j.status}:${j.filename}:${j.outputBytes}:${j.error ? j.error.code : ''}:${jobOutputs.has(j.id) ? '1' : '0'}`)
    .join('|')}`;
}

function renderQueueSection(refs, state) {
  if (!refs || !refs.queueList) {
    return;
  }
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const summary = computeQueueSummary(queue);
  const completedEntries = getCompletedDownloadEntries();
  const isPhone = detectPhoneDevice();

  if (refs.queueSummary) {
    if (summary.total === 0) {
      refs.queueSummary.textContent = 'No export jobs yet.';
    } else {
      const totalSizeRes = formatFileSize(summary.totalOutputBytes);
      const sizePart = summary.totalOutputBytes > 0 && totalSizeRes.ok ? ` • ${totalSizeRes.value}` : '';
      refs.queueSummary.textContent = `${summary.done}/${summary.total} verified (${summary.overallPct}%)${summary.failed > 0 ? ` • ${summary.failed} failed` : ''}${summary.cancelled > 0 ? ` • ${summary.cancelled} cancelled` : ''}${sizePart}`;
    }
  }
  if (refs.queueProgress) {
    refs.queueProgress.hidden = summary.total === 0;
    refs.queueProgress.value = summary.overallPct;
  }
  if (refs.queueEmpty) {
    refs.queueEmpty.hidden = summary.total > 0;
  }

  const nextKey = buildQueueRenderKey(queue, queueRunning);
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
  const editingFilename = activeEl && refs.queueList.contains(activeEl) && activeEl.dataset && activeEl.dataset.jobFilename;

  if (!editingFilename && nextKey !== lastRenderedQueueKey) {
    lastRenderedQueueKey = nextKey;
    clearChildren(refs.queueList);
    for (let i = 0; i < queue.length; i += 1) {
      refs.queueList.appendChild(buildJobCard(queue[i], i));
    }
  } else {
    for (const job of queue) {
      if (job.status === 'running') {
        updateActiveJobProgressDomOnly(job.id, job.progress || 0, job.phase);
      }
    }
  }

  if (refs.dlAllBtn) {
    refs.dlAllBtn.disabled = downloadBusy || completedEntries.length === 0;
    refs.dlAllBtn.textContent = completedEntries.length > 0 ? `Download All (${completedEntries.length})` : 'Download All';
    refs.dlAllBtn.classList.toggle('btn--primary', isPhone && completedEntries.length > 0);
    refs.dlAllBtn.classList.toggle('btn--secondary', !isPhone || completedEntries.length === 0);
  }
  if (refs.dlZipBtn) {
    refs.dlZipBtn.disabled = downloadBusy || completedEntries.length === 0;
    refs.dlZipBtn.textContent = completedEntries.length > 0 ? `Download ZIP (${completedEntries.length})` : 'Download ZIP';
    refs.dlZipBtn.classList.toggle('btn--primary', !isPhone && completedEntries.length > 0);
    refs.dlZipBtn.classList.toggle('btn--secondary', isPhone || completedEntries.length === 0);
  }
  if (refs.dlPhoneNote) {
    refs.dlPhoneNote.hidden = !isPhone;
    if (isPhone) {
      refs.dlPhoneNote.textContent = 'Phone recommendation: use Download All (individual files) instead of ZIP for large clips to stay within mobile browser memory limits.';
    }
  }
  renderDownloadStatusBox(refs);
}

export async function refreshExportPreflight(announce = false) {
  const seq = preflightSequence + 1;
  preflightSequence = seq;
  const state = store.getState();

  const res = await runExportPreflight({
    source: state.source,
    clips: state.clips,
    settings: state.exportSettings,
    capabilities: state.capabilities
  });
  if (seq !== preflightSequence) {
    return res;
  }

  latestPreflight = res.ok ? res.value : null;
  if (engineRefs) {
    renderExportEnginePanel(store.getState());
  }
  if (announce && latestPreflight) {
    if (latestPreflight.ready) {
      notifyToast('Export preflight passed', `${latestPreflight.settings.format.toUpperCase()} (${latestPreflight.settings.mode}) is supported on this device.`, 'success', 3000);
    } else if (latestPreflight.blockers.length > 0) {
      reportError(latestPreflight.blockers[0]);
    }
  }
  return res;
}

export function renderExportEnginePanel(state) {
  if (!engineRefs) {
    return;
  }
  const settings = normalizeExportSettings(state.exportSettings).value;
  const hasSource = Boolean(state.source);
  const clipCount = Array.isArray(state.clips) ? state.clips.length : 0;
  const selectedClip = getSelectedClip(state);
  const summary = computeQueueSummary(state.queue);
  const isRunning = queueRunning;

  const anyCropActive = state.clips.some((clip) => !isCropDefault(clip.crop));
  const fastCompatOk = hasSource
    ? isFastModeContainerCompatible(settings.format, state.source.videoCodec, state.source.audioCodec).ok
    : true;
  const fastDisabled = isRunning || anyCropActive || (hasSource && !fastCompatOk);

  setToggleActive(engineRefs.formatMp4Btn, settings.format === 'mp4');
  setToggleActive(engineRefs.formatWebmBtn, settings.format === 'webm');
  if (engineRefs.formatMp4Btn) {
    engineRefs.formatMp4Btn.disabled = isRunning;
  }
  if (engineRefs.formatWebmBtn) {
    engineRefs.formatWebmBtn.disabled = isRunning;
  }

  setToggleActive(engineRefs.modePreciseBtn, settings.mode === 'precise');
  setToggleActive(engineRefs.modeFastBtn, settings.mode === 'fast');
  if (engineRefs.modePreciseBtn) {
    engineRefs.modePreciseBtn.disabled = isRunning;
  }
  if (engineRefs.modeFastBtn) {
    engineRefs.modeFastBtn.disabled = fastDisabled;
  }

  if (engineRefs.fastNote) {
    engineRefs.fastNote.textContent = anyCropActive
      ? 'Fast mode is disabled while crop or reframe is active on any clip. Reset framing to Original or use Precise mode.'
      : (hasSource && !fastCompatOk)
        ? `Fast mode cannot copy "${state.source.videoCodec}" directly into ${settings.format.toUpperCase()}. Switch container format or use Precise mode.`
        : 'Fast mode: starts at the nearest earlier keyframe; the clip may begin slightly before your start point.';
  }

  const resButtons = [
    [engineRefs.res480Btn, 480],
    [engineRefs.res720Btn, 720],
    [engineRefs.res1080Btn, 1080],
    [engineRefs.res1920Btn, 1920]
  ];
  for (const [btn, maxSide] of resButtons) {
    if (btn) {
      btn.disabled = isRunning || settings.mode === 'fast';
      setToggleActive(btn, settings.maxSide === maxSide);
    }
  }

  const qualityButtons = [
    [engineRefs.qualityLowBtn, 'low'],
    [engineRefs.qualityMediumBtn, 'medium'],
    [engineRefs.qualityHighBtn, 'high']
  ];
  for (const [btn, quality] of qualityButtons) {
    if (btn) {
      btn.disabled = isRunning || settings.mode === 'fast';
      setToggleActive(btn, settings.quality === quality);
    }
  }

  if (engineRefs.preflightBtn) {
    engineRefs.preflightBtn.disabled = isRunning || !hasSource;
  }
  if (engineRefs.exportAllBtn) {
    engineRefs.exportAllBtn.disabled = isRunning || !hasSource || clipCount === 0;
    engineRefs.exportAllBtn.textContent = clipCount > 0 ? `Export All (${clipCount})` : 'Export All Clips';
  }
  if (engineRefs.exportSelectedBtn) {
    engineRefs.exportSelectedBtn.disabled = isRunning || !hasSource || !selectedClip;
    engineRefs.exportSelectedBtn.textContent = selectedClip ? `Export "${selectedClip.name}"` : 'Export Selected Clip';
  }
  if (engineRefs.exportCancelBtn) {
    engineRefs.exportCancelBtn.disabled = !isRunning;
  }
  if (engineRefs.exportRetryFailedBtn) {
    const retryableCount = summary.failed + summary.cancelled;
    engineRefs.exportRetryFailedBtn.disabled = isRunning || retryableCount === 0;
    engineRefs.exportRetryFailedBtn.textContent = retryableCount > 0 ? `Retry Failed (${retryableCount})` : 'Retry Failed';
  }
  if (engineRefs.exportClearQueueBtn) {
    engineRefs.exportClearQueueBtn.disabled = isRunning || summary.total === 0;
  }

  renderPreflightBox(engineRefs, latestPreflight);
  renderQueueSection(engineRefs, state);
}

function updateExportSetting(patch) {
  const next = normalizeExportSettings({ ...store.getState().exportSettings, ...patch }).value;
  if (
    !VALID_EXPORT_FORMATS.includes(next.format) ||
    !VALID_EXPORT_MODES.includes(next.mode) ||
    !VALID_EXPORT_QUALITIES.includes(next.quality)
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Invalid export settings patch.');
  }
  const res = store.dispatch({ type: ACTIONS.SET_EXPORT_SETTINGS, payload: next });
  refreshExportPreflight(false);
  return res;
}

export function initExportEngine(refs, callbacks = {}) {
  if (!refs || !refs.preflightBox) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing export engine DOM elements.');
  }
  if (engineInitialized) {
    return ok(true);
  }
  engineInitialized = true;
  engineRefs = refs;
  engineCallbacks = callbacks && typeof callbacks === 'object' ? callbacks : {};

  const wire = (btn, fn) => {
    if (btn) {
      btn.addEventListener('click', fn);
    }
  };

  wire(refs.formatMp4Btn, () => updateExportSetting({ format: 'mp4' }));
  wire(refs.formatWebmBtn, () => updateExportSetting({ format: 'webm' }));
  wire(refs.modePreciseBtn, () => updateExportSetting({ mode: 'precise' }));
  wire(refs.modeFastBtn, () => updateExportSetting({ mode: 'fast' }));
  wire(refs.res480Btn, () => updateExportSetting({ maxSide: 480 }));
  wire(refs.res720Btn, () => updateExportSetting({ maxSide: 720 }));
  wire(refs.res1080Btn, () => updateExportSetting({ maxSide: 1080 }));
  wire(refs.res1920Btn, () => updateExportSetting({ maxSide: 1920 }));
  wire(refs.qualityLowBtn, () => updateExportSetting({ quality: 'low' }));
  wire(refs.qualityMediumBtn, () => updateExportSetting({ quality: 'medium' }));
  wire(refs.qualityHighBtn, () => updateExportSetting({ quality: 'high' }));
  wire(refs.preflightBtn, () => refreshExportPreflight(true));
  wire(refs.exportAllBtn, () => startExportQueue(store.getState().clips));
  wire(refs.exportSelectedBtn, () => {
    const selected = getSelectedClip(store.getState());
    if (selected) {
      startExportQueue([selected]);
    }
  });
  wire(refs.exportCancelBtn, () => cancelActiveEngineJob());
  wire(refs.exportRetryFailedBtn, () => retryFailedJobs());
  wire(refs.exportClearQueueBtn, () => clearExportQueue());
  wire(refs.dlAllBtn, () => downloadAllCompletedJobs());
  wire(refs.dlZipBtn, () => downloadCompletedAsZip());

  if (refs.queueList) {
    refs.queueList.addEventListener('click', (event) => {
      const btn = event.target instanceof Element ? event.target.closest('[data-job-action]') : null;
      if (!btn) {
        return;
      }
      const { jobAction, jobId } = btn.dataset;
      if (jobAction === 'download' && jobId) {
        downloadJobById(jobId);
      } else if (jobAction === 'retry' && jobId) {
        retrySingleJob(jobId);
      }
    });

    refs.queueList.addEventListener('change', (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (!input || !input.dataset.jobFilename) {
        return;
      }
      const jobId = input.dataset.jobFilename;
      const res = updateJobFilename(jobId, input.value);
      if (res.ok) {
        input.value = res.value;
      } else {
        reportError(res.error);
        const existing = store.getState().queue.find((j) => j.id === jobId);
        if (existing) {
          input.value = existing.filename;
        }
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      cancelActiveEngineJob();
      revokeAllDownloadUrls();
    });
  }

  renderExportEnginePanel(store.getState());
  return ok(true);
}
