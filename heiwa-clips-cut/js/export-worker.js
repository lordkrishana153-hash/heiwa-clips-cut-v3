/* Stage 6 module Web Worker: Mediabunny 1.62.0 Precise (re-encode/crop) & Fast (keyframe packet copy) pipeline. */

import { createAppError, ERROR_CODES, fail, ok } from './errors.js';
import { computeCropPlan, drawFramedFrame, isCropDefault, normalizeCrop } from './crop.js';
import { loadMediabunny } from './metadata.js';

export const EXPORT_WORKER_STAGE = 6;
export const VALID_EXPORT_FORMATS = Object.freeze(['mp4', 'webm']);
export const VALID_EXPORT_MODES = Object.freeze(['precise', 'fast']);
export const VALID_EXPORT_QUALITIES = Object.freeze(['low', 'medium', 'high']);

const MP4_VIDEO_CODECS = new Set(['avc', 'hevc', 'av1']);
const MP4_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus']);
const WEBM_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO_CODECS = new Set(['opus', 'vorbis']);

const PROGRESS_THROTTLE_MS = 100;

let workerBlurSupportCache = null;
let activeJob = null;

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function normalizeCodecFamily(codec) {
  if (typeof codec !== 'string' || !codec.trim()) {
    return null;
  }
  const lower = codec.trim().toLowerCase();
  if (lower === 'avc' || lower.startsWith('avc1') || lower.includes('h264') || lower.includes('h.264')) {
    return 'avc';
  }
  if (lower === 'hevc' || lower.startsWith('hvc1') || lower.startsWith('hev1') || lower.includes('h265')) {
    return 'hevc';
  }
  if (lower === 'vp9' || lower.startsWith('vp09')) {
    return 'vp9';
  }
  if (lower === 'vp8' || lower.startsWith('vp08')) {
    return 'vp8';
  }
  if (lower === 'av1' || lower.startsWith('av01')) {
    return 'av1';
  }
  if (lower === 'aac' || lower.startsWith('mp4a')) {
    return 'aac';
  }
  if (lower === 'opus') {
    return 'opus';
  }
  if (lower === 'mp3') {
    return 'mp3';
  }
  if (lower === 'vorbis') {
    return 'vorbis';
  }
  return lower;
}

export function isFastModeContainerCompatible(format, videoCodec, audioCodec) {
  const fmt = VALID_EXPORT_FORMATS.includes(format) ? format : 'mp4';
  const vFam = normalizeCodecFamily(videoCodec);
  const aFam = audioCodec === null || audioCodec === undefined ? null : normalizeCodecFamily(audioCodec);

  if (!vFam) {
    return fail(
      ERROR_CODES.E_UNSUPPORTED_CODEC,
      'Source video codec is unknown, so Fast mode packet copy cannot be verified.',
      'Use Precise mode to re-encode cleanly.'
    );
  }

  const videoSet = fmt === 'mp4' ? MP4_VIDEO_CODECS : WEBM_VIDEO_CODECS;
  const audioSet = fmt === 'mp4' ? MP4_AUDIO_CODECS : WEBM_AUDIO_CODECS;

  if (!videoSet.has(vFam)) {
    const otherFormat = fmt === 'mp4' ? 'WebM' : 'MP4';
    return fail(
      ERROR_CODES.E_UNSUPPORTED_CODEC,
      `Fast mode cannot copy "${videoCodec}" video packets into ${fmt.toUpperCase()}.`,
      `Switch output format to ${otherFormat} or use Precise mode to re-encode.`
    );
  }

  if (aFam !== null && !audioSet.has(aFam)) {
    return fail(
      ERROR_CODES.E_UNSUPPORTED_CODEC,
      `Fast mode cannot copy "${audioCodec}" audio packets into ${fmt.toUpperCase()}.`,
      'Switch to Precise mode to re-encode audio into the target container.'
    );
  }

  return ok({ format: fmt, videoCodec: vFam, audioCodec: aFam });
}

export function normalizeExportSettings(settings) {
  const input = settings && typeof settings === 'object' ? settings : {};
  const format = VALID_EXPORT_FORMATS.includes(input.format) ? input.format : 'mp4';
  const mode = VALID_EXPORT_MODES.includes(input.mode) ? input.mode : 'precise';
  const quality = VALID_EXPORT_QUALITIES.includes(input.quality) ? input.quality : 'high';
  const rawMaxSide = typeof input.maxSide === 'number' && Number.isFinite(input.maxSide)
    ? Math.round(input.maxSide)
    : 1080;
  const maxSide = Math.max(240, Math.min(4096, Math.floor(rawMaxSide / 2) * 2));

  return ok({ format, mode, maxSide, quality });
}

export function selectVideoProbeCodecs(format, outputWidth, outputHeight) {
  const pixels = outputWidth * outputHeight;
  if (format === 'webm') {
    if (pixels > 2_228_224) {
      return ['vp09.00.50.08', 'vp09.00.40.08'];
    }
    if (pixels > 921_600) {
      return ['vp09.00.40.08', 'vp09.00.31.08'];
    }
    return ['vp09.00.31.08', 'vp09.00.10.08'];
  }

  if (pixels > 2_228_224) {
    return ['avc1.640032', 'avc1.4d0032', 'avc1.640028'];
  }
  if (pixels > 921_600) {
    return ['avc1.640028', 'avc1.4d0028', 'avc1.420028'];
  }
  return ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f'];
}

export function computeBitrateProfile(outputWidth, outputHeight, settings) {
  if (
    typeof outputWidth !== 'number' ||
    !Number.isFinite(outputWidth) ||
    outputWidth < 2 ||
    typeof outputHeight !== 'number' ||
    !Number.isFinite(outputHeight) ||
    outputHeight < 2
  ) {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'Output dimensions must be valid positive numbers.');
  }

  const norm = normalizeExportSettings(settings).value;
  const pixelScale = (outputWidth * outputHeight) / (1920 * 1080);

  let baseVideoBps = 6_000_000;
  let minVideoBps = 600_000;
  let maxVideoBps = 12_000_000;
  let audioBitrate = 192_000;

  if (norm.quality === 'medium') {
    baseVideoBps = 3_500_000;
    minVideoBps = 450_000;
    maxVideoBps = 7_000_000;
    audioBitrate = 128_000;
  } else if (norm.quality === 'low') {
    baseVideoBps = 1_800_000;
    minVideoBps = 300_000;
    maxVideoBps = 3_500_000;
    audioBitrate = 96_000;
  }

  const rawVideo = Math.round((baseVideoBps * Math.pow(Math.max(pixelScale, 0.08), 0.78)) / 50_000) * 50_000;
  const videoBitrate = Math.max(minVideoBps, Math.min(maxVideoBps, rawVideo));

  return ok({
    format: norm.format,
    mime: norm.format === 'mp4' ? 'video/mp4' : 'video/webm',
    mediabunnyVideoCodec: norm.format === 'mp4' ? 'avc' : 'vp9',
    mediabunnyAudioCodec: norm.format === 'mp4' ? 'aac' : 'opus',
    videoProbeCodecs: selectVideoProbeCodecs(norm.format, outputWidth, outputHeight),
    audioProbeCodec: norm.format === 'mp4' ? 'mp4a.40.2' : 'opus',
    videoBitrate,
    audioBitrate
  });
}

export function validateWorkerStartMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'start') {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Invalid worker start message.');
  }
  if (typeof msg.jobId !== 'string' || !msg.jobId.trim()) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Worker start message requires a non-empty jobId.');
  }
  if (!msg.file || typeof msg.file.size !== 'number' || msg.file.size <= 0) {
    return fail(ERROR_CODES.E_EMPTY_FILE, 'Source video file is missing or empty.');
  }
  if (!msg.clip || typeof msg.clip !== 'object') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip specification is missing.');
  }
  const { startSec, endSec } = msg.clip;
  if (
    typeof startSec !== 'number' ||
    !Number.isFinite(startSec) ||
    typeof endSec !== 'number' ||
    !Number.isFinite(endSec) ||
    startSec < 0 ||
    endSec <= startSec
  ) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Clip start and end times are invalid.');
  }

  const settings = normalizeExportSettings(msg.settings).value;
  const crop = normalizeCrop(msg.clip.crop).value;

  return ok({
    jobId: msg.jobId,
    file: msg.file,
    clip: {
      ...msg.clip,
      startSec,
      endSec,
      crop
    },
    settings
  });
}

function detectWorkerBlurSupport() {
  if (workerBlurSupportCache !== null) {
    return workerBlurSupportCache;
  }
  if (typeof OffscreenCanvas !== 'function') {
    workerBlurSupportCache = false;
    return false;
  }
  try {
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !('filter' in ctx)) {
      workerBlurSupportCache = false;
      return false;
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 16, 16);
    ctx.filter = 'blur(4px)';
    if (ctx.filter !== 'blur(4px)') {
      workerBlurSupportCache = false;
      return false;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(7, 7, 2, 2);
    const sample = ctx.getImageData(4, 7, 1, 1).data;
    workerBlurSupportCache = sample[0] > 0;
    return workerBlurSupportCache;
  } catch {
    workerBlurSupportCache = false;
    return false;
  }
}

async function verifyWorkerEncoderSupport(plan, profile, hasAudio, fps) {
  if (
    typeof VideoEncoder !== 'function' ||
    typeof VideoEncoder.isConfigSupported !== 'function'
  ) {
    return fail(ERROR_CODES.E_NO_WEBCODECS);
  }

  let videoSupported = false;
  for (const codec of profile.videoProbeCodecs) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec,
        width: plan.outputWidth,
        height: plan.outputHeight,
        bitrate: profile.videoBitrate,
        framerate: fps
      });
      if (res && res.supported) {
        videoSupported = true;
        break;
      }
    } catch {
      /* Try next codec profile level. */
    }
  }

  if (!videoSupported) {
    const altFormat = profile.format === 'mp4' ? 'WebM (VP9/Opus)' : 'MP4 (H.264/AAC)';
    return fail(
      ERROR_CODES.E_ENCODER_UNSUPPORTED,
      `Video encoder does not support ${profile.format.toUpperCase()} at ${plan.outputWidth}×${plan.outputHeight}.`,
      `Switch to ${altFormat} or lower the maximum resolution (720p or 480p) and retry.`
    );
  }

  if (hasAudio) {
    if (
      typeof AudioEncoder !== 'function' ||
      typeof AudioEncoder.isConfigSupported !== 'function'
    ) {
      return fail(ERROR_CODES.E_NO_WEBCODECS);
    }
    let audioSupported = false;
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: profile.audioProbeCodec,
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: profile.audioBitrate
      });
      audioSupported = Boolean(res && res.supported);
    } catch {
      audioSupported = false;
    }

    if (!audioSupported) {
      const altFormat = profile.format === 'mp4' ? 'WebM (VP9/Opus)' : 'MP4 (H.264/AAC)';
      return fail(
        ERROR_CODES.E_ENCODER_UNSUPPORTED,
        `Audio encoder (${profile.audioProbeCodec}) is not supported in this browser.`,
        `Switch output format to ${altFormat} and retry.`
      );
    }
  }

  return ok(true);
}

function postWorkerMessage(payload) {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.postMessage(payload);
  }
}

function createProgressEmitter(jobId) {
  let lastTime = 0;
  let lastPct = -1;
  let lastPhase = '';

  return (pct, phase, force = false) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const now = Date.now();
    if (!force && clamped === lastPct && phase === lastPhase) {
      return;
    }
    if (!force && phase === lastPhase && now - lastTime < PROGRESS_THROTTLE_MS && clamped < 100) {
      return;
    }
    lastTime = now;
    lastPct = clamped;
    lastPhase = phase;
    postWorkerMessage({ type: 'progress', jobId, pct: clamped, phase });
  };
}

function buildOutputContainer(mb, format) {
  const formatObj = format === 'mp4'
    ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' })
    : new mb.WebMOutputFormat();
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: formatObj, target });
  return { output, target };
}

function mapConversionInvalidError(discardedTracks, format) {
  const reasons = Array.isArray(discardedTracks)
    ? discardedTracks.map((d) => (d && d.reason ? d.reason : 'unknown')).join(', ')
    : '';
  const lower = reasons.toLowerCase();
  if (lower.includes('codec') || lower.includes('encod')) {
    const altFormat = format === 'mp4' ? 'WebM' : 'MP4';
    return createAppError(
      ERROR_CODES.E_ENCODER_UNSUPPORTED,
      `Mediabunny could not encode a track for ${format.toUpperCase()} (${reasons}).`,
      `Switch output format to ${altFormat} or lower the maximum resolution and retry.`
    );
  }
  return createAppError(
    ERROR_CODES.E_EXPORT_FAILED,
    `Export pipeline could not initialize (${reasons || 'invalid track configuration'}).`
  );
}

async function runPrecisePipeline(mb, jobState, parsed, emitProgress) {
  const { file, clip, settings } = parsed;
  let input = null;
  let stageCanvas = null;
  let outCanvas = null;

  try {
    emitProgress(2, 'analyzing', true);
    input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(file)
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return fail(ERROR_CODES.E_UNSUPPORTED_CONTAINER, 'No readable video track found in source.');
    }
    const audioTrack = await input.getPrimaryAudioTrack();

    const srcW = videoTrack.displayWidth || 0;
    const srcH = videoTrack.displayHeight || 0;
    const planRes = computeCropPlan(srcW, srcH, clip.crop, settings.maxSide);
    if (!planRes.ok) {
      return planRes;
    }
    const plan = planRes.value;

    const profileRes = computeBitrateProfile(plan.outputWidth, plan.outputHeight, settings);
    if (!profileRes.ok) {
      return profileRes;
    }
    const profile = profileRes.value;

    const fps = 30;
    const encCheck = await verifyWorkerEncoderSupport(plan, profile, Boolean(audioTrack), fps);
    if (!encCheck.ok) {
      return encCheck;
    }

    if (jobState.cancelled) {
      return ok({ cancelled: true });
    }

    const needsCanvasProcess =
      !isCropDefault(clip.crop) ||
      plan.outputWidth !== srcW ||
      plan.outputHeight !== srcH;

    const videoOpts = {
      codec: profile.mediabunnyVideoCodec,
      bitrate: profile.videoBitrate,
      forceTranscode: true
    };

    if (needsCanvasProcess) {
      if (typeof OffscreenCanvas !== 'function') {
        if (!isCropDefault(clip.crop)) {
          return fail(
            ERROR_CODES.E_EXPORT_FAILED,
            'OffscreenCanvas is unavailable in this browser worker, so cropped export cannot run.',
            'Reset clip framing to Original or use a browser with OffscreenCanvas support.'
          );
        }
        videoOpts.width = plan.outputWidth;
        videoOpts.height = plan.outputHeight;
      } else {
        stageCanvas = new OffscreenCanvas(srcW, srcH);
        const stageCtx = stageCanvas.getContext('2d');
        outCanvas = new OffscreenCanvas(plan.outputWidth, plan.outputHeight);
        const outCtx = outCanvas.getContext('2d');
        if (!stageCtx || !outCtx) {
          return fail(
            ERROR_CODES.E_EXPORT_FAILED,
            'Could not initialize 2D OffscreenCanvas contexts for frame processing.'
          );
        }
        const blurSupported = detectWorkerBlurSupport();

        videoOpts.process = (sample) => {
          if (jobState.cancelled) {
            return null;
          }
          const frameW = sample.displayWidth || srcW;
          const frameH = sample.displayHeight || srcH;
          if (stageCanvas.width !== frameW || stageCanvas.height !== frameH) {
            stageCanvas.width = frameW;
            stageCanvas.height = frameH;
          }
          stageCtx.clearRect(0, 0, frameW, frameH);
          sample.draw(stageCtx, 0, 0, frameW, frameH);
          drawFramedFrame(outCtx, stageCanvas, plan, { blurSupported });
          return outCanvas;
        };
      }
    }

    const audioOpts = audioTrack
      ? {
          codec: profile.mediabunnyAudioCodec,
          bitrate: profile.audioBitrate,
          forceTranscode: true
        }
      : { discard: true };

    const { output, target } = buildOutputContainer(mb, settings.format);
    jobState.output = output;

    const conversion = await mb.Conversion.init({
      input,
      output,
      trim: {
        start: clip.startSec,
        end: clip.endSec
      },
      video: videoOpts,
      audio: audioOpts
    });
    jobState.conversion = conversion;

    if (jobState.cancelled) {
      if (typeof conversion.cancel === 'function') {
        await conversion.cancel();
      }
      return ok({ cancelled: true });
    }

    if (!conversion.isValid) {
      return {
        ok: false,
        error: mapConversionInvalidError(conversion.discardedTracks, settings.format)
      };
    }

    emitProgress(5, 'encoding', true);
    conversion.onProgress = (progress) => {
      if (jobState.cancelled) {
        return;
      }
      const mapped = 5 + Math.max(0, Math.min(1, progress)) * 93;
      emitProgress(mapped, 'encoding');
    };

    await conversion.execute();

    if (jobState.cancelled || conversion.state === 'canceled') {
      return ok({ cancelled: true });
    }

    emitProgress(99, 'finalizing', true);
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      return fail(ERROR_CODES.E_OUTPUT_EMPTY);
    }

    const blob = new Blob([buffer], { type: profile.mime });
    return ok({
      cancelled: false,
      blob,
      mime: profile.mime,
      durationSec: round3(clip.endSec - clip.startSec),
      bytes: blob.size
    });
  } catch (err) {
    if (jobState.cancelled) {
      return ok({ cancelled: true });
    }
    const detail = err instanceof Error ? err.message : String(err || '');
    return fail(
      ERROR_CODES.E_EXPORT_FAILED,
      detail ? `Precise export failed: ${detail}` : undefined
    );
  } finally {
    jobState.conversion = null;
    jobState.output = null;
    if (stageCanvas) {
      stageCanvas.width = 0;
      stageCanvas.height = 0;
    }
    if (outCanvas) {
      outCanvas.width = 0;
      outCanvas.height = 0;
    }
    if (input && typeof input.dispose === 'function') {
      try {
        input.dispose();
      } catch {
        /* Ignore input dispose errors. */
      }
    }
  }
}

async function runFastPipeline(mb, jobState, parsed, emitProgress) {
  const { file, clip, settings } = parsed;
  if (!isCropDefault(clip.crop)) {
    return fail(
      ERROR_CODES.E_RANGE_INVALID,
      'Fast mode cannot apply crop, zoom, or aspect ratio changes.',
      'Switch to Precise mode to export cropped or reframed clips.'
    );
  }

  let input = null;
  let output = null;
  let videoSource = null;
  let audioSource = null;

  try {
    emitProgress(2, 'analyzing', true);
    input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source: new mb.BlobSource(file)
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return fail(ERROR_CODES.E_UNSUPPORTED_CONTAINER, 'No readable video track found in source.');
    }
    const audioTrack = await input.getPrimaryAudioTrack();

    const compatRes = isFastModeContainerCompatible(
      settings.format,
      videoTrack.codec,
      audioTrack ? audioTrack.codec : null
    );
    if (!compatRes.ok) {
      return compatRes;
    }

    if (
      typeof mb.EncodedPacketSink !== 'function' ||
      typeof mb.EncodedVideoPacketSource !== 'function'
    ) {
      return fail(
        ERROR_CODES.E_EXPORT_FAILED,
        'Mediabunny packet copy APIs are unavailable.',
        'Switch to Precise mode to export this clip.'
      );
    }

    const videoSink = new mb.EncodedPacketSink(videoTrack);
    const firstKey = await videoSink.getKeyPacket(clip.startSec);
    if (!firstKey) {
      return fail(
        ERROR_CODES.E_EXPORT_FAILED,
        'Could not locate a video keyframe at or before the clip start time.',
        'Switch to Precise mode to re-encode from the exact start timestamp.'
      );
    }

    const actualStartSec = firstKey.timestamp;
    const expectedSpan = Math.max(0.001, clip.endSec - actualStartSec);
    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    if (!videoDecoderConfig) {
      return fail(
        ERROR_CODES.E_UNSUPPORTED_CODEC,
        'Could not extract video decoder configuration for Fast mode copy.',
        'Switch to Precise mode to re-encode.'
      );
    }

    const built = buildOutputContainer(mb, settings.format);
    output = built.output;
    const target = built.target;
    jobState.output = output;

    videoSource = new mb.EncodedVideoPacketSource(videoTrack.codec);
    const videoTrackMeta = typeof videoTrack.rotation === 'number'
      ? { rotation: videoTrack.rotation }
      : undefined;
    output.addVideoTrack(videoSource, videoTrackMeta);

    let audioSink = null;
    let audioDecoderConfig = null;
    if (audioTrack && typeof mb.EncodedAudioPacketSource === 'function') {
      audioDecoderConfig = await audioTrack.getDecoderConfig();
      if (audioDecoderConfig) {
        audioSink = new mb.EncodedPacketSink(audioTrack);
        audioSource = new mb.EncodedAudioPacketSource(audioTrack.codec);
        output.addAudioTrack(audioSource);
      }
    }

    if (jobState.cancelled) {
      await output.cancel();
      return ok({ cancelled: true });
    }

    await output.start();
    emitProgress(5, 'copying-video', true);

    const videoProgressCeiling = audioSource ? 75 : 94;
    let videoPacketCount = 0;
    let maxVideoEndSec = 0;

    for await (const packet of videoSink.packets(firstKey)) {
      if (jobState.cancelled) {
        break;
      }
      if (packet.timestamp >= clip.endSec && videoPacketCount > 0) {
        break;
      }
      const shiftedTs = Math.max(0, packet.timestamp - actualStartSec);
      const shifted = packet.clone({ timestamp: shiftedTs });
      if (videoPacketCount === 0) {
        await videoSource.add(shifted, { decoderConfig: videoDecoderConfig });
      } else {
        await videoSource.add(shifted);
      }
      videoPacketCount += 1;
      const pktEnd = shiftedTs + (typeof packet.duration === 'number' ? packet.duration : 0);
      if (pktEnd > maxVideoEndSec) {
        maxVideoEndSec = pktEnd;
      }
      const ratio = Math.min(1, shiftedTs / expectedSpan);
      emitProgress(5 + ratio * (videoProgressCeiling - 5), 'copying-video');
    }

    if (jobState.cancelled) {
      await output.cancel();
      return ok({ cancelled: true });
    }

    if (videoPacketCount === 0) {
      await output.cancel();
      return fail(ERROR_CODES.E_OUTPUT_EMPTY);
    }

    if (audioSource && audioSink && audioDecoderConfig) {
      emitProgress(videoProgressCeiling, 'copying-audio', true);
      const firstAudio = await audioSink.getPacket(actualStartSec);
      if (firstAudio) {
        let audioCount = 0;
        for await (const packet of audioSink.packets(firstAudio)) {
          if (jobState.cancelled) {
            break;
          }
          if (packet.timestamp >= clip.endSec && audioCount > 0) {
            break;
          }
          const shiftedTs = Math.max(0, packet.timestamp - actualStartSec);
          const shifted = packet.clone({ timestamp: shiftedTs });
          if (audioCount === 0) {
            await audioSource.add(shifted, { decoderConfig: audioDecoderConfig });
          } else {
            await audioSource.add(shifted);
          }
          audioCount += 1;
          const ratio = Math.min(1, shiftedTs / expectedSpan);
          emitProgress(videoProgressCeiling + ratio * (94 - videoProgressCeiling), 'copying-audio');
        }
      }
    }

    if (jobState.cancelled) {
      await output.cancel();
      return ok({ cancelled: true });
    }

    emitProgress(96, 'finalizing', true);
    if (typeof videoSource.close === 'function') {
      await videoSource.close();
    }
    if (audioSource && typeof audioSource.close === 'function') {
      await audioSource.close();
    }
    await output.finalize();

    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      return fail(ERROR_CODES.E_OUTPUT_EMPTY);
    }

    const mime = settings.format === 'mp4' ? 'video/mp4' : 'video/webm';
    const blob = new Blob([buffer], { type: mime });
    return ok({
      cancelled: false,
      blob,
      mime,
      durationSec: round3(Math.max(maxVideoEndSec, clip.endSec - actualStartSec)),
      bytes: blob.size
    });
  } catch (err) {
    if (output && typeof output.cancel === 'function') {
      try {
        await output.cancel();
      } catch {
        /* Ignore cancel errors during cleanup. */
      }
    }
    if (jobState.cancelled) {
      return ok({ cancelled: true });
    }
    const detail = err instanceof Error ? err.message : String(err || '');
    return fail(
      ERROR_CODES.E_EXPORT_FAILED,
      detail ? `Fast mode copy failed: ${detail}` : 'Fast mode packet copy failed.',
      'Switch to Precise mode to re-encode this clip reliably.'
    );
  } finally {
    jobState.output = null;
    if (input && typeof input.dispose === 'function') {
      try {
        input.dispose();
      } catch {
        /* Ignore input dispose errors. */
      }
    }
  }
}

async function handleStartMessage(msg) {
  const validRes = validateWorkerStartMessage(msg);
  if (!validRes.ok) {
    postWorkerMessage({
      type: 'error',
      jobId: msg && typeof msg.jobId === 'string' ? msg.jobId : 'unknown',
      code: validRes.error.code,
      message: validRes.error.message,
      hint: validRes.error.hint
    });
    return;
  }

  const parsed = validRes.value;
  const { jobId, settings } = parsed;
  const jobState = {
    jobId,
    cancelled: false,
    conversion: null,
    output: null
  };
  activeJob = jobState;

  const emitProgress = createProgressEmitter(jobId);
  emitProgress(0, 'loading-engine', true);

  try {
    const mbRes = await loadMediabunny();
    if (jobState.cancelled) {
      postWorkerMessage({ type: 'cancelled', jobId });
      return;
    }
    if (!mbRes.ok) {
      postWorkerMessage({
        type: 'error',
        jobId,
        code: mbRes.error.code,
        message: mbRes.error.message,
        hint: mbRes.error.hint
      });
      return;
    }

    const result = settings.mode === 'fast'
      ? await runFastPipeline(mbRes.value, jobState, parsed, emitProgress)
      : await runPrecisePipeline(mbRes.value, jobState, parsed, emitProgress);

    if (!result.ok) {
      postWorkerMessage({
        type: 'error',
        jobId,
        code: result.error.code,
        message: result.error.message,
        hint: result.error.hint
      });
      return;
    }

    if (result.value.cancelled || jobState.cancelled) {
      postWorkerMessage({ type: 'cancelled', jobId });
      return;
    }

    emitProgress(100, 'done', true);
    postWorkerMessage({
      type: 'done',
      jobId,
      blob: result.value.blob,
      mime: result.value.mime,
      durationSec: result.value.durationSec,
      bytes: result.value.bytes
    });
  } catch (err) {
    if (jobState.cancelled) {
      postWorkerMessage({ type: 'cancelled', jobId });
    } else {
      const appErr = createAppError(
        ERROR_CODES.E_EXPORT_FAILED,
        err instanceof Error ? err.message : String(err || 'Unexpected worker error.')
      );
      postWorkerMessage({
        type: 'error',
        jobId,
        code: appErr.code,
        message: appErr.message,
        hint: appErr.hint
      });
    }
  } finally {
    if (activeJob === jobState) {
      activeJob = null;
    }
  }
}

async function handleCancelMessage(msg) {
  if (!activeJob) {
    return;
  }
  if (msg && msg.jobId && msg.jobId !== activeJob.jobId) {
    return;
  }
  activeJob.cancelled = true;
  if (activeJob.conversion && typeof activeJob.conversion.cancel === 'function') {
    try {
      await activeJob.conversion.cancel();
    } catch {
      /* Ignore cancellation race errors. */
    }
  }
  if (activeJob.output && typeof activeJob.output.cancel === 'function') {
    try {
      await activeJob.output.cancel();
    } catch {
      /* Ignore cancellation race errors. */
    }
  }
}

const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope;

if (isWorkerScope) {
  self.addEventListener('message', (event) => {
    const data = event ? event.data : null;
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.type === 'start') {
      handleStartMessage(data);
    } else if (data.type === 'cancel') {
      handleCancelMessage(data);
    }
  });
}
