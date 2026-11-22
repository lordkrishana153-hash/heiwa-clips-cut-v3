/* Timestamp parsing, HH:MM:SS.mmm formatting, and numeric clamping. */

import { ERROR_CODES, fail, ok } from './errors.js';

const UNSIGNED_INT_RE = /^\d+$/;
const UNSIGNED_DECIMAL_RE = /^\d+(\.\d+)?$/;
const ALLOWED_CHARS_RE = /^[0-9:.]+$/;

function roundMs(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

export function clamp(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Value to clamp must be a finite number.');
  }
  if (typeof min !== 'number' || !Number.isFinite(min)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Minimum bound must be a finite number.');
  }
  if (typeof max !== 'number' || !Number.isFinite(max)) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Maximum bound must be a finite number.');
  }
  if (min > max) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Minimum bound cannot exceed maximum bound.');
  }
  if (value < min) {
    return ok(min);
  }
  if (value > max) {
    return ok(max);
  }
  return ok(value);
}

export function parseTimestamp(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      return fail(ERROR_CODES.E_TIME_PARSE);
    }
    return ok(roundMs(input));
  }

  if (typeof input !== 'string') {
    return fail(ERROR_CODES.E_TIME_PARSE);
  }

  const trimmed = input.trim();
  if (!trimmed || !ALLOWED_CHARS_RE.test(trimmed)) {
    return fail(ERROR_CODES.E_TIME_PARSE);
  }

  const parts = trimmed.split(':');
  if (parts.length < 1 || parts.length > 3) {
    return fail(ERROR_CODES.E_TIME_PARSE);
  }

  let totalSeconds = 0;

  if (parts.length === 1) {
    if (!UNSIGNED_DECIMAL_RE.test(parts[0])) {
      return fail(ERROR_CODES.E_TIME_PARSE);
    }
    totalSeconds = Number(parts[0]);
  } else if (parts.length === 2) {
    if (!UNSIGNED_INT_RE.test(parts[0]) || !UNSIGNED_DECIMAL_RE.test(parts[1])) {
      return fail(ERROR_CODES.E_TIME_PARSE);
    }
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (seconds >= 60) {
      return fail(ERROR_CODES.E_TIME_PARSE, 'Seconds must be below 60 when using MM:SS format.');
    }
    totalSeconds = minutes * 60 + seconds;
  } else {
    if (
      !UNSIGNED_INT_RE.test(parts[0]) ||
      !UNSIGNED_INT_RE.test(parts[1]) ||
      !UNSIGNED_DECIMAL_RE.test(parts[2])
    ) {
      return fail(ERROR_CODES.E_TIME_PARSE);
    }
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    if (minutes >= 60 || seconds >= 60) {
      return fail(ERROR_CODES.E_TIME_PARSE, 'Minutes and seconds must be below 60 in HH:MM:SS format.');
    }
    totalSeconds = hours * 3600 + minutes * 60 + seconds;
  }

  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return fail(ERROR_CODES.E_TIME_PARSE);
  }

  return ok(roundMs(totalSeconds));
}

export function formatTimestamp(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return fail(ERROR_CODES.E_TIME_PARSE, 'Timestamp seconds must be a non-negative finite number.');
  }

  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);

  const hh = String(hrs).padStart(2, '0');
  const mm = String(min).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');

  return ok(`${hh}:${mm}:${ss}.${mmm}`);
}
