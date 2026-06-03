'use strict';

// build-www.mjs — assemble the static web app into www/ for Capacitor.
//
// Capacitor's webDir is "www" (see capacitor.config.json). This script copies
// the browser app (index.html + asset dirs) into a clean www/ folder. The same
// copied output runs unmodified on both targets:
//   - Web: served from a static host, uses the File System Access API.
//   - Android: bundled by `cap sync`, the native WebView auto-injects
//     window.Capacitor (no <script> tag is injected here on purpose).
//
// No external deps — Node built-ins only.

import { rm, mkdir, cp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Only the files the 'wasm' execution provider needs are vendored (see the
// detector — executionProviders: ['wasm']). onnxruntime-web/dist also ships
// other wasm variants (jspi / asyncify / training, ~50MB total) that this app
// never loads; copying just these keeps the APK smaller while remaining fully
// offline. Each is copied only if present in the installed onnxruntime-web
// version; a missing entry warns and is skipped.
//
// IMPORTANT: onnxruntime-web 1.19's classic `ort.min.js` bundle loads the
// *JSEP* wasm variant for the wasm EP (it dynamically imports
// `ort-wasm-simd-threaded.jsep.mjs`, which in turn fetches the `.jsep.wasm`),
// NOT the plain `ort-wasm-simd-threaded.{mjs,wasm}`. Vendoring the non-jsep
// pair left the runtime unable to resolve a backend on-device ("no available
// backend found" → detection silently disabled). Vendor the jsep pair.
const ORT_WASM_EP_FILES = [
  'ort.min.js',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm'
];

// Repo root is the parent dir of this script's dir (scripts/ -> repo root).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const wwwDir = path.join(repoRoot, 'www');

// Source items copied verbatim into www/ when present. Anything not listed here
// (node_modules, android, www, .git, scripts, docs, package.json,
// capacitor.config.json, wrangler.jsonc, etc.) is intentionally excluded.
const SOURCE_ITEMS = [
  'index.html',
  'css',
  'js',
  'assets',
  'models',
  'LICENSE.txt'
];

// Resolve to a path only if it exists; otherwise null (optional items skipped).
async function pathIfExists(name) {
  const full = path.join(repoRoot, name);
  try {
    await stat(full);
    return full;
  } catch {
    return null;
  }
}

async function main() {
  // Start from a clean www/ so stale files never leak into a build.
  await rm(wwwDir, { recursive: true, force: true });
  await mkdir(wwwDir, { recursive: true });

  const copied = [];
  const skipped = [];

  for (const name of SOURCE_ITEMS) {
    const src = await pathIfExists(name);
    if (!src) {
      skipped.push(name);
      continue;
    }
    // recursive handles both files and directories.
    await cp(src, path.join(wwwDir, name), { recursive: true });
    copied.push(name);
  }

  // Vendor the onnxruntime-web distributables so the on-device detector works
  // OFFLINE on Android (no CDN). The detector loads vendor/onnxruntime/ort.min.js
  // and sets ort.env.wasm.wasmPaths to vendor/onnxruntime/ at runtime on native.
  //
  // SLIM vendor: the detector uses the 'wasm' execution provider only, so we copy
  // just the three files that EP needs (ORT_WASM_EP_FILES) instead of the entire
  // ~70MB dist (which bundles unused jsep/jspi/asyncify/training wasm variants).
  // This trims ~50MB from the APK. Vendoring is skipped gracefully (with a
  // warning) when node_modules is absent so a plain `build:www` without
  // `npm install` still succeeds; individual files missing from this
  // onnxruntime-web version warn and are skipped without aborting the build.
  const ortSrc = path.join(repoRoot, 'node_modules', 'onnxruntime-web', 'dist');
  const ortDest = path.join(wwwDir, 'vendor', 'onnxruntime');
  const vendoredFiles = [];
  let distMissing = false;
  try {
    await stat(ortSrc);
  } catch {
    distMissing = true;
    console.warn(
      'build:www — WARNING: node_modules/onnxruntime-web/dist not found; ' +
      'skipping vendor/onnxruntime (run `npm install` for offline Android detection).'
    );
  }
  if (!distMissing) {
    await mkdir(ortDest, { recursive: true });
    for (const file of ORT_WASM_EP_FILES) {
      const fileSrc = path.join(ortSrc, file);
      try {
        await stat(fileSrc);
      } catch {
        console.warn(
          `build:www — WARNING: onnxruntime-web/dist/${file} not found in this ` +
          'version; skipping it (wasm detection may be affected).'
        );
        continue;
      }
      await cp(fileSrc, path.join(ortDest, file));
      vendoredFiles.push(file);
    }
  }

  const summary =
    `build:www — copied [${copied.join(', ') || 'nothing'}] into www/` +
    (vendoredFiles.length
      ? ` + slim vendor/onnxruntime [${vendoredFiles.join(', ')}]`
      : '') +
    (skipped.length ? ` (skipped missing: ${skipped.join(', ')})` : '');
  console.log(summary);
}

main().catch((err) => {
  console.error('build:www failed:', err);
  process.exit(1);
});
