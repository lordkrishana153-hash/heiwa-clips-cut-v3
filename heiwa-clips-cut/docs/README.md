# Heiwa Clips Cut

A local-only, browser-based multi-clip video clipping studio for Windows PCs, laptops, Android phones and tablets, and iPads.

Its single purpose is fast, reliable extraction of many clips from one long local video, with optional crop/reframe (`Original`, `9:16`, `16:9`, `1:1`, `4:5`), then download individually, sequentially, or as a store-only ZIP archive. No server, no uploads, no paid APIs, no analytics, no bundler, and no build step.

---

## Completed Architecture (Stages 1–10)

1. **Stage 1 — Foundation**: Static ES module architecture, central store (`js/store.js`) with 100-step clip Undo/Redo, frozen 20-code error catalog (`js/errors.js`), real WebCodecs/storage capability probes (`js/capabilities.js`), strict `HH:MM:SS.mmm` time helpers (`js/time.js`), responsive light/dark/reduced-motion CSS, and custom PNG/SVG icons.
2. **Stage 2 — Video Input & Analyzer**: Local file picker, drag-and-drop, 32-byte slice sanity check, 15-second load timeout, Mediabunny `1.62.0` metadata/codec/VFR inspection (`js/metadata.js`), compatibility verdicts, and guaranteed `URL.revokeObjectURL` cleanup (`js/media-input.js`, `js/preview.js`).
3. **Stage 3 — Core Clipping Engine**: Start/End markers, `15s`/`30s`/`60s`/Custom presets, one-tap Quick Add at Playhead, unlimited clip list (soft warning at 200 clips), inline edit with `E_TIME_PARSE`/`E_RANGE_INVALID` validation, drag-and-drop + button reorder, duplicate, delete, and bounded clip range preview (`js/clips.js`).
4. **Stage 4 — Timeline, Navigation & Responsive UI**: 1x–20x zoomable/pannable interactive timeline with touch pinch-zoom (`js/timeline.js`), frame-stepping (`-1f`/`+1f`), clip jump buttons, keyboard shortcuts ignored in text inputs/dialogs (`js/shortcuts.js`), accessible `<dialog>` system (`js/ui/dialogs.js`), and mobile/tablet/desktop grid layout (`js/ui/layout.js`).
5. **Stage 5 — Crop & Reframe**: Shared crop/aspect math with even encoder dimensions (`js/crop.js`), draggable & keyboard-nudgeable `#crop-box`, `1x–4x` zoom, Fill/Fit + pixel-probed Blur background, live framed Canvas 2D preview, per-clip persistence, and atomic Undoable Apply-to-All.
6. **Stage 6 — Export Engine & Worker**: Module Web Worker (`js/export-worker.js`) running Mediabunny `1.62.0` Precise mode (H.264/AAC MP4 or VP9/Opus WebM with worker `OffscreenCanvas` reframing) and Fast mode (keyframe-aligned encoded packet copy with honest start-offset note), plus real WebCodecs & RAM preflight (`js/export-queue.js`).
7. **Stage 7 — Sequential Queue, Verification, Downloads & ZIP**: Strict one-clip-at-a-time queue with per-job progress, output playback/duration verification before marking `done`, editable OS-safe filenames (`js/download.js`), individual & paced Download All, and pure-JS streaming store-only ZIP writer with IEEE 802.3 CRC-32 and 4 GB guard (`js/zip.js`).
8. **Stage 8 — Storage, Autosave & Recovery**: IndexedDB metadata-only autosave (500 ms debounce + `visibilitychange`/`pagehide` flush), reload recovery dialog and banner verifying filename/size/duration (`±0.5s`) before re-attaching clips, `navigator.storage.persist()` + quota readout, and clearable metadata-only export history (`js/storage.js`).
9. **Stage 9 — PWA & Android TWA**: Complete `manifest.webmanifest`, versioned Service Worker (`sw.js`) precaching all 32 app-shell assets + Mediabunny `1.62.0` for offline use, controlled `SKIP_WAITING` update prompt (blocked mid-export), Chromium install / iOS Safari Add-to-Home-Screen guide (`js/pwa.js`), `.well-known/assetlinks.json`, and `docs/TWA.md`.
10. **Stage 10 — QA, Hardening & Documentation**: Skip-to-workspace keyboard link, 100% DOM ID registry audit, zero `console.log`/`innerHTML`/unwired buttons, full Node ESM + ZIP interop verification, and final deployment/testing docs.

---

## Running Locally

Serve `heiwa-clips-cut/` over `http://localhost` (required for ES modules, WebCodecs, module Web Workers, and Service Worker):

```bash
python3 -m http.server 8080 --directory heiwa-clips-cut
```

- Studio: `http://localhost:8080/`
- Browser unit test runner (39 tests): `http://localhost:8080/tests/tests.html`

---

## Media Library (Pinned Mediabunny `1.62.0`)

- **Default CDN URL**: `https://cdn.jsdelivr.net/npm/mediabunny@1.62.0/+esm` (cached automatically by `sw.js` after first online load).
- **Optional local vendoring for air-gapped / zero-CDN deployments**:
  1. Download the pinned ESM bundle into `heiwa-clips-cut/vendor/mediabunny-1.62.0.mjs`:
     ```bash
     mkdir -p heiwa-clips-cut/vendor
     curl -L "https://cdn.jsdelivr.net/npm/mediabunny@1.62.0/dist/bundles/mediabunny.min.mjs" -o heiwa-clips-cut/vendor/mediabunny-1.62.0.mjs
     ```
  2. Update `MEDIABUNNY_CDN_URL` in `js/metadata.js` and `js/export-worker.js` to `'../vendor/mediabunny-1.62.0.mjs'`.
  3. Add `'./vendor/mediabunny-1.62.0.mjs'` to `APP_SHELL_URLS` in `sw.js` and bump `CACHE_VERSION`.

---

## Documentation Index

- `docs/DEPLOY.md` — Static HTTPS hosting, headers, and release checklist.
- `docs/TWA.md` — Android Trusted Web Activity packaging (Bubblewrap / PWABuilder, SHA-256, Digital Asset Links, Google Play).
- `docs/TEST-PLAN.md` — Stage 1–10 manual and automated test steps.
- `docs/TEST-REPORT.md` — Honest automated verification results and remaining live-browser sign-off checklist.
- `docs/LIMITATIONS.md` — Documented browser, codec, memory, ZIP, storage, and offline limits.
