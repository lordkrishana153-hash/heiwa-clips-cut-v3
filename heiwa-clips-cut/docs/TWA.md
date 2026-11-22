# Android Trusted Web Activity (TWA) Packaging Guide

This guide explains how to package **Heiwa Clips Cut** as an Android Trusted Web Activity (TWA) for sideloading or publishing on Google Play, while keeping the app 100% local-only with zero backend servers.

---

## 1. Prerequisites

1. **HTTPS production hosting**: Deploy `heiwa-clips-cut/` to a static HTTPS host (GitHub Pages, Cloudflare Pages, Netlify, Firebase Hosting, etc.).
   - Verify `https://<your-domain>/manifest.webmanifest` returns HTTP `200` with valid JSON.
   - Verify `https://<your-domain>/sw.js` registers cleanly and passes Chrome DevTools -> **Application -> Manifest / Service Workers** checks.
   - Verify `https://<your-domain>/icons/icon-192.png`, `icon-512.png`, and `maskable-512.png` load cleanly.
2. **Local tooling (for Bubblewrap CLI)**:
   - Node.js 18+
   - JDK 17 (Bubblewrap can also download a local JDK/Android SDK automatically on first run).

---

## 2. Option A — Build with Bubblewrap CLI (Recommended)

Install Bubblewrap globally:

```bash
npm install -g @bubblewrap/cli
```

Create a build folder **outside** `heiwa-clips-cut/` and initialize the TWA project directly from your live manifest:

```bash
mkdir heiwa-clips-cut-twa && cd heiwa-clips-cut-twa
bubblewrap init --manifest=https://<your-domain>/manifest.webmanifest
```

When prompted by `bubblewrap init`:
- **Domain**: `<your-domain>`
- **Application ID (package name)**: e.g. `com.yourdomain.heiwaclipscut` (must match `.well-known/assetlinks.json`)
- **App name**: `Heiwa Clips Cut`
- **Short name**: `Heiwa Clips`
- **Display mode**: `standalone`
- **Status bar / Navigation bar colors**: `#0f766e` / `#0f172a`
- **Fallback strategy**: `customtabs`
- **Signing key**: Create a new release upload keystore (store the `.keystore` file and passwords safely; never commit them to Git).

Build the signed Android App Bundle (`.aab` for Google Play) and APK (for device testing):

```bash
bubblewrap build
```

Outputs generated:
- `app-release-bundle.aab` (upload to Google Play Console)
- `app-release-signed.apk` (install on an Android device via USB for testing)

---

## 3. Option B — Build with PWABuilder

1. Open [https://www.pwabuilder.com/](https://www.pwabuilder.com/) and enter `https://<your-domain>/`.
2. Confirm the Manifest and Service Worker scores are green.
3. Choose **Package For Stores -> Android -> Generate Package**.
4. Enter your Android **Package ID** (e.g. `com.yourdomain.heiwaclipscut`), verify the maskable icon (`maskable-512.png`), and download the ZIP containing the `.aab`, `.apk`, signing key, and ready-made `assetlinks.json`.

---

## 4. Digital Asset Links (`.well-known/assetlinks.json`)

Without verified Digital Asset Links, Android opens the TWA with a visible Chrome URL bar at the top. To enable true full-screen standalone TWA mode:

### Step 1: Get your SHA-256 certificate fingerprint

For **local testing** (your upload keystore):

```bash
keytool -list -v -keystore android.keystore -alias android
```

Copy the `SHA256:` line (uppercase hex pairs separated by colons, 95 characters long).

For **Google Play production** (critical!):
- Google Play App Signing re-signs your `.aab` with Google's app signing key.
- In **Google Play Console -> Setup -> App signing -> App signing key certificate**, copy the **SHA-256 certificate fingerprint** too.
- You can list **both** fingerprints (your local upload key and Play's app signing key) in `sha256_cert_fingerprints` so both local sideload builds and Play Store installs verify cleanly.

### Step 2: Update `heiwa-clips-cut/.well-known/assetlinks.json`

Replace the placeholder `package_name` and `sha256_cert_fingerprints` in `heiwa-clips-cut/.well-known/assetlinks.json`:

```json
[
  {
    "relation": [
      "delegate_permission/common.handle_all_urls"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "com.yourdomain.heiwaclipscut",
      "sha256_cert_fingerprints": [
        "AA:BB:CC:...:YOUR_UPLOAD_KEY_SHA256",
        "11:22:33:...:YOUR_PLAY_APP_SIGNING_SHA256"
      ]
    }
  }
]
```

### Step 3: Verify hosting and link validation

1. Confirm `https://<your-domain>/.well-known/assetlinks.json` returns:
   - HTTP `200 OK` (no `301`/`302` redirects!)
   - `Content-Type: application/json`
   - Publicly accessible (not blocked by auth or `robots.txt` / CDN rules)
2. Test with Google's Digital Asset Links statement list validator:
   - `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<your-domain>&relation=delegate_permission/common.handle_all_urls`
3. Verify on an Android test device:

```bash
adb shell pm get-app-links com.yourdomain.heiwaclipscut
```

---

## 5. Android & Google Play Notes for Heiwa Clips Cut

- **Permissions**: No broad storage permissions (`READ_MEDIA_VIDEO`, `READ_EXTERNAL_STORAGE`) are needed. Chrome inside the TWA handles `<input type="file" accept="video/*">` via Android's native system file/media picker, and downloaded clips save directly to the user's `Downloads/` folder.
- **Offline behavior**: Once launched once online, the Stage 9 Service Worker caches the entire app shell and pinned Mediabunny ESM module (`1.62.0`) so local clipping works offline.
- **Hardware & RAM limits on Android**: WebCodecs hardware H.264/AAC encoding works well on modern Android Chrome, but 4K or long high-bitrate clips can exhaust mobile tab RAM. Heiwa Clips Cut automatically recommends individual downloads over ZIP on phones and surfaces preflight warnings (`E_OUT_OF_MEMORY_RISK`) when clip sizes are large.
- **Google Play Data Safety form**: Because Heiwa Clips Cut has zero backend, zero uploads, zero analytics, and zero third-party SDKs (only local browser processing and IndexedDB metadata), you can accurately declare **"No data collected"** and **"No data shared with third parties"**.
