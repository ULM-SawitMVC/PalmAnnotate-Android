'use strict';

/**
 * Detector — on-device YOLO running inside the WebView via onnxruntime-web.
 *
 * Design (per advisor):
 *   - DETECT-ONLY: the model is single-class; we never trust/emit a real class.
 *     Every returned box defaults to classId 1 (B2) so the expert re-labels it.
 *   - OVER-DETECT: a LOW confThreshold + generous iouThreshold is preferred —
 *     deleting a spurious box is cheaper than drawing a missed one.
 *   - One model path works on both targets: web pulls ORT from a CDN; Android
 *     loads the runtime + wasm vendored into www/vendor/onnxruntime (OFFLINE).
 *
 * The ORT runtime is lazy-loaded by INJECTING a <script> at runtime — there is
 * no static tag in index.html. The model itself lives at models/<modelFile>.
 *
 * All public methods are NON-THROWING: failures degrade to "unavailable" and
 * are logged to the console so the host can guard with isAvailable().
 *
 * Usage:
 *   if (await Detector.isAvailable()) {
 *     const boxes = await Detector.detectForSide(side); // editor-shaped bboxes
 *   }
 */

const Detector = (() => {

  // Config defaults — overridden by models/detector.config.json when present.
  const DEFAULT_CONFIG = {
    modelFile: 'ffb-detector.onnx',
    inputSize: 640,
    confThreshold: 0.15,
    iouThreshold: 0.6,
    maxBoxes: 300,
    classAware: false,
  };

  // Neutral default class the expert re-labels (classId 1 = 'B2').
  const DEFAULT_CLASS_ID = 1;

  // Web CDN for the ORT runtime + matching wasm dist (offline req is Android).
  const ORT_VERSION  = '1.19.0';
  const CDN_BASE     = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const VENDOR_BASE  = 'vendor/onnxruntime/';

  // Caches — populated lazily, reused across calls.
  let _config        = null;   // resolved config object
  let _ortPromise    = null;   // Promise<ort> for the runtime
  let _sessionPromise = null;  // Promise<InferenceSession|null>
  let _unavailable   = false;  // sticky once we know the model/runtime is missing

  function _isNativeRuntime() {
    return !!(window.Capacitor &&
              window.Capacitor.isNativePlatform &&
              window.Capacitor.isNativePlatform());
  }

  // Inject a <script> tag once; resolve when window.ort is ready.
  function _injectScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(el);
    });
  }

  // Lazy-load the ORT runtime by injecting the right <script> for the platform
  // and configuring wasmPaths. Cached. Resolves window.ort; rejects on failure.
  function _loadOrt() {
    if (_ortPromise) return _ortPromise;
    _ortPromise = (async () => {
      if (window.ort) return window.ort;
      const native = _isNativeRuntime();
      const scriptSrc = native ? (VENDOR_BASE + 'ort.min.js') : (CDN_BASE + 'ort.min.js');
      await _injectScript(scriptSrc);
      if (!window.ort) throw new Error('ort runtime did not initialize window.ort');
      try {
        // Point the wasm loader at the matching dist (vendored on native, CDN on web).
        window.ort.env.wasm.wasmPaths = native ? VENDOR_BASE : CDN_BASE;
      } catch (err) {
        console.warn('Detector: could not set ort.env.wasm.wasmPaths —', err);
      }
      return window.ort;
    })();
    // On failure, clear the cache so a later attempt can retry.
    _ortPromise.catch((err) => {
      console.warn('Detector: ORT runtime load failed —', err);
      _ortPromise = null;
    });
    return _ortPromise;
  }

  // Read models/detector.config.json, merge over defaults. Cached. Never throws.
  async function _loadConfig() {
    if (_config) return _config;
    let parsed = {};
    try {
      const res = await fetch('models/detector.config.json', { cache: 'no-store' });
      if (res.ok) {
        parsed = await res.json();
      } else {
        console.warn('Detector: detector.config.json fetch returned', res.status, '— using defaults.');
      }
    } catch (err) {
      console.warn('Detector: could not read detector.config.json — using defaults.', err);
    }
    _config = { ...DEFAULT_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    return _config;
  }

  // True if a model file appears fetchable. Uses HEAD, falls back to a ranged
  // GET when HEAD is not supported (some static hosts / native shims). Never throws.
  async function _modelExists(modelFile) {
    const url = 'models/' + modelFile;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) return true;
      // Some hosts answer HEAD with 405/501 even though GET works — probe with GET.
      if (head.status === 405 || head.status === 501) {
        const get = await fetch(url, { method: 'GET' });
        return get.ok;
      }
      return false;
    } catch (err) {
      // HEAD unsupported (e.g. capacitor:// scheme) — try a plain GET.
      try {
        const get = await fetch(url, { method: 'GET' });
        return get.ok;
      } catch (err2) {
        console.warn('Detector: model fetch probe failed for', url, '—', err2);
        return false;
      }
    }
  }

  /**
   * Whether on-device detection can run right now: the model file is fetchable
   * AND the ORT runtime loads. Never throws — returns false on any failure.
   * @returns {Promise<boolean>}
   */
  async function isAvailable() {
    if (_unavailable) return false;
    try {
      const cfg = await _loadConfig();
      const exists = await _modelExists(cfg.modelFile);
      if (!exists) return false;
      await _loadOrt();
      return true;
    } catch (err) {
      console.warn('Detector: isAvailable() check failed —', err);
      return false;
    }
  }

  /**
   * Create (and cache) the inference session. Resolves the session, or null if
   * the model 404s / the runtime is unavailable. NON-THROWING.
   * @returns {Promise<object|null>} ort.InferenceSession or null
   */
  function load() {
    if (_sessionPromise) return _sessionPromise;
    _sessionPromise = (async () => {
      try {
        const cfg = await _loadConfig();
        const exists = await _modelExists(cfg.modelFile);
        if (!exists) {
          console.warn('Detector: model not found at models/' + cfg.modelFile + ' — detection disabled.');
          _unavailable = true;
          return null;
        }
        const ort = await _loadOrt();
        const session = await ort.InferenceSession.create('models/' + cfg.modelFile, {
          executionProviders: ['wasm'],
        });
        return session;
      } catch (err) {
        console.warn('Detector: load() failed — detection disabled.', err);
        _unavailable = true;
        return null;
      }
    })();
    // Do not poison the cache on failure paths that returned null; only clear it
    // if the promise itself rejected (it should not, given the try/catch above).
    _sessionPromise.catch(() => { _sessionPromise = null; });
    return _sessionPromise;
  }

  // ── Preprocessing (letterbox → NCHW Float32) ────────────────────────────────

  // Resolve an arbitrary imageSource to something drawable on a canvas.
  // Accepts HTMLImageElement / ImageBitmap / HTMLCanvasElement / URL string.
  function _toDrawable(imageSource) {
    if (typeof imageSource === 'string') {
      return new Promise((resolve, reject) => {
        const img = new Image();
        // Allow reading pixels from cross-origin (CDN/web) images.
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('failed to load image ' + imageSource));
        img.src = imageSource;
      });
    }
    return Promise.resolve(imageSource);
  }

  function _drawableSize(d) {
    return {
      w: d.naturalWidth || d.width || 0,
      h: d.naturalHeight || d.height || 0,
    };
  }

  // Letterbox `drawable` into a size×size square (keep aspect, pad). Returns the
  // NCHW Float32 tensor data plus the scale + pad needed to undo the transform.
  function _letterbox(drawable, size) {
    const { w: srcW, h: srcH } = _drawableSize(drawable);
    const scale = Math.min(size / srcW, size / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = Math.floor((size - newW) / 2);
    const padY = Math.floor((size - newH) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Neutral grey pad (matches Ultralytics' default 114,114,114).
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(drawable, 0, 0, srcW, srcH, padX, padY, newW, newH);

    const { data } = ctx.getImageData(0, 0, size, size); // RGBA, row-major
    const area = size * size;
    const tensor = new Float32Array(area * 3); // NCHW: [R-plane, G-plane, B-plane]
    for (let i = 0; i < area; i++) {
      const r = data[i * 4]     / 255;
      const g = data[i * 4 + 1] / 255;
      const b = data[i * 4 + 2] / 255;
      tensor[i]            = r;
      tensor[area + i]     = g;
      tensor[area * 2 + i] = b;
    }
    return { tensor, scale, padX, padY };
  }

  // ── Output decoding ─────────────────────────────────────────────────────────

  // YOLOv8/YOLO11 export emits [1, 4+nc, N] (channels-first) or, after some
  // post-processing, [1, N, 4+nc]. Auto-detect which axis carries 4+nc.
  // Returns { rows: N, attrs: 4+nc, at(row, attr) } reading into the flat data.
  function _orientOutput(data, dims) {
    // dims is typically [1, A, B]; squeeze the leading batch dim.
    let a, b;
    if (dims.length === 3) { a = dims[1]; b = dims[2]; }
    else if (dims.length === 2) { a = dims[0]; b = dims[1]; }
    else { a = dims[dims.length - 2]; b = dims[dims.length - 1]; }

    // Prefer the axis whose length is the smaller plausible "attrs" count
    // (>= 5 means 4 box coords + >=1 class/objectness). When both look like
    // attrs (rare), the smaller one is attrs and the larger is the box count.
    const aIsAttrs = a >= 5 && a < b;
    const bIsAttrs = b >= 5 && b < a;

    let attrs, rows, channelsFirst;
    if (aIsAttrs && !bIsAttrs) {
      attrs = a; rows = b; channelsFirst = true;   // [attrs, N]
    } else if (bIsAttrs && !aIsAttrs) {
      attrs = b; rows = a; channelsFirst = false;  // [N, attrs]
    } else {
      // Ambiguous — default to channels-first (the common YOLOv8 onnx layout).
      attrs = a; rows = b; channelsFirst = true;
    }

    const at = channelsFirst
      ? (row, attr) => data[attr * rows + row]   // [attrs, N]
      : (row, attr) => data[row * attrs + attr]; // [N, attrs]

    return { rows, attrs, at };
  }

  // ── NMS (class-agnostic) ────────────────────────────────────────────────────

  function _iou(a, b) {
    const ix1 = Math.max(a.x1, b.x1);
    const iy1 = Math.max(a.y1, b.y1);
    const ix2 = Math.min(a.x2, b.x2);
    const iy2 = Math.min(a.y2, b.y2);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    if (inter <= 0) return 0;
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
  }

  function _nms(boxes, iouThreshold, maxBoxes) {
    const sorted = boxes.slice().sort((p, q) => q.score - p.score);
    const kept = [];
    for (const cand of sorted) {
      let overlap = false;
      for (const k of kept) {
        if (_iou(cand, k) > iouThreshold) { overlap = true; break; }
      }
      if (!overlap) {
        kept.push(cand);
        if (kept.length >= maxBoxes) break;
      }
    }
    return kept;
  }

  /**
   * Run detection on an image. Returns editor-shaped bboxes in ORIGINAL IMAGE
   * pixel coordinates. NON-THROWING — returns [] on any failure.
   *
   * @param {HTMLImageElement|ImageBitmap|HTMLCanvasElement|string} imageSource
   * @param {number} imgW  original image width  (pixels)
   * @param {number} imgH  original image height (pixels)
   * @returns {Promise<Array<{id:string,classId:number,className:string,x1:number,y1:number,x2:number,y2:number,score:number}>>}
   */
  async function detect(imageSource, imgW, imgH) {
    try {
      const cfg = await _loadConfig();
      const session = await load();
      if (!session) return [];
      const ort = await _loadOrt();

      const drawable = await _toDrawable(imageSource);
      // Fall back to the drawable's intrinsic size if caller omitted dims.
      const ds = _drawableSize(drawable);
      const W = imgW || ds.w;
      const H = imgH || ds.h;
      if (!W || !H) {
        console.warn('Detector: detect() called with unknown image dimensions.');
        return [];
      }

      const size = cfg.inputSize;
      const { tensor, scale, padX, padY } = _letterbox(drawable, size);

      const inputTensor = new ort.Tensor('float32', tensor, [1, 3, size, size]);
      const inputName = session.inputNames[0];
      const feeds = {};
      feeds[inputName] = inputTensor;

      const results = await session.run(feeds);
      const outName = session.outputNames[0];
      const output = results[outName];
      const { rows, attrs, at } = _orientOutput(output.data, output.dims);

      const nc = attrs - 4;             // number of class scores (>=1)
      const classAware = !!cfg.classAware && nc > 1;
      const conf = cfg.confThreshold;   // LOW → over-detect
      const raw = [];

      for (let i = 0; i < rows; i++) {
        const cx = at(i, 0);
        const cy = at(i, 1);
        const bw = at(i, 2);
        const bh = at(i, 3);

        // Score: classAware → best class prob; else max over the class block
        // (single-class export → that one prob acts as objectness).
        let score = 0;
        if (classAware) {
          for (let c = 0; c < nc; c++) {
            const s = at(i, 4 + c);
            if (s > score) score = s;
          }
        } else {
          if (nc === 1) {
            score = at(i, 4);
          } else {
            for (let c = 0; c < nc; c++) {
              const s = at(i, 4 + c);
              if (s > score) score = s;
            }
          }
        }
        if (score < conf) continue;

        // cx,cy,w,h are in letterboxed INPUT space → undo pad + scale → image px.
        let x1 = (cx - bw / 2 - padX) / scale;
        let y1 = (cy - bh / 2 - padY) / scale;
        let x2 = (cx + bw / 2 - padX) / scale;
        let y2 = (cy + bh / 2 - padY) / scale;

        // Clamp to image bounds.
        x1 = Math.max(0, Math.min(W, x1));
        y1 = Math.max(0, Math.min(H, y1));
        x2 = Math.max(0, Math.min(W, x2));
        y2 = Math.max(0, Math.min(H, y2));
        if (x2 - x1 < 1 || y2 - y1 < 1) continue;

        raw.push({ x1, y1, x2, y2, score });
      }

      const kept = _nms(raw, cfg.iouThreshold, cfg.maxBoxes);

      // Detect-only: emit the neutral default class for every box. The expert
      // re-labels each one; we never trust a real class from the model.
      const className = (typeof CLASS_MAP !== 'undefined' && CLASS_MAP[DEFAULT_CLASS_ID]) || 'B2';
      return kept.map((b, i) => ({
        id: 'det' + i,
        classId: DEFAULT_CLASS_ID,
        className,
        x1: b.x1,
        y1: b.y1,
        x2: b.x2,
        y2: b.y2,
        score: b.score,
      }));
    } catch (err) {
      console.warn('Detector: detect() failed —', err);
      return [];
    }
  }

  /**
   * Convenience: detect on an ActiveSession side. Resolves the side image URL
   * (prefers side.imageUrl; falls back to DatasetManager.imageUrlForSide on the
   * matching dataset side for native) and returns boxes in image pixel coords.
   * NON-THROWING — returns [] when the URL or dimensions cannot be resolved.
   *
   * @param {object} side  an ActiveSession side
   * @returns {Promise<Array>} editor-shaped bboxes
   */
  async function detectForSide(side) {
    try {
      if (!side) return [];
      let url = side.imageUrl;
      if (!url && typeof DatasetManager !== 'undefined') {
        // Native sides carry no blob URL — derive one from the dataset tree side.
        const dTree = DatasetManager.getTree && DatasetManager.getTree();
        const dSide = dTree && dTree.sides ? dTree.sides[side.sideIndex] : null;
        if (dSide) url = DatasetManager.imageUrlForSide(dSide);
      }
      if (!url) {
        console.warn('Detector: detectForSide() could not resolve an image URL for side', side.sideIndex);
        return [];
      }
      return await detect(url, side.imageWidth, side.imageHeight);
    } catch (err) {
      console.warn('Detector: detectForSide() failed —', err);
      return [];
    }
  }

  /**
   * The resolved config (merged over defaults). Returns a snapshot copy, or the
   * defaults if config has not been loaded yet.
   */
  function getConfig() {
    return { ...(_config || DEFAULT_CONFIG) };
  }

  return { isAvailable, load, detect, detectForSide, getConfig };
})();

window.Detector = Detector;
