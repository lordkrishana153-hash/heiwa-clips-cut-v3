/* Stage 4 module: studio keyboard shortcuts (strictly ignored while typing in inputs, selects, textareas, or dialogs). */

import { ERROR_CODES, fail, ok } from './errors.js';

export const SHORTCUT_DEFINITIONS = Object.freeze([
  { keys: 'Space', description: 'Play or pause video preview' },
  { keys: 'Left / Right', description: 'Seek backward or forward by 1 second' },
  { keys: 'Shift + Left / Right', description: 'Seek backward or forward by 5 seconds' },
  { keys: ', / .', description: 'Step backward or forward by 1 frame' },
  { keys: 'I', description: 'Set draft clip Start marker at playhead' },
  { keys: 'O', description: 'Set draft clip End marker at playhead' },
  { keys: 'Ctrl/Cmd + Z', description: 'Undo last clip change' },
  { keys: 'Ctrl/Cmd + Shift + Z', description: 'Redo last undone clip change' },
  { keys: '?', description: 'Show keyboard shortcuts help' }
]);

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const INTERACTIVE_SPACE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

let shortcutsInitialized = false;
let activeHandlers = null;

export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const tagName = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (EDITABLE_TAGS.has(tagName)) {
    return true;
  }
  if (target.isContentEditable === true) {
    return true;
  }
  if (typeof target.getAttribute === 'function') {
    const ce = target.getAttribute('contenteditable');
    if (ce !== null && ce.toLowerCase() !== 'false') {
      return true;
    }
  }
  if (typeof target.closest === 'function') {
    if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
      return true;
    }
    if (target.closest('dialog[open], [role="dialog"]')) {
      return true;
    }
  }
  return false;
}

export function resolveShortcutAction(eventLike) {
  if (!eventLike || typeof eventLike !== 'object') {
    return null;
  }
  if (eventLike.defaultPrevented) {
    return null;
  }
  if (isEditableTarget(eventLike.target)) {
    return null;
  }

  const key = typeof eventLike.key === 'string' ? eventLike.key : '';
  const code = typeof eventLike.code === 'string' ? eventLike.code : '';
  const hasPrimaryMod = Boolean(eventLike.ctrlKey || eventLike.metaKey);
  const shiftKey = Boolean(eventLike.shiftKey);
  const altKey = Boolean(eventLike.altKey);

  if (altKey) {
    return null;
  }

  if (hasPrimaryMod) {
    const lower = key.toLowerCase();
    if (lower === 'z') {
      return shiftKey ? 'redo' : 'undo';
    }
    if (lower === 'y' && eventLike.ctrlKey && !eventLike.metaKey && !shiftKey) {
      return 'redo';
    }
    return null;
  }

  if (key === ' ' || code === 'Space') {
    const tag = eventLike.target && typeof eventLike.target.tagName === 'string'
      ? eventLike.target.tagName.toUpperCase()
      : '';
    if (INTERACTIVE_SPACE_TAGS.has(tag)) {
      return null;
    }
    return 'toggle-play';
  }

  if (key === 'ArrowLeft') {
    return shiftKey ? 'seek-back-large' : 'seek-back-small';
  }
  if (key === 'ArrowRight') {
    return shiftKey ? 'seek-forward-large' : 'seek-forward-small';
  }
  if (key === 'i' || key === 'I') {
    return 'set-start';
  }
  if (key === 'o' || key === 'O') {
    return 'set-end';
  }
  if (key === ',' && !shiftKey) {
    return 'frame-back';
  }
  if (key === '.' && !shiftKey) {
    return 'frame-forward';
  }
  if (key === '?') {
    return 'show-shortcuts';
  }

  return null;
}

function handleKeyDown(event) {
  const action = resolveShortcutAction(event);
  if (!action || !activeHandlers) {
    return;
  }
  const handler = activeHandlers[action];
  if (typeof handler !== 'function') {
    return;
  }
  event.preventDefault();
  handler(event);
}

export function initShortcuts(handlers) {
  if (!handlers || typeof handlers !== 'object') {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Shortcut handlers object is required.');
  }
  activeHandlers = handlers;
  if (shortcutsInitialized) {
    return ok(true);
  }
  shortcutsInitialized = true;
  window.addEventListener('keydown', handleKeyDown);
  return ok(true);
}
