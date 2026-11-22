/* Stage 9 module: Service Worker registration, controlled update prompt, PWA install flow, and offline status. */

import { ERROR_CODES, fail, notifyToast, ok } from './errors.js';
import { openInfoDialog } from './ui/dialogs.js';

export const SW_SCRIPT_PATH = './sw.js';
export const SW_SCOPE_PATH = './';

let pwaInitialized = false;
let pwaRefs = null;
let pwaCallbacks = {};
let deferredInstallPrompt = null;
let waitingWorker = null;
let reloadingForUpdate = false;

export function isSecurePwaContext(loc) {
  const target = loc !== undefined
    ? loc
    : (typeof window !== 'undefined' ? window.location : null);
  if (!target || typeof target.protocol !== 'string') {
    return false;
  }
  if (target.protocol === 'https:') {
    return true;
  }
  const host = typeof target.hostname === 'string' ? target.hostname.toLowerCase() : '';
  return (
    target.protocol === 'http:' &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
  );
}

export function detectDisplayMode(win, doc) {
  const w = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);
  const d = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null);
  if (d && typeof d.referrer === 'string' && d.referrer.startsWith('android-app://')) {
    return 'twa';
  }
  if (w && typeof w.matchMedia === 'function') {
    try {
      if (w.matchMedia('(display-mode: standalone)').matches) {
        return 'standalone';
      }
      if (w.matchMedia('(display-mode: window-controls-overlay)').matches) {
        return 'standalone';
      }
    } catch {
      /* Ignore matchMedia errors in restricted environments. */
    }
  }
  if (w && w.navigator && w.navigator.standalone === true) {
    return 'standalone';
  }
  return 'browser';
}

export function detectIosSafari(nav) {
  const n = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null);
  if (!n || typeof n.userAgent !== 'string') {
    return false;
  }
  const ua = n.userAgent;
  const isIosDevice = /iPad|iPhone|iPod/i.test(ua) ||
    (n.platform === 'MacIntel' && typeof n.maxTouchPoints === 'number' && n.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return isIosDevice && isSafari;
}

export function isOnlineStatus(nav) {
  const n = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null);
  if (!n || typeof n.onLine !== 'boolean') {
    return true;
  }
  return n.onLine;
}

export function validateAssetLinksPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Digital Asset Links file must be a non-empty JSON array.');
  }
  for (const item of payload) {
    if (!item || typeof item !== 'object') {
      return fail(ERROR_CODES.E_RANGE_INVALID, 'Asset Links entry must be an object.');
    }
    if (!Array.isArray(item.relation) || !item.relation.includes('delegate_permission/common.handle_all_urls')) {
      return fail(ERROR_CODES.E_RANGE_INVALID, 'Asset Links entry must include delegate_permission/common.handle_all_urls.');
    }
    const target = item.target;
    if (
      !target ||
      target.namespace !== 'android_app' ||
      typeof target.package_name !== 'string' ||
      !target.package_name.includes('.') ||
      !Array.isArray(target.sha256_cert_fingerprints) ||
      target.sha256_cert_fingerprints.length === 0
    ) {
      return fail(ERROR_CODES.E_RANGE_INVALID, 'Asset Links target must define android_app package_name and sha256_cert_fingerprints.');
    }
  }
  return ok(payload.length);
}

function renderNetworkPill() {
  if (!pwaRefs || !pwaRefs.networkPill) {
    return;
  }
  const online = isOnlineStatus();
  const displayMode = detectDisplayMode();
  if (!online) {
    pwaRefs.networkPill.textContent = 'Offline (Local Ready)';
    pwaRefs.networkPill.className = 'status-pill status-pill--waiting';
    return;
  }
  pwaRefs.networkPill.textContent = displayMode === 'twa'
    ? 'App Mode (TWA)'
    : displayMode === 'standalone'
      ? 'Installed'
      : 'Online';
  pwaRefs.networkPill.className = displayMode === 'browser'
    ? 'status-pill status-pill--ready'
    : 'status-pill status-pill--success';
}

function renderInstallButton() {
  if (!pwaRefs || !pwaRefs.installBtn) {
    return;
  }
  const displayMode = detectDisplayMode();
  if (displayMode === 'standalone' || displayMode === 'twa') {
    pwaRefs.installBtn.hidden = true;
    return;
  }
  if (deferredInstallPrompt) {
    pwaRefs.installBtn.textContent = 'Install App';
    pwaRefs.installBtn.hidden = false;
    return;
  }
  if (detectIosSafari()) {
    pwaRefs.installBtn.textContent = 'Add to Home Screen';
    pwaRefs.installBtn.hidden = false;
    return;
  }
  pwaRefs.installBtn.hidden = true;
}

function showUpdateBanner(worker) {
  waitingWorker = worker || null;
  if (pwaRefs && pwaRefs.updateBanner) {
    pwaRefs.updateBanner.hidden = !waitingWorker;
  }
}

async function handleInstallClick() {
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    renderInstallButton();
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice && choice.outcome === 'accepted') {
        notifyToast('Installing Heiwa Clips Cut', 'You can launch it directly from your desktop or home screen.', 'success', 4000);
      } else {
        notifyToast('Install dismissed', 'You can install Heiwa Clips Cut anytime from your browser menu.', 'info', 3500);
      }
    } catch {
      notifyToast('Install unavailable', 'Use your browser address bar or menu to install this app.', 'info', 3500);
    }
    return;
  }

  if (detectIosSafari()) {
    openInfoDialog({
      title: 'Add Heiwa Clips Cut to Home Screen',
      lead: 'Safari on iPad and iPhone installs web apps through the Share menu:',
      items: [
        { keys: 'Step 1', description: 'Tap the Share button in Safari\'s toolbar.' },
        { keys: 'Step 2', description: 'Scroll down and tap "Add to Home Screen".' },
        { keys: 'Step 3', description: 'Tap "Add" to launch Heiwa Clips Cut in full-screen standalone mode.' }
      ],
      closeLabel: 'Got it'
    });
  }
}

function handleApplyUpdateClick() {
  if (!waitingWorker) {
    showUpdateBanner(null);
    return;
  }
  if (typeof pwaCallbacks.isExportRunning === 'function' && pwaCallbacks.isExportRunning()) {
    notifyToast(
      'Export in progress',
      'Finish or cancel your active export before reloading for the update.',
      'warning',
      4500
    );
    return;
  }
  reloadingForUpdate = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

function trackRegistration(registration) {
  if (!registration) {
    return;
  }
  if (registration.waiting) {
    showUpdateBanner(registration.waiting);
  }
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) {
      return;
    }
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateBanner(installing);
        notifyToast('App update ready', 'Click "Reload to Update" in the banner when ready.', 'info', 5000);
      }
    });
  });
}

export async function registerAppServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return ok({ supported: false, registered: false });
  }
  if (!isSecurePwaContext()) {
    return ok({ supported: true, registered: false, reason: 'insecure-context' });
  }
  try {
    const registration = await navigator.serviceWorker.register(SW_SCRIPT_PATH, {
      scope: SW_SCOPE_PATH
    });
    trackRegistration(registration);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) {
        window.location.reload();
      }
    });

    return ok({ supported: true, registered: true, scope: registration.scope });
  } catch (err) {
    return fail(
      ERROR_CODES.E_STORAGE_UNAVAILABLE,
      `Service worker registration failed (${err instanceof Error ? err.message : 'unknown error'}).`,
      'Serve the app over HTTPS or http://localhost to enable offline caching and PWA install.'
    );
  }
}

export function initPwa(refs, callbacks = {}) {
  if (!refs) {
    return fail(ERROR_CODES.E_RANGE_INVALID, 'Missing PWA DOM element references.');
  }
  if (pwaInitialized) {
    return ok(true);
  }
  pwaInitialized = true;
  pwaRefs = refs;
  pwaCallbacks = callbacks && typeof callbacks === 'object' ? callbacks : {};

  if (refs.installBtn) {
    refs.installBtn.addEventListener('click', () => {
      handleInstallClick();
    });
  }

  if (refs.updateBtn) {
    refs.updateBtn.addEventListener('click', () => {
      handleApplyUpdateClick();
    });
  }

  if (refs.dismissBtn) {
    refs.dismissBtn.addEventListener('click', () => {
      showUpdateBanner(null);
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      renderInstallButton();
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      renderInstallButton();
      renderNetworkPill();
      notifyToast('Heiwa Clips Cut installed', 'You can now launch it like a native app and use it offline.', 'success', 4500);
    });

    window.addEventListener('online', () => {
      renderNetworkPill();
      notifyToast('Back online', 'Connection restored.', 'info', 2500);
    });

    window.addEventListener('offline', () => {
      renderNetworkPill();
      notifyToast('Offline mode active', 'Local video clipping continues offline once cached.', 'warning', 4000);
    });
  }

  renderNetworkPill();
  renderInstallButton();
  registerAppServiceWorker();

  return ok(true);
}
