/* Stage 4/8 UI module: accessible modal info and confirmation dialogs with focus restoration. */

import { ERROR_CODES, fail, ok } from '../errors.js';

let dialogEl = null;
let initialized = false;
let lastFocusedEl = null;
let pendingResolve = null;

function clearChildren(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function restoreFocus() {
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    try {
      lastFocusedEl.focus();
    } catch {
      /* Ignore focus restoration failures if element was removed. */
    }
  }
  lastFocusedEl = null;
}

function settlePending(confirmed) {
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(ok(confirmed));
  }
}

export function closeActiveDialog(confirmed = false) {
  if (!dialogEl) {
    settlePending(confirmed);
    return ok(true);
  }
  if (dialogEl.open) {
    if (typeof dialogEl.close === 'function') {
      dialogEl.close();
    } else {
      dialogEl.removeAttribute('open');
    }
  }
  clearChildren(dialogEl);
  restoreFocus();
  settlePending(confirmed);
  return ok(true);
}

function showDialogElement() {
  if (!dialogEl) {
    return;
  }
  lastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof dialogEl.showModal === 'function') {
    dialogEl.showModal();
  } else {
    dialogEl.setAttribute('open', '');
  }
}

export function openInfoDialog({ title, lead = '', items = [], closeLabel = 'Close' }) {
  if (!dialogEl) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Dialog host element is not initialized.');
  }
  closeActiveDialog(false);

  const shell = document.createElement('div');
  shell.className = 'studio-dialog__content';

  const header = document.createElement('div');
  header.className = 'studio-dialog__header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'studio-dialog__title';
  titleEl.id = 'status-dialog-title';
  titleEl.textContent = title || 'Information';

  const closeTopBtn = document.createElement('button');
  closeTopBtn.type = 'button';
  closeTopBtn.className = 'btn btn--ghost btn--compact';
  closeTopBtn.setAttribute('aria-label', 'Close dialog');
  closeTopBtn.textContent = '×';
  closeTopBtn.addEventListener('click', () => closeActiveDialog(false));

  header.appendChild(titleEl);
  header.appendChild(closeTopBtn);
  shell.appendChild(header);

  if (lead) {
    const leadEl = document.createElement('p');
    leadEl.className = 'muted-text';
    leadEl.textContent = lead;
    shell.appendChild(leadEl);
  }

  if (Array.isArray(items) && items.length > 0) {
    const list = document.createElement('dl');
    list.className = 'shortcut-list';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'shortcut-list__row';

      const dt = document.createElement('dt');
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd-badge';
      kbd.textContent = item.keys;
      dt.appendChild(kbd);

      const dd = document.createElement('dd');
      dd.className = 'shortcut-list__desc';
      dd.textContent = item.description;

      row.appendChild(dt);
      row.appendChild(dd);
      list.appendChild(row);
    }
    shell.appendChild(list);
  }

  const footer = document.createElement('div');
  footer.className = 'studio-dialog__actions';

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn btn--primary';
  doneBtn.textContent = closeLabel;
  doneBtn.addEventListener('click', () => closeActiveDialog(true));

  footer.appendChild(doneBtn);
  shell.appendChild(footer);

  dialogEl.setAttribute('aria-labelledby', 'status-dialog-title');
  dialogEl.appendChild(shell);
  showDialogElement();
  doneBtn.focus();
  return ok(true);
}

export function openConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel'
}) {
  if (!dialogEl) {
    return Promise.resolve(fail(ERROR_CODES.E_EXPORT_FAILED, 'Dialog host element is not initialized.'));
  }
  closeActiveDialog(false);

  return new Promise((resolve) => {
    pendingResolve = resolve;

    const shell = document.createElement('div');
    shell.className = 'studio-dialog__content';

    const header = document.createElement('div');
    header.className = 'studio-dialog__header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'studio-dialog__title';
    titleEl.id = 'status-dialog-title';
    titleEl.textContent = title || 'Please confirm';
    header.appendChild(titleEl);
    shell.appendChild(header);

    const bodyEl = document.createElement('p');
    bodyEl.className = 'studio-dialog__message';
    bodyEl.textContent = message || '';
    shell.appendChild(bodyEl);

    const footer = document.createElement('div');
    footer.className = 'studio-dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn--secondary';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.addEventListener('click', () => closeActiveDialog(false));

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn--primary';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => closeActiveDialog(true));

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    shell.appendChild(footer);

    dialogEl.setAttribute('aria-labelledby', 'status-dialog-title');
    dialogEl.appendChild(shell);
    showDialogElement();
    confirmBtn.focus();
  });
}

export function initDialogs(refs) {
  if (!refs || !refs.dialogEl) {
    return fail(ERROR_CODES.E_EXPORT_FAILED, 'Missing dialog element.');
  }
  if (initialized) {
    return ok(true);
  }
  initialized = true;
  dialogEl = refs.dialogEl;

  dialogEl.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeActiveDialog(false);
  });

  dialogEl.addEventListener('click', (event) => {
    if (event.target === dialogEl) {
      closeActiveDialog(false);
    }
  });

  return ok(true);
}
