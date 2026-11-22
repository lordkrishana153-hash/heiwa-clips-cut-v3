# Test Report

Honest Stage 10 verification record for **Heiwa Clips Cut** (plain HTML, CSS, and JavaScript ES modules — 40 project files under `heiwa-clips-cut/`).

---

## 1. Automated Verification Executed (PASS)

All checks below were executed directly against the final files on disk in Node.js v22 and Python 3:

1. **JavaScript Syntax Verification (`node --check`)** — **PASS**
   - Checked all **22** JavaScript files (`js/*.js`, `js/ui/*.js`, `sw.js`).
   - Result: `SYNTAX_OK JS_FILES=22` (0 syntax errors).
2. **Unit Test Suite (`tests/tests.html` executed under Node ESM + in-memory IndexedDB harness)** — **PASS**
   - Executed all **39** unit tests covering Stages 1–9 (`time.js`, `store.js`, `errors.js`, `metadata.js`, `media-input.js`, `clips.js`, `timeline.js`, `shortcuts.js`, `ui/layout.js`, `crop.js`, `export-worker.js`, `export-queue.js`, `download.js`, `zip.js`, `storage.js`, `pwa.js`).
   - Result: **`39 passed, 0 failed`**.
3. **ZIP Binary Interoperability (`js/zip.js` -> Python `zipfile.ZipFile`)** — **PASS**
   - Built a multi-entry store-only ZIP archive with UTF-8 filenames (`clip_01_日本語.mp4`, `clip_02_hello.mp4`) and binary payloads using `buildZipArchive()`.
   - Verified `zf.testzip() is None`, exact UTF-8 filenames, and byte-for-byte payload integrity in Python's standard library `zipfile.ZipFile`.
   - Result: `PY_ZIP_INTEROP_OK`.
4. **Static Codebase, DOM Registry & PWA Integrity Audit** — **PASS**
   - **Total project files**: `40` (zero temporary or extraneous files).
   - **DOM ID Registry (`index.html`)**: `145` unique `id` attributes; `0` unregistered; `0` duplicates; `0` JS `getElementById` references missing from HTML.
   - **Buttons & Wiring**: `66` interactive buttons; `0` unwired or placeholder buttons.
   - **Code Hygiene**: `0` `console.log` calls; `0` `.innerHTML` / `outerHTML` / `insertAdjacentHTML` usages; `0` missing relative ES module imports; `0` undefined CSS custom properties.
   - **Service Worker Precache (`sw.js`)**: All `32` `APP_SHELL_URLS` exist on disk (`MISSING_SW=[]`).
   - **Manifest, Asset Links & Icons**: `manifest.webmanifest` and `.well-known/assetlinks.json` parse cleanly as valid JSON; `icons/icon-192.png` (`192x192`), `icons/icon-512.png` (`512x512`), and `icons/icon-maskable-512.png` (`512x512`) are valid PNG images.
5. **Resource Lifecycle Audit (`grep`)** — **PASS**
   - Verified matching `URL.revokeObjectURL` cleanup for every `URL.createObjectURL` in `media-input.js`, `download.js`, `zip.js`, and `export-queue.js`.
   - Verified `input.dispose()` in `finally` blocks in `metadata.js` and `export-worker.js`.
   - Verified `stageCanvas`/`outCanvas` dimensions zeroed in `finally` inside `export-worker.js`, `worker.terminate()` on cancel/error in `export-queue.js`, `writable.abort()`/`close()` in `zip.js`, and `cachedDb.close()` in `storage.js`.

---

## 2. Live Browser & Device Checks NOT Executed Here (Requires User Sign-Off)

This build environment has no live graphical browser, GPU/WebCodecs runtime, or physical mobile device. The following real-world tests from `docs/TEST-PLAN.md` have **not** been executed here and must be run by the user before production release:

1. **Browser Test Runner**: Open `http://localhost:8080/tests/tests.html` in Chrome/Edge/Safari and verify `39 passed, 0 failed` against real browser IndexedDB and Blob APIs.
2. **Real Video Decode & WebCodecs Export**:
   - Load real MP4 (H.264/AAC), WebM (VP9/Opus), silent, and VFR phone videos; verify `metadata.js` Mediabunny `1.62.0` inspection and `<video>` preview playback/scrubbing.
   - Export in **Precise** mode (MP4 H.264/AAC and WebM VP9/Opus) with and without `9:16` Fill/Fit/Blur crop; confirm output playback and duration in an external player (VLC, Windows Media Player, QuickTime, Android Gallery).
   - Export in **Fast (Keyframe Copy)** mode and confirm speed and keyframe start behavior.
3. **Downloads, ZIP & Save Picker**:
   - Verify individual **Download**, paced **Download All** (including browser "Automatic downloads" prompt), and **Download ZIP** (native `showSaveFilePicker` on desktop Chromium and Blob fallback on mobile/Firefox/Safari), plus OS archive extraction.
4. **Live IndexedDB Autosave, Reload Recovery & Quota**:
   - Create clips, reload the browser tab, test both mismatch rejection and exact-file re-attachment, verify `navigator.storage.persist()` and quota readout, and test Private/Incognito fallback.
5. **Service Worker Offline Mode, Install & Controlled Update**:
   - Visit once online, toggle DevTools **Offline**, reload, and complete a full local video clip export offline.
   - Test **Install App** on desktop/Android Chrome and the **Add to Home Screen** guide on iPad/iPhone Safari.
   - Bump `CACHE_VERSION` in `sw.js` to verify the **Reload to Update** banner (including blocking reload mid-export).
6. **Responsive Layout, Touch & Accessibility**:
   - Inspect `320px` (portrait phone), `768px` (tablet), and `1280px` (desktop) viewports for zero horizontal overflow and `>= 44px` touch targets; test two-finger pinch-zoom on a touchscreen.
   - Test keyboard-only navigation (`Tab` from **Skip to workspace** through all panels and `?` Shortcuts dialog), light/dark theme contrast, and `prefers-reduced-motion: reduce`.
7. **Android TWA Packaging**:
   - Deploy over HTTPS, populate `.well-known/assetlinks.json` with your real package name and SHA-256 fingerprint(s), package with Bubblewrap or PWABuilder (`docs/TWA.md`), and confirm full-screen launch without a Chrome URL bar on an Android device.
