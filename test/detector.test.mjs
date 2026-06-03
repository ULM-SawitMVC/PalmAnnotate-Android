'use strict';

import { test } from 'node:test';
// Non-strict assert — see note in yolo-io.test.mjs (cross-realm vm objects).
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

// The detector's decode pipeline (letterbox-inverse, output orientation,
// thresholding, class-agnostic NMS, detect-only class override) is private to
// the IIFE. We exercise it end-to-end through the public detect() by faking the
// two heavy dependencies: onnxruntime-web (a crafted output tensor) and fetch
// (config + model-exists probes). The canvas 2d context is stubbed by the
// harness; letterbox scale/pad depend only on image vs input size, not pixels.

const CONFIG = {
  modelFile: 'ffb-detector.onnx', inputSize: 640,
  confThreshold: 0.05, iouThreshold: 0.35, maxBoxes: 300, classAware: false,
};

function fakeFetch(url) {
  const u = String(url);
  if (u.includes('detector.config.json')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => CONFIG });
  }
  return Promise.resolve({ ok: true, status: 200 }); // model HEAD/GET probe
}

function makeOrt(output) {
  return {
    env: { wasm: {} },
    Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
    InferenceSession: {
      create: async () => ({
        inputNames: ['images'],
        outputNames: ['output0'],
        run: async () => ({ output0: output }),
      }),
    },
  };
}

function loadDetector(output) {
  // Concatenate yolo-io.js so CLASS_MAP is in scope (as in the real browser),
  // making the detect-only className resolve to 'B2' via CLASS_MAP[1].
  const ctx = loadModule(['js/yolo-io.js', 'js/detect/detector.js'], {
    globals: { fetch: fakeFetch, ort: makeOrt(output) },
  });
  return ctx.Detector;
}

// Source image 1280x960 into a 640 letterbox -> scale 0.5, padX 0, padY 80.
// Inverse map: x_img = x_input/0.5,  y_img = (y_input-80)/0.5.
const DRAWABLE = { naturalWidth: 1280, naturalHeight: 960 };
const IMG_W = 1280, IMG_H = 960;

function setChannelsFirst(data, N, row, cx, cy, w, h, score) {
  data[0 * N + row] = cx; data[1 * N + row] = cy;
  data[2 * N + row] = w;  data[3 * N + row] = h;
  data[4 * N + row] = score;
}

test('detect(): thresholds, un-letterboxes, NMS-dedups, forces detect-only class', async () => {
  const N = 20, ATTRS = 5;
  const data = new Float32Array(ATTRS * N); // channels-first [1,5,20]
  // A: strong box.                          -> kept  (det0)
  setChannelsFirst(data, N, 0, 320, 240, 100, 80, 0.9);
  // B: heavily overlaps A (IoU ~0.8 > 0.35). -> suppressed by NMS
  setChannelsFirst(data, N, 1, 325, 245, 100, 80, 0.8);
  // C: separate box.                        -> kept  (det1)
  setChannelsFirst(data, N, 2, 100, 400, 60, 60, 0.5);
  // D: below confThreshold (0.04 < 0.05).   -> dropped
  setChannelsFirst(data, N, 3, 500, 300, 50, 50, 0.04);
  // E: degenerate (<1px after un-letterbox).-> dropped
  setChannelsFirst(data, N, 4, 200, 200, 0.4, 0.4, 0.9);

  const Detector = loadDetector({ data, dims: [1, ATTRS, N] });
  const boxes = await Detector.detect(DRAWABLE, IMG_W, IMG_H);

  assert.equal(boxes.length, 2, 'A and C survive; B suppressed, D/E filtered');

  const [a, c] = boxes;
  // Detect-only contract: neutral class id 1 / 'B2' on every box.
  for (const b of boxes) { assert.equal(b.classId, 1); assert.equal(b.className, 'B2'); }
  assert.deepEqual([a.id, c.id], ['det0', 'det1']);

  // A un-letterboxed: x/0.5, (y-80)/0.5.
  assert.deepEqual([a.x1, a.y1, a.x2, a.y2], [540, 240, 740, 400]);
  assert.ok(Math.abs(a.score - 0.9) < 1e-3);
  // C un-letterboxed.
  assert.deepEqual([c.x1, c.y1, c.x2, c.y2], [140, 580, 260, 700]);
  assert.ok(Math.abs(c.score - 0.5) < 1e-3);
});

test('detect(): auto-detects transposed [1,N,attrs] output orientation', async () => {
  const N = 20, ATTRS = 5;
  const data = new Float32Array(N * ATTRS); // channels-last [1,20,5]
  // single det A at row 0: data[row*5 + attr]
  data[0] = 320; data[1] = 240; data[2] = 100; data[3] = 80; data[4] = 0.9;

  const Detector = loadDetector({ data, dims: [1, N, ATTRS] });
  const boxes = await Detector.detect(DRAWABLE, IMG_W, IMG_H);

  assert.equal(boxes.length, 1);
  assert.deepEqual(
    [boxes[0].x1, boxes[0].y1, boxes[0].x2, boxes[0].y2],
    [540, 240, 740, 400]);
});

test('detect(): returns [] (non-throwing) when the model is absent', async () => {
  const ctx = loadModule(['js/yolo-io.js', 'js/detect/detector.js'], {
    globals: {
      // model probe 404s -> detection disabled, must not throw.
      fetch: (url) => String(url).includes('detector.config.json')
        ? Promise.resolve({ ok: true, status: 200, json: async () => CONFIG })
        : Promise.resolve({ ok: false, status: 404 }),
      ort: makeOrt({ data: new Float32Array(0), dims: [1, 5, 0] }),
    },
  });
  const boxes = await ctx.Detector.detect(DRAWABLE, IMG_W, IMG_H);
  assert.deepEqual(boxes, []);
});

test('isAvailable() on native sets an ABSOLUTE wasmPaths and single-thread ORT', async () => {
  // Regression for the on-device "no available backend found" failure:
  //  - wasmPaths must be absolute (a bare "vendor/onnxruntime/" specifier makes
  //    ORT's dynamic import() of the wasm proxy fail to resolve), and
  //  - numThreads must be 1 (the WebView is not cross-origin isolated, so there
  //    is no SharedArrayBuffer for worker threads).
  const holder = {};
  const fakeOrt = { env: { wasm: {} } };
  // Simulate <script> injection: appending the script makes window.ort appear
  // and fires onload synchronously, exactly like the real ORT runtime bundle.
  const doc = {
    baseURI: 'https://localhost/',
    head: {
      appendChild(el) { holder.ctx.ort = fakeOrt; if (el.onload) el.onload(); },
    },
    createElement(tag) {
      if (String(tag).toLowerCase() === 'script') return { src: '', async: false, onload: null, onerror: null };
      return { style: {}, appendChild() {}, setAttribute() {} };
    },
  };

  const ctx = loadModule(['js/yolo-io.js', 'js/detect/detector.js'], {
    globals: {
      fetch: fakeFetch,                                  // config + model probe OK
      ort: undefined,                                    // force the inject path
      document: doc,
      Capacitor: { isNativePlatform: () => true },       // native runtime branch
    },
  });
  holder.ctx = ctx;

  const ok = await ctx.Detector.isAvailable();
  assert.equal(ok, true);
  assert.equal(ctx.ort.env.wasm.wasmPaths, 'https://localhost/vendor/onnxruntime/');
  assert.equal(ctx.ort.env.wasm.numThreads, 1);
});

test('getConfig() exposes the detect-only defaults before any load', () => {
  const ctx = loadModule(['js/yolo-io.js', 'js/detect/detector.js']);
  const cfg = ctx.Detector.getConfig();
  assert.equal(cfg.modelFile, 'ffb-detector.onnx');
  assert.equal(cfg.classAware, false);
  assert.equal(cfg.inputSize, 640);
});
