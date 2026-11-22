# Test Plan

Manual and automated browser test plan across Stages 1–10.

## Stage 1
- Serve `heiwa-clips-cut/` over HTTP/HTTPS and verify `index.html` loads with zero console errors.
- Confirm the header capability strip displays real runtime results for WebCodecs, H.264/AAC, VP9/Opus, Workers, IndexedDB, and File Save APIs.
- Open `tests/tests.html` and verify all unit tests for `time.js`, `store.js`, and `errors.js` pass.

## Stage 2
- Load a valid short MP4 via the file picker and verify duration (`HH:MM:SS.mmm`), resolution, fps, video codec, audio codec (or None), file size, and compatibility verdict display accurately.
- Test play/pause and dragging the seek bar on the preview player; verify current time updates cleanly.
- Drag and drop a plain `.txt` file renamed to `.mp4` and verify `E_CORRUPT_FILE` or `E_UNSUPPORTED_CONTAINER` appears in both the inline error box, preview stage, and toast.
- Test a 0-byte file and verify `E_EMPTY_FILE` is displayed.
- Click **Replace** to swap to a second video, then **Clear**, and verify clean state reset and no leaked object URLs.

## Stage 3
- Load a valid video and create 5 clips using Set Start / Set End, duration presets (15s, 30s, 60s, Custom), and Quick +Ns at Playhead.
- Click **Edit** on a clip, test an invalid timestamp (`-5` or `abc`) and reversed range (`start >= end`), verify inline `E_TIME_PARSE` / `E_RANGE_INVALID` appears and nothing changes in the clip list.
- Save a valid edit, reorder clips with both Up/Down buttons and drag-and-drop, duplicate a clip, delete a clip, click **Undo** 3 times and **Redo** once, verifying the exact list state.
- Click **Preview** on a clip and verify playback starts at `startSec` and stops automatically at `endSec`.
- Open `tests/tests.html` and verify all Stage 1–3 unit tests pass.

## Stage 4
- Load a video and add 3 clips; verify all 3 clip bars and the highlighted draft range appear accurately on the **Timeline** track.
- Click and drag across the timeline track and verify the red playhead and `<video>` preview seek smoothly in sync.
- Click **+** (Zoom In) several times; verify the timeline expands while keeping the playhead visible, **Pan Left / Pan Right** scroll horizontally, and **Reset** restores `1.0×` zoom.
- On a touch device (or Chrome DevTools touch emulation), verify two-finger pinch zooms the timeline and single-finger drag scrubs without breaking vertical scroll.
- Test transport controls: **-1f** / **+1f** frame step, **Prev clip**, **Clip start**, **Clip end**, and **Next clip**.
- Test keyboard shortcuts: `Space`, `Left`/`Right`, `Shift+Left`/`Shift+Right`, `,`/`.`, `I`, `O`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `?` (opens Shortcuts dialog).
- Focus a text input (Draft Start or inline clip Edit field) and type `i`, `o`, `Space`, `,`, `.`; verify normal text entry occurs and no playback/marker shortcut fires.
- Resize viewport to `320px`, `768px`, and `1280px`; verify mobile single-column with zero horizontal overflow, tablet 2-column, and desktop side-by-side layout with `>= 44px` touch targets.
- Open `tests/tests.html` and verify all Stage 1–4 unit tests pass.

## Stage 5
- Load a landscape 16:9 video and add 2 clips. Select Clip 1 and click **9:16** in **Crop & Reframe**; verify the crop overlay appears aligned over the video and output info displays even dimensions (e.g., `608 × 1080 • 9:16`).
- Drag the crop frame left/right on the preview stage and adjust the **Zoom** slider (`1×` to `4×`); verify smooth positioning and single-step **Undo** reversion.
- Switch Framing Mode to **Fit** and toggle **Black bars** vs **Blur** (if supported by the browser). Click **Preview Framed Output** and play the video to verify live framed rendering matches the overlay.
- Select Clip 2 and verify Clip 1's crop settings persist independently per clip. Return to Clip 1, click **Apply to all clips**, verify Clip 2 matches, then click **Undo** once to confirm Clip 2 reverts.
- Click **Reset** on Clip 1 and verify framing returns to `Original`, `1.00×`, `50% × 50%`.
- Open `tests/tests.html` and verify all Stage 1–5 unit tests pass.

## Stage 6
- Load a short MP4 (H.264/AAC) and add 2 clips: Clip 1 left at `Original` framing, Clip 2 reframed to `9:16`.
- Select Clip 1, click **Run Preflight Check** in **Export Engine & Preflight**, and verify it passes with estimated size and rough processing time.
- Keep **Precise (Re-encode)** + **MP4 (H.264/AAC)** and click **Process "Clip 1"**; verify real percentage and phase progress updates cleanly in the Web Worker and ends with a non-empty `video/mp4` summary.
- Select Clip 2 (`9:16` crop), verify **Fast (Keyframe Copy)** is disabled with an explanation, and click **Process "Clip 2"** in **Precise** mode; verify cropped export completes cleanly.
- Reset Clip 2 framing to `Original`, switch to **Fast (Keyframe Copy)**, verify the keyframe alignment note displays, and click **Process "Clip 1"**; verify packet-copy phases (`Copying video packets…`, `Copying audio packets…`) complete quickly without re-encoding.
- Start a longer **Precise** export and click **Cancel** mid-run; verify the job stops promptly, status updates to `Cancelled`, and the worker terminates cleanly.
- Open `tests/tests.html` and verify all Stage 1–6 unit tests pass.

## Stage 7
- Load a short MP4 and create 3 clips (e.g., 5s, 8s, 6s). Click **Export All (3)** and verify jobs run strictly one at a time with per-job progress, overall progress bar, and verification (`Verified • video/mp4 • …`) on every job card.
- Edit the output filename of Clip 1 (e.g., enter `My: Clip?*` and press Enter/Tab); verify unsafe characters are sanitized, `.mp4` is kept, and collisions deduplicate cleanly.
- Click **Download** on Job 1 and confirm the saved `.mp4` opens and plays in your system media player with the expected length.
- Click **Download All (3)** and confirm sequential downloads trigger cleanly (and allow "Automatic downloads" if prompted by the browser).
- Click **Download ZIP (3)**, save the `.zip` archive (via native Save Picker on Chromium desktop or Blob download fallback), extract it with your OS archive utility, and confirm all 3 clips open and play cleanly.
- Start **Export All (3)** again, click **Cancel** during Job 1 or Job 2, verify active worker terminates and remaining jobs become `cancelled`, then click **Retry Failed** and verify unfinished jobs complete cleanly.
- Open `tests/tests.html` and verify all Stage 1–7 unit tests pass (33 tests).

## Stage 8
- Load a local video, create 3 clips, adjust crop on Clip 1, and wait 1 second; verify the header autosave pill changes to `Saved HH:MM:SS` and **Local Storage & Export History** displays the autosave timestamp and storage persistence/quota info.
- Reload the browser tab (`F5`). Verify the **Restore Previous Session?** dialog opens with the saved filename, size, duration, and clip count.
- Click **Restore session**; verify the yellow recovery banner appears at the top of the workspace.
- First test mismatch protection: click **Choose Video to Re-attach** and intentionally pick a *different* video file. Verify the **Selected Video Does Not Match Saved Project** dialog lists the exact name/size/duration differences and click **Keep recovery pending**.
- Click **Choose Video to Re-attach** again and pick the *original* video file. Verify all 3 clips, framing settings, and export preferences re-attach automatically and the recovery banner clears.
- Export and download a clip, verify a metadata-only row appears in **Local Storage & Export History**, reload the page (and discard or restore), verify the export history persists, then click **Clear History** and confirm it clears cleanly.
- Open `tests/tests.html` and verify all Stage 1–8 unit tests pass (37 tests).

## Stage 9
- Serve `heiwa-clips-cut/` over `http://localhost` or HTTPS, open DevTools -> **Application -> Manifest**, and verify `manifest.webmanifest` parses cleanly with 192px, 512px, and maskable 512px icons.
- Open DevTools -> **Application -> Service Workers**, confirm `sw.js` registers and activates cleanly, and inspect **Cache Storage** to confirm `heiwa-clips-cut-shell-v9.0.0` caches all app shell files (and `heiwa-clips-cut-vendor-v9.0.0` caches Mediabunny `1.62.0` once online).
- Enable **Offline** in DevTools -> Network (or turn off Wi-Fi), reload `index.html`, confirm the header pill switches to `Offline (Local Ready)`, and verify you can still open a local video, mark clips, and export offline.
- On desktop Chrome/Edge or Android Chrome, verify the **Install App** button appears when install criteria are met, click it, and confirm standalone launch shows `Installed` in the header.
- Simulate a Service Worker update (bump `CACHE_VERSION` in `sw.js` and click Update in DevTools); verify the **Reload to Update** banner appears without interrupting the current page, and clicking **Reload to Update** activates the new worker and reloads cleanly (while refusing to reload mid-export).
- Open `tests/tests.html` and verify all Stage 1–9 unit tests pass (39 tests).

## Stage 10 (Final End-to-End & Accessibility Sign-Off)
- **Keyboard-only navigation**: Press `Tab` from the top of the page; verify **Skip to workspace** appears cleanly, focus outlines remain visible across all controls, and `?` opens/closes the Shortcuts dialog with focus restored.
- **320px / 768px / 1280px responsive audit**: Test at `320px` width (portrait phone), `768px` (tablet), and `1280px` (desktop); verify zero horizontal page overflow, readable labels, and `>= 44px` touch targets.
- **Theme & Reduced Motion**: Toggle OS light/dark theme and `prefers-reduced-motion: reduce`; verify contrast and instant non-animated transitions.
- **Full studio workflow**: Open a local video -> add 3 clips -> reframe Clip 1 to `9:16` -> export all -> verify playback/duration -> download individual + ZIP -> extract ZIP -> reload tab -> restore session -> re-attach video -> enable Offline mode -> export a clip offline.



