/* Stage 7 module: store-only streaming ZIP writer with IEEE 802.3 CRC-32 and 4 GB safety guard. */

import { ERROR_CODES, fail, normalizeError, ok } from './errors.js';
import { downloadBlob, sanitizeCustomFilename } from './download.js';

export const ZIP_STAGE = 7;
export const ZIP_MAX_BYTES = 4_000_000_000;
export const ZIP_MAX_ENTRIES = 65535;
export const ZIP_CRC_CHUNK_BYTES = 2 * 1024 * 1024;

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_VERSION_STORE = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_UINT32_LIMIT = 0xFFFFFFFF;

let crc32Table = null;
const utf8Encoder = new TextEncoder();

function getCrc32Table() {
  if (crc32Table) {
    return crc32Table;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  crc32Table = table;
  return table;
}

export function updateCrc32(currentCrc, bytes) {
  const table = getCrc32Table();
  let crc = currentCrc >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

export function computeCrc32Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return fail(ERROR_CODES.E_ZIP_FAILED, 'CRC-32 input must be a Uint8Array.');
  }
  const finalCrc = (updateCrc32(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0;
  return ok(finalCrc);
}

export async function computeBlobCrc32(blob, options = {}) {
  if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') {
    return fail(ERROR_CODES.E_ZIP_FAILED, 'A valid Blob is required to compute CRC-32.');
  }
  const chunkBytes = typeof options.chunkBytes === 'number' && options.chunkBytes > 0
    ? options.chunkBytes
    : ZIP_CRC_CHUNK_BYTES;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;

  let crc = 0xFFFFFFFF;
  let offset = 0;

  try {
    while (offset < blob.size) {
      if (shouldCancel && shouldCancel()) {
        return fail(ERROR_CODES.E_CANCELLED);
      }
      const end = Math.min(blob.size, offset + chunkBytes);
      const buffer = await blob.slice(offset, end).arrayBuffer();
      crc = updateCrc32(crc, new Uint8Array(buffer));
      offset = end;
      if (onChunk) {
        onChunk(offset, blob.size);
      }
    }
    return ok((crc ^ 0xFFFFFFFF) >>> 0);
  } catch (err) {
    return fail(ERROR_CODES.E_ZIP_FAILED, normalizeError(err, ERROR_CODES.E_ZIP_FAILED).message);
  }
}

export function encodeDosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);

  const dosTime = ((hours & 0x1F) << 11) | ((minutes & 0x3F) << 5) | (seconds & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | ((month & 0x0F) << 5) | (day & 0x1F);
  return { dosTime, dosDate };
}

function buildLocalFileHeader(nameBytes, crc32, sizeBytes, dosTime, dosDate) {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_LOCAL_HEADER_SIG, true);
  view.setUint16(4, ZIP_VERSION_STORE, true);
  view.setUint16(6, ZIP_UTF8_FLAG, true);
  view.setUint16(8, ZIP_METHOD_STORE, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc32 >>> 0, true);
  view.setUint32(18, sizeBytes >>> 0, true);
  view.setUint32(22, sizeBytes >>> 0, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function buildCentralDirectoryHeader(nameBytes, crc32, sizeBytes, localHeaderOffset, dosTime, dosDate) {
  const header = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_CENTRAL_HEADER_SIG, true);
  view.setUint16(4, ZIP_VERSION_STORE, true);
  view.setUint16(6, ZIP_VERSION_STORE, true);
  view.setUint16(8, ZIP_UTF8_FLAG, true);
  view.setUint16(10, ZIP_METHOD_STORE, true);
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc32 >>> 0, true);
  view.setUint32(20, sizeBytes >>> 0, true);
  view.setUint32(24, sizeBytes >>> 0, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localHeaderOffset >>> 0, true);
  header.set(nameBytes, 46);
  return header;
}

function buildEndOfCentralDirectory(entryCount, centralDirSize, centralDirOffset) {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, ZIP_EOCD_SIG, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirSize >>> 0, true);
  view.setUint32(16, centralDirOffset >>> 0, true);
  view.setUint16(20, 0, true);
  return eocd;
}

function normalizeZipEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return fail(ERROR_CODES.E_ZIP_FAILED, 'At least one finished clip is required to create a ZIP archive.');
  }
  if (entries.length > ZIP_MAX_ENTRIES) {
    return fail(
      ERROR_CODES.E_ZIP_TOO_LARGE,
      `Standard ZIP supports at most ${ZIP_MAX_ENTRIES} files in one archive.`
    );
  }

  const usedNames = new Set();
  const normalized = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || !entry.blob || typeof entry.blob.size !== 'number' || entry.blob.size <= 0) {
      return fail(ERROR_CODES.E_OUTPUT_EMPTY, `ZIP entry #${i + 1} is missing or empty.`);
    }
    const rawName = typeof entry.filename === 'string' && entry.filename.trim()
      ? entry.filename.trim()
      : `clip_${i + 1}.mp4`;
    const ext = rawName.toLowerCase().endsWith('.webm') ? 'webm' : 'mp4';
    const safeNameRes = sanitizeCustomFilename(rawName, ext, usedNames);
    if (!safeNameRes.ok) {
      return fail(ERROR_CODES.E_ZIP_FAILED, safeNameRes.error.message);
    }
    const filename = safeNameRes.value;
    usedNames.add(filename.toLowerCase());
    const nameBytes = utf8Encoder.encode(filename);
    normalized.push({
      filename,
      nameBytes,
      blob: entry.blob,
      size: entry.blob.size
    });
  }

  return ok(normalized);
}

export function estimateZipTotalBytes(entries) {
  const normRes = normalizeZipEntries(entries);
  if (!normRes.ok) {
    return normRes;
  }
  const normalized = normRes.value;
  let localSectionBytes = 0;
  let centralDirBytes = 0;
  let payloadBytes = 0;

  for (const item of normalized) {
    if (item.size > ZIP_MAX_BYTES || item.size > ZIP_UINT32_LIMIT) {
      return fail(ERROR_CODES.E_ZIP_TOO_LARGE);
    }
    payloadBytes += item.size;
    localSectionBytes += 30 + item.nameBytes.length + item.size;
    centralDirBytes += 46 + item.nameBytes.length;
  }

  const totalBytes = localSectionBytes + centralDirBytes + 22;
  if (totalBytes > ZIP_MAX_BYTES || totalBytes > ZIP_UINT32_LIMIT) {
    return fail(ERROR_CODES.E_ZIP_TOO_LARGE);
  }

  return ok({
    totalBytes,
    payloadBytes,
    centralDirOffset: localSectionBytes,
    centralDirBytes,
    entryCount: normalized.length,
    normalized
  });
}

export async function buildZipArchive(entries, options = {}) {
  const estRes = estimateZipTotalBytes(entries);
  if (!estRes.ok) {
    return estRes;
  }
  const { normalized, totalBytes, payloadBytes } = estRes.value;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const { dosTime, dosDate } = encodeDosDateTime(options.date);

  const parts = [];
  const centralHeaders = [];
  const entriesMeta = [];
  let offset = 0;
  let processedPayload = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    if (shouldCancel && shouldCancel()) {
      return fail(ERROR_CODES.E_CANCELLED);
    }
    const item = normalized[i];
    const baseDone = processedPayload;

    const crcRes = await computeBlobCrc32(item.blob, {
      shouldCancel,
      onChunk: (doneBytes) => {
        if (onProgress && payloadBytes > 0) {
          const pct = Math.min(99, Math.round(((baseDone + doneBytes) / payloadBytes) * 100));
          onProgress({ pct, phase: `Checksumming ${item.filename} (${i + 1}/${normalized.length})` });
        }
      }
    });
    if (!crcRes.ok) {
      return crcRes;
    }

    const crc32 = crcRes.value;
    const localHeader = buildLocalFileHeader(item.nameBytes, crc32, item.size, dosTime, dosDate);
    const centralHeader = buildCentralDirectoryHeader(item.nameBytes, crc32, item.size, offset, dosTime, dosDate);

    /* Keep original clip Blobs directly in Blob parts without copying all clips into one ArrayBuffer. */
    parts.push(localHeader, item.blob);
    centralHeaders.push(centralHeader);
    entriesMeta.push({
      filename: item.filename,
      size: item.size,
      crc32,
      localHeaderOffset: offset
    });

    offset += localHeader.byteLength + item.size;
    processedPayload += item.size;
  }

  let centralDirBytes = 0;
  for (const ch of centralHeaders) {
    parts.push(ch);
    centralDirBytes += ch.byteLength;
  }

  const eocd = buildEndOfCentralDirectory(normalized.length, centralDirBytes, offset);
  parts.push(eocd);

  if (onProgress) {
    onProgress({ pct: 100, phase: 'ZIP ready' });
  }

  const blob = new Blob(parts, { type: 'application/zip' });
  return ok({
    blob,
    totalBytes,
    entryCount: normalized.length,
    entriesMeta
  });
}

async function streamZipToWritable(writable, normalized, payloadBytes, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const { dosTime, dosDate } = encodeDosDateTime(options.date);

  const centralHeaders = [];
  let offset = 0;
  let processedWork = 0;
  const totalWork = Math.max(1, payloadBytes * 2);

  for (let i = 0; i < normalized.length; i += 1) {
    if (shouldCancel && shouldCancel()) {
      return fail(ERROR_CODES.E_CANCELLED);
    }
    const item = normalized[i];
    const crcBase = processedWork;

    const crcRes = await computeBlobCrc32(item.blob, {
      shouldCancel,
      onChunk: (doneBytes) => {
        if (onProgress) {
          const pct = Math.min(99, Math.round(((crcBase + doneBytes) / totalWork) * 100));
          onProgress({ pct, phase: `Preparing ${item.filename} (${i + 1}/${normalized.length})` });
        }
      }
    });
    if (!crcRes.ok) {
      return crcRes;
    }
    processedWork += item.size;

    const crc32 = crcRes.value;
    const localHeader = buildLocalFileHeader(item.nameBytes, crc32, item.size, dosTime, dosDate);
    const centralHeader = buildCentralDirectoryHeader(item.nameBytes, crc32, item.size, offset, dosTime, dosDate);

    await writable.write(localHeader);

    let chunkOffset = 0;
    while (chunkOffset < item.size) {
      if (shouldCancel && shouldCancel()) {
        return fail(ERROR_CODES.E_CANCELLED);
      }
      const nextEnd = Math.min(item.size, chunkOffset + ZIP_CRC_CHUNK_BYTES);
      const sliceBlob = item.blob.slice(chunkOffset, nextEnd);
      await writable.write(sliceBlob);
      chunkOffset = nextEnd;
      if (onProgress) {
        const pct = Math.min(99, Math.round(((processedWork + chunkOffset) / totalWork) * 100));
        onProgress({ pct, phase: `Writing ${item.filename} (${i + 1}/${normalized.length})` });
      }
    }

    processedWork += item.size;
    offset += localHeader.byteLength + item.size;
    centralHeaders.push(centralHeader);
  }

  let centralDirBytes = 0;
  for (const ch of centralHeaders) {
    await writable.write(ch);
    centralDirBytes += ch.byteLength;
  }

  const eocd = buildEndOfCentralDirectory(normalized.length, centralDirBytes, offset);
  await writable.write(eocd);

  if (onProgress) {
    onProgress({ pct: 100, phase: 'ZIP saved' });
  }

  return ok(true);
}

export async function saveZipArchive(entries, zipFilename, options = {}) {
  const estRes = estimateZipTotalBytes(entries);
  if (!estRes.ok) {
    return estRes;
  }
  const { normalized, totalBytes, payloadBytes, entryCount } = estRes.value;
  const safeZipName = typeof zipFilename === 'string' && zipFilename.trim()
    ? zipFilename.trim()
    : 'heiwa_clips.zip';

  const canStreamSave = typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  if (canStreamSave && options.preferBlobFallback !== true) {
    let fileHandle = null;
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: safeZipName,
        types: [
          {
            description: 'ZIP Archive',
            accept: { 'application/zip': ['.zip'] }
          }
        ]
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return fail(ERROR_CODES.E_CANCELLED);
      }
      /* Fall back to Blob ZIP download if picker is blocked by browser policy. */
      fileHandle = null;
    }

    if (fileHandle && typeof fileHandle.createWritable === 'function') {
      let writable = null;
      try {
        writable = await fileHandle.createWritable();
        const streamRes = await streamZipToWritable(writable, normalized, payloadBytes, options);
        if (!streamRes.ok) {
          try {
            await writable.abort();
          } catch {
            /* Ignore abort cleanup error. */
          }
          return streamRes;
        }
        await writable.close();
        return ok({
          filename: safeZipName,
          method: 'stream',
          totalBytes,
          entryCount
        });
      } catch (err) {
        if (writable) {
          try {
            await writable.abort();
          } catch {
            /* Ignore abort cleanup error. */
          }
        }
        const normalizedErr = normalizeError(err, ERROR_CODES.E_ZIP_FAILED);
        return fail(normalizedErr.code, normalizedErr.message, normalizedErr.hint);
      }
    }
  }

  const built = await buildZipArchive(entries, options);
  if (!built.ok) {
    return built;
  }
  const dlRes = downloadBlob(built.value.blob, safeZipName);
  if (!dlRes.ok) {
    return dlRes;
  }
  return ok({
    filename: safeZipName,
    method: 'blob',
    totalBytes,
    entryCount
  });
}
