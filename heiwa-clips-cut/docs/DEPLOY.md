# Deployment Guide

**Heiwa Clips Cut** is a 100% static web application (plain HTML, CSS, and JavaScript ES modules). No server runtime, database, or build step is required.

---

## 1. Hosting Requirements

1. **HTTPS is mandatory** in production (required by WebCodecs, Service Workers, PWA installability, `showSaveFilePicker`, and Android TWA).
2. **Standard MIME types**:
   - `.js` / `.mjs` -> `application/javascript; charset=utf-8`
   - `.webmanifest` -> `application/manifest+json; charset=utf-8`
   - `.json` (including `.well-known/assetlinks.json`) -> `application/json; charset=utf-8`
   - `.svg` -> `image/svg+xml`
3. **Cache headers**:
   - `sw.js`: serve with `Cache-Control: no-cache, must-revalidate` so browsers always detect new versions promptly and trigger the controlled **Reload to Update** banner.
   - `.well-known/assetlinks.json`: serve with HTTP `200 OK` (no `301`/`302` redirects) and `Content-Type: application/json`.
   - Static HTML/CSS/JS/icons: standard caching is fine; bumping `CACHE_VERSION` in `sw.js` updates cached app-shell assets cleanly on the next release.
4. **Do NOT require COOP/COEP headers**: Heiwa Clips Cut uses WebCodecs + Mediabunny rather than `SharedArrayBuffer` / FFmpeg.wasm, so `Cross-Origin-Embedder-Policy` is **not** needed and avoiding it prevents breaking jsDelivr ESM imports (unless you vendor Mediabunny locally).

---

## 2. Static Host Quick Steps

### GitHub Pages
1. Copy the contents of `heiwa-clips-cut/` to your repository's `docs/` folder or `gh-pages` branch root.
2. Add an empty `.nojekyll` file at the published root so GitHub Pages serves the `.well-known/` directory instead of ignoring dot-prefixed folders!
3. Enable HTTPS in **Repository Settings -> Pages**.

### Cloudflare Pages / Netlify / Vercel
1. Set the publish/output directory to `heiwa-clips-cut` with **no build command**.
2. Verify `/.well-known/assetlinks.json` is not hidden or redirected by any SPA rewrite rule (do **not** rewrite `/.well-known/*` to `/index.html`).
3. Add a `_headers` rule (Cloudflare Pages / Netlify) to prevent stale Service Worker caching:
   ```text
   /sw.js
     Cache-Control: no-cache, must-revalidate

   /.well-known/assetlinks.json
     Content-Type: application/json
   ```

### Self-Hosted Nginx Example

```nginx
server {
  listen 443 ssl http2;
  server_name clips.example.com;
  root /var/www/heiwa-clips-cut;
  index index.html;

  location = /sw.js {
    add_header Cache-Control "no-cache, must-revalidate";
  }

  location = /.well-known/assetlinks.json {
    default_type application/json;
  }
}
```

---

## 3. Release Checklist

1. Bump `CACHE_VERSION` in `sw.js` (for example `'v9.0.0'` -> `'v10.0.0'`) whenever releasing updated HTML/CSS/JS.
2. If deploying as an Android TWA, update `.well-known/assetlinks.json` with your real `package_name` and SHA-256 fingerprint(s) (see `docs/TWA.md`).
3. After deployment, verify in a clean browser profile:
   - `https://<your-domain>/` loads with zero console errors.
   - `https://<your-domain>/tests/tests.html` passes all **39** unit tests.
   - DevTools -> **Application -> Manifest** and **Service Workers** show zero errors.
   - Offline reload works after one online visit.
