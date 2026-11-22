/* Runtime browser feature detection with real WebCodecs isConfigSupported probes. */

import { ok } from './errors.js';

const H264_PROFILES = ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f'];
const VP9_PROFILE = 'vp09.00.10.08';
const AAC_CODEC = 'mp4a.40.2';
const OPUS_CODEC = 'opus';

export function createDefaultCapabilities() {
  return {
    webcodecs: false,
    videoEncode: { h264: false, vp9: false },
    audioEncode: { aac: false, opus: false },
    worker: false,
    indexedDb: false,
    fileSystemAccess: false,
    opfs: false,
    persist: false
  };
}

export async function probeVideoEncoder(codec, width = 640, height = 360) {
  if (
    typeof VideoEncoder !== 'function' ||
    typeof VideoEncoder.isConfigSupported !== 'function'
  ) {
    return ok(false);
  }
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate: 1_000_000,
      framerate: 30
    });
    return ok(Boolean(result && result.supported));
  } catch {
    return ok(false);
  }
}

export async function probeAudioEncoder(codec) {
  if (
    typeof AudioEncoder !== 'function' ||
    typeof AudioEncoder.isConfigSupported !== 'function'
  ) {
    return ok(false);
  }
  try {
    const result = await AudioEncoder.isConfigSupported({
      codec,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000
    });
    return ok(Boolean(result && result.supported));
  } catch {
    return ok(false);
  }
}

async function probeH264() {
  for (const codec of H264_PROFILES) {
    const res = await probeVideoEncoder(codec, 640, 360);
    if (res.ok && res.value) {
      return true;
    }
  }
  return false;
}

export async function detectCapabilities() {
  const caps = createDefaultCapabilities();

  caps.webcodecs =
    typeof VideoDecoder === 'function' &&
    typeof VideoEncoder === 'function' &&
    typeof AudioDecoder === 'function' &&
    typeof AudioEncoder === 'function';

  caps.worker = typeof Worker === 'function';
  caps.indexedDb = typeof indexedDB !== 'undefined' && indexedDB !== null;
  caps.fileSystemAccess =
    typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  caps.opfs =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage && typeof navigator.storage.getDirectory === 'function');
  caps.persist =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage && typeof navigator.storage.persist === 'function');

  if (caps.webcodecs) {
    const [h264, vp9Res, aacRes, opusRes] = await Promise.all([
      probeH264(),
      probeVideoEncoder(VP9_PROFILE, 640, 360),
      probeAudioEncoder(AAC_CODEC),
      probeAudioEncoder(OPUS_CODEC)
    ]);

    caps.videoEncode = {
      h264,
      vp9: vp9Res.ok && vp9Res.value
    };
    caps.audioEncode = {
      aac: aacRes.ok && aacRes.value,
      opus: opusRes.ok && opusRes.value
    };
  }

  return ok(caps);
}

export function describeCapabilities(caps) {
  const mp4Ready = Boolean(caps.webcodecs && caps.videoEncode.h264 && caps.audioEncode.aac);
  const webmReady = Boolean(caps.webcodecs && caps.videoEncode.vp9 && caps.audioEncode.opus);

  const items = [
    {
      label: 'WebCodecs',
      status: caps.webcodecs ? 'ok' : 'error',
      shortText: caps.webcodecs ? 'WebCodecs: Ready' : 'WebCodecs: Unavailable',
      detail: caps.webcodecs
        ? 'Hardware/browser video & audio codecs detected.'
        : 'Required for local clip processing. Use Chrome, Edge, or Chromium.'
    },
    {
      label: 'MP4 Encode (H.264 + AAC)',
      status: mp4Ready ? 'ok' : caps.videoEncode.h264 ? 'warn' : 'error',
      shortText: mp4Ready
        ? 'MP4 (H.264/AAC): Yes'
        : `H.264:${caps.videoEncode.h264 ? 'Yes' : 'No'} AAC:${caps.audioEncode.aac ? 'Yes' : 'No'}`,
      detail: mp4Ready
        ? 'Both H.264 video and AAC audio encoding passed isConfigSupported.'
        : 'One or both MP4 encoders are unavailable; WebM fallback may be needed.'
    },
    {
      label: 'WebM Encode (VP9 + Opus)',
      status: webmReady ? 'ok' : caps.videoEncode.vp9 ? 'warn' : 'error',
      shortText: webmReady
        ? 'WebM (VP9/Opus): Yes'
        : `VP9:${caps.videoEncode.vp9 ? 'Yes' : 'No'} Opus:${caps.audioEncode.opus ? 'Yes' : 'No'}`,
      detail: webmReady
        ? 'Both VP9 video and Opus audio encoding passed isConfigSupported.'
        : 'WebM encoding is partially or fully unsupported in this browser.'
    },
    {
      label: 'Web Workers',
      status: caps.worker ? 'ok' : 'error',
      shortText: caps.worker ? 'Workers: Yes' : 'Workers: No',
      detail: caps.worker
        ? 'Background module workers can keep the UI responsive during export.'
        : 'Web Workers are unavailable in this environment.'
    },
    {
      label: 'IndexedDB Autosave',
      status: caps.indexedDb ? 'ok' : 'warn',
      shortText: caps.indexedDb ? 'IndexedDB: Yes' : 'IndexedDB: No',
      detail: caps.indexedDb
        ? 'Project clips and settings can autosave locally.'
        : 'Storage unavailable; session will work without crash recovery.'
    },
    {
      label: 'File Save & Storage',
      status: caps.fileSystemAccess || caps.opfs ? 'ok' : 'warn',
      shortText: `SavePicker:${caps.fileSystemAccess ? 'Yes' : 'No'} OPFS:${caps.opfs ? 'Yes' : 'No'} Persist:${caps.persist ? 'Yes' : 'No'}`,
      detail: caps.fileSystemAccess
        ? 'Direct file streaming via File System Access API is available.'
        : 'Standard browser download fallback will be used.'
    }
  ];

  return ok(items);
}
