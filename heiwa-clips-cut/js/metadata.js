/* Stage 2 module: media analyzer using pinned Mediabunny 1.62.0 (BlobSource, never loads whole file). */

import { createAppError, ERROR_CODES, fail, ok } from './errors.js';

export const MEDIABUNNY_VERSION = '1.62.0';
export const MEDIABUNNY_CDN_URL = `https://cdn.jsdelivr.net/npm/mediabunny@${MEDIABUNNY_VERSION}/+esm`;

export const LONG_DURATION_WARN_SEC = 30 * 60;
export const LARGE_FILE_WARN_BYTES = 2 * 1024 * 1024 * 1024;
export const FALLBACK_FPS = 30;
const PACKET_STATS_SAMPLE_COUNT = 50;

let mediabunnyModulePromise = null;

export async function loadMediabunny(customUrl = MEDIABUNNY_CDN_URL) {
  if (mediabunnyModulePromise && customUrl === MEDIABUNNY_CDN_URL) {
    return mediabunnyModulePromise;
  }

  const loader = (async () => {
    try {
      const mod = await import(customUrl);
      if (!mod || typeof mod.Input !== 'function' || typeof mod.BlobSource !== 'function') {
        return fail(
          ERROR_CODES.E_EXPORT_FAILED,
          'Mediabunny loaded without expected Input/BlobSource exports.',
          'Check your network connection or vendor mediabunny locally as documented in docs/README.md.'
        );
      }
      return ok(mod);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(
        ERROR_CODES.E_EXPORT_FAILED,
        `Could not load media library Mediabunny ${MEDIABUNNY_VERSION} (${detail}).`,
        'Check your internet connection, disable CDN blockers for cdn.jsdelivr.net, or vendor Mediabunny locally.'
      );
    }
  })();

  if (customUrl === MEDIABUNNY_CDN_URL) {
    mediabunnyModulePromise = loader;
    const result = await loader;
    if (!result.ok) {
      mediabunnyModulePromise = null;
    }
    return result;
  }
  return loader;
}

export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'File size must be a non-negative finite number.');
  }
  if (bytes < 1024) {
    return ok(`${bytes} B`);
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return ok(`${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`);
}

export function detectPhoneDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
  const smallViewport = typeof window.innerWidth === 'number' && window.innerWidth <= 767;
  const mobileUa = /Android.+Mobile|iPhone|iPod/i.test(navigator.userAgent || '');
  return mobileUa || (coarsePointer && smallViewport);
}

export function validateMetadataValues({ durationSec, width, height }) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fail(
      ERROR_CODES.E_METADATA_INVALID,
      'Video duration is missing, zero, NaN, or Infinity.'
    );
  }
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return fail(
      ERROR_CODES.E_METADATA_INVALID,
      'Video frame width or height is invalid.'
    );
  }
  return ok({
    durationSec,
    width: Math.round(width),
    height: Math.round(height)
  });
}

export function evaluateCompatibility({ canDecodeVideo, canDecodeAudio, audioCodec, capabilities }) {
  const caps = capabilities || {
    webcodecs: false,
    videoEncode: { h264: false, vp9: false },
    audioEncode: { aac: false, opus: false }
  };

  const hasAudio = audioCodec !== null && audioCodec !== undefined;
  const canDecode = Boolean(canDecodeVideo && (!hasAudio || canDecodeAudio));
  const canEncodeMp4 = Boolean(
    caps.webcodecs &&
    caps.videoEncode &&
    caps.videoEncode.h264 &&
    (!hasAudio || (caps.audioEncode && caps.audioEncode.aac))
  );
  const canEncodeWebm = Boolean(
    caps.webcodecs &&
    caps.videoEncode &&
    caps.videoEncode.vp9 &&
    (!hasAudio || (caps.audioEncode && caps.audioEncode.opus))
  );
  const canEncode = canEncodeMp4 || canEncodeWebm;

  let status = 'ok';
  let verdict = 'Ready: can decode this video and encode to MP4 or WebM.';

  if (!caps.webcodecs) {
    status = 'error';
    verdict = 'Preview only: WebCodecs is unavailable in this browser, so local export cannot run.';
  } else if (!canDecodeVideo) {
    status = 'error';
    verdict = 'Cannot decode video track with WebCodecs in this browser.';
  } else if (hasAudio && !canDecodeAudio) {
    status = 'warn';
    verdict = 'Video decodes, but the audio codec is unsupported by WebCodecs.';
  } else if (!canEncode) {
    status = 'error';
    verdict = 'Video decodes, but no supported local video/audio encoder was detected.';
  } else if (canEncodeMp4 && !canEncodeWebm) {
    status = 'ok';
    verdict = 'Ready: decodes cleanly; MP4 (H.264/AAC) encoding is available.';
  } else if (!canEncodeMp4 && canEncodeWebm) {
    status = 'warn';
    verdict = 'Ready with fallback: MP4 encoder unavailable; use WebM (VP9/Opus).';
  }

  return ok({
    canDecodeVideo: Boolean(canDecodeVideo),
    canDecodeAudio: hasAudio ? Boolean(canDecodeAudio) : true,
    canDecode,
    canEncodeMp4,
    canEncodeWebm,
    canEncode,
    status,
    verdict
  });
}

export function computeSourceWarnings(source, options = {}) {
  if (!source || typeof source !== 'object') {
    return fail(ERROR_CODES.E_METADATA_INVALID, 'Source metadata is required to compute warnings.');
  }
  const isPhone = typeof options.isPhone === 'boolean' ? options.isPhone : detectPhoneDevice();
  const warnings = [];

  if (typeof source.durationSec === 'number' && source.durationSec > LONG_DURATION_WARN_SEC) {
    const mins = Math.round(source.durationSec / 60);
    warnings.push({
      id: 'long-duration',
      message: `Long video (${mins} min). Exporting many clips or long ranges can take time and memory; keep this tab in the foreground.`
    });
  }

  if (typeof source.size === 'number' && source.size > LARGE_FILE_WARN_BYTES) {
    const sizeRes = formatFileSize(source.size);
    const label = sizeRes.ok ? sizeRes.value : '> 2 GB';
    warnings.push({
      id: 'large-file',
      message: `Large file (${label}). Source is streamed in slices, but exporting long clips or ZIP archives may hit browser memory limits.`
    });
  }

  if (isPhone) {
    warnings.push({
      id: 'phone-device',
      message: 'Phone detected: prefer 720p or 480p exports and download clips individually to stay within mobile memory limits.'
    });
  }

  return ok(warnings);
}

async function readTrackDimension(track, propName, methodName, fallback) {
  if (!track) {
    return fallback;
  }
  if (typeof track[propName] === 'number' && track[propName] > 0) {
    return track[propName];
  }
  if (typeof track[methodName] === 'function') {
    try {
      const value = await track[methodName]();
      if (typeof value === 'number' && value > 0) {
        return value;
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function classifyLibraryParseError(err) {
  const text = err instanceof Error ? err.message : String(err || '');
  const lower = text.toLowerCase();
  if (lower.includes('unsupported') || lower.includes('format') || lower.includes('unknown')) {
    return createAppError(
      ERROR_CODES.E_UNSUPPORTED_CONTAINER,
      'Could not recognize a supported video container in this file.'
    );
  }
  return createAppError(
    ERROR_CODES.E_CORRUPT_FILE,
    'The file header or structure is damaged and could not be parsed.'
  );
}

export async function analyzeVideoFile(file, videoElementMeta, capabilities) {
  if (!file || typeof file.size !== 'number') {
    return fail(ERROR_CODES.E_EMPTY_FILE);
  }
  if (file.size <= 0) {
    return fail(ERROR_CODES.E_EMPTY_FILE);
  }

  const libRes = await loadMediabunny();
  if (!libRes.ok) {
    return libRes;
  }

  const { Input, BlobSource, ALL_FORMATS } = libRes.value;
  let input = null;

  try {
    input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(file)
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return fail(
        ERROR_CODES.E_UNSUPPORTED_CONTAINER,
        'No readable video track was found in this file.'
      );
    }

    const audioTrack = await input.getPrimaryAudioTrack();

    let durationSec = NaN;
    try {
      durationSec = await input.computeDuration();
    } catch {
      durationSec = videoElementMeta ? videoElementMeta.durationSec : NaN;
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      durationSec = videoElementMeta ? videoElementMeta.durationSec : NaN;
    }

    const fallbackWidth = videoElementMeta ? videoElementMeta.width : 0;
    const fallbackHeight = videoElementMeta ? videoElementMeta.height : 0;

    const width = await readTrackDimension(videoTrack, 'displayWidth', 'getDisplayWidth', fallbackWidth);
    const height = await readTrackDimension(videoTrack, 'displayHeight', 'getDisplayHeight', fallbackHeight);

    const validatedDims = validateMetadataValues({ durationSec, width, height });
    if (!validatedDims.ok) {
      return validatedDims;
    }

    let fps = FALLBACK_FPS;
    if (typeof videoTrack.computePacketStats === 'function') {
      try {
        const stats = await videoTrack.computePacketStats(PACKET_STATS_SAMPLE_COUNT);
        if (stats && typeof stats.averagePacketRate === 'number' && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0) {
          fps = Math.round(stats.averagePacketRate * 100) / 100;
        }
      } catch {
        fps = FALLBACK_FPS;
      }
    }

    let canDecodeVideo = false;
    if (typeof videoTrack.canDecode === 'function') {
      try {
        canDecodeVideo = Boolean(await videoTrack.canDecode());
      } catch {
        canDecodeVideo = false;
      }
    }

    let canDecodeAudio = true;
    if (audioTrack && typeof audioTrack.canDecode === 'function') {
      try {
        canDecodeAudio = Boolean(await audioTrack.canDecode());
      } catch {
        canDecodeAudio = false;
      }
    }

    const videoCodec = typeof videoTrack.codec === 'string' && videoTrack.codec
      ? videoTrack.codec
      : 'unknown';
    const audioCodec = audioTrack
      ? (typeof audioTrack.codec === 'string' && audioTrack.codec ? audioTrack.codec : 'unknown')
      : null;

    const source = {
      name: file.name || 'untitled-video',
      size: file.size,
      type: file.type || '',
      lastModified: typeof file.lastModified === 'number' ? file.lastModified : 0,
      durationSec: validatedDims.value.durationSec,
      width: validatedDims.value.width,
      height: validatedDims.value.height,
      fps,
      videoCodec,
      audioCodec
    };

    const compatRes = evaluateCompatibility({
      canDecodeVideo,
      canDecodeAudio,
      audioCodec,
      capabilities
    });
    const warningsRes = computeSourceWarnings(source);

    return ok({
      source,
      compatibility: compatRes.value,
      warnings: warningsRes.ok ? warningsRes.value : []
    });
  } catch (err) {
    return {
      ok: false,
      error: classifyLibraryParseError(err)
    };
  } finally {
    if (input && typeof input.dispose === 'function') {
      try {
        input.dispose();
      } catch {
        /* Ignore cleanup errors during dispose. */
      }
    }
  }
}
