'use strict';

/**
 * Test harness for PalmAnnotate's browser modules.
 *
 * The app ships as classic <script> files: vanilla-JS IIFEs that attach their
 * public API to `window.*` and share a single global lexical scope (so a
 * top-level `const CLASS_MAP` in yolo-io.js is visible to detector.js, etc).
 *
 * To exercise that real behaviour in Node — with no bundler and no browser —
 * we run the source in a `node:vm` context where `window === globalThis`
 * (exactly like a browser), and we CONCATENATE co-dependent files so their
 * top-level lexical bindings see each other, just as multiple <script> tags do.
 *
 * Browser globals the modules touch at load/run time (document, navigator,
 * canvas 2d context, Image, fetch, ort) are provided as light stubs; tests can
 * override or extend them via `globals`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A canvas 2D context stub good enough for letterbox preprocessing. */
function canvas2dContextStub() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    drawImage() {},
    beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, arc() {},
    stroke() {}, fill() {}, closePath() {},
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    setTransform() {}, resetTransform() {},
    fillText() {}, strokeText() {},
    measureText() { return { width: 0 }; },
    putImageData() {},
    // Returns an opaque RGBA buffer of the requested size; letterbox only needs
    // it to be the right length (it normalises pixels into a tensor it then
    // hands to ORT, which the tests stub out).
    getImageData(_x, _y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
  };
}

function canvasElementStub() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext() { return canvas2dContextStub(); },
    toDataURL() { return 'data:,'; },
    addEventListener() {}, removeEventListener() {},
  };
}

function documentStub() {
  const noopParent = { appendChild() {}, removeChild() {}, insertBefore() {} };
  return {
    head: noopParent,
    body: noopParent,
    documentElement: { style: {} },
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return canvasElementStub();
      if (String(tag).toLowerCase() === 'script') {
        return { src: '', async: false, onload: null, onerror: null, setAttribute() {} };
      }
      return {
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, appendChild() {}, removeChild() {},
        addEventListener() {}, removeEventListener() {},
      };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

class ImageStub {
  constructor() {
    this.crossOrigin = '';
    this.onload = null;
    this.onerror = null;
    this._src = '';
  }
  get src() { return this._src; }
  set src(v) { this._src = v; /* tests that need load events should override */ }
}

/**
 * Load one or more browser script files into a fresh vm context and return the
 * context (which doubles as `window`/`globalThis`).
 *
 * @param {string|string[]} paths   repo-relative paths, concatenated in order
 * @param {object} [opts]
 * @param {object} [opts.globals]   extra context globals (fetch, ort, Capacitor…)
 * @param {string} [opts.epilogue]  JS appended after the sources (same lexical
 *                                  scope) — use to capture top-level `const`s,
 *                                  e.g. "window.__cap = { CLASS_MAP };"
 * @returns {object} the context object
 */
export function loadModule(paths, { globals = {}, epilogue = '' } = {}) {
  const list = Array.isArray(paths) ? paths : [paths];

  const ctx = {
    console,
    document: documentStub(),
    navigator: { userAgent: 'node-test', platform: 'node' },
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:' },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    Image: ImageStub,
    performance: { now() { return 0; } },
    ...globals,
  };
  // Browser model: window IS the global object.
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;

  vm.createContext(ctx);

  const src = list.map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n;\n') +
    (epilogue ? '\n;' + epilogue + '\n' : '');
  vm.runInContext(src, ctx, { filename: list.join(' + ') });
  return ctx;
}
