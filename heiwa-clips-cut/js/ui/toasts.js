/* Non-blocking toast notification renderer using safe DOM APIs only (no innerHTML). */

const MAX_VISIBLE_TOASTS = 4;
const DEFAULT_DURATION_MS = 5500;
const VALID_VARIANTS = new Set(['info', 'success', 'warning', 'error']);

function getToastRegion() {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.getElementById('status-toast-region');
}

function announceLive(text) {
  if (typeof document === 'undefined') {
    return;
  }
  const liveEl = document.getElementById('status-live');
  if (!liveEl) {
    return;
  }
  liveEl.textContent = '';
  liveEl.textContent = text;
}

export function clearToasts() {
  const region = getToastRegion();
  if (!region) {
    return { ok: false, error: { code: 'E_TOAST_NO_DOM', message: 'Toast container is unavailable.' } };
  }
  while (region.firstChild) {
    region.removeChild(region.firstChild);
  }
  return { ok: true, value: true };
}

export function showToast(options) {
  if (!options || typeof options !== 'object') {
    return { ok: false, error: { code: 'E_TOAST_INVALID', message: 'Toast options must be an object.' } };
  }
  const title = typeof options.title === 'string' ? options.title.trim() : '';
  const hint = typeof options.hint === 'string' ? options.hint.trim() : '';
  if (!title) {
    return { ok: false, error: { code: 'E_TOAST_INVALID', message: 'Toast title is required.' } };
  }

  const region = getToastRegion();
  if (!region) {
    return { ok: false, error: { code: 'E_TOAST_NO_DOM', message: 'Toast container is unavailable.' } };
  }

  const variant = VALID_VARIANTS.has(options.variant) ? options.variant : 'info';
  const durationMs = typeof options.durationMs === 'number' && options.durationMs >= 0
    ? options.durationMs
    : DEFAULT_DURATION_MS;

  while (region.children.length >= MAX_VISIBLE_TOASTS) {
    region.removeChild(region.firstChild);
  }

  const toastEl = document.createElement('div');
  toastEl.className = `toast toast--${variant}`;
  toastEl.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  const bodyEl = document.createElement('div');
  bodyEl.className = 'toast__body';

  const titleEl = document.createElement('p');
  titleEl.className = 'toast__title';
  titleEl.textContent = title;
  bodyEl.appendChild(titleEl);

  if (hint) {
    const hintEl = document.createElement('p');
    hintEl.className = 'toast__hint';
    hintEl.textContent = hint;
    bodyEl.appendChild(hintEl);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast__close';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.textContent = '×';

  let timerId = null;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) {
      return;
    }
    dismissed = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (toastEl.parentNode === region) {
      region.removeChild(toastEl);
    }
  };

  closeBtn.addEventListener('click', dismiss, { once: true });

  toastEl.appendChild(bodyEl);
  toastEl.appendChild(closeBtn);
  region.appendChild(toastEl);

  if (durationMs > 0) {
    timerId = setTimeout(dismiss, durationMs);
  }

  announceLive(hint ? `${title}. ${hint}` : title);
  return { ok: true, value: { dismiss } };
}
