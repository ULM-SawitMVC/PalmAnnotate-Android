'use strict';

// Coverage for CaptureFlow's session-locked mode + file naming (capture rework).
// Session mode jumps STRAIGHT to the embedded camera (no metadata screen, no
// per-side review): we drive the popup-free capture surface — Capture per side,
// then the single end-of-capture Save — and assert the tree name + persisted
// paths follow VARIETY_BLOK_0001.

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, findByText, waitFor } from './dom-stub.mjs';

function driveCapture({ session, sideCount }) {
  const dom = makeDom();
  const calls = { images: [], json: [] };
  const quiet = { ...console, info() {}, warn() {} };

  const ctx = loadModule('js/capture/capture-flow.js', {
    globals: {
      document: dom.document,
      navigator: {},
      console: quiet,
      URL: { createObjectURL: () => 'blob://x', revokeObjectURL() {} },
      CaptureSources: { default: () => ({ async capture() { return { blob: {}, width: 10, height: 10 }; } }) },
      Storage: {
        active: () => ({
          async persistDatasetImage(rel) { calls.images.push(rel); return { uri: 'file://' + rel, file: null }; },
          async writeDatasetJson(rel, obj) { calls.json.push({ rel, obj }); },
        }),
      },
    },
  });

  const done = ctx.CaptureFlow.start({ sideCount, session });
  const body = dom.document.body;
  const btn = (label) => waitFor(() => findByText(body, 'button', label));
  const title = (text) => waitFor(() => findByText(body, 'h2', text));
  return { dom, calls, done, btn, title };
}

// Capture every side (popup-free) then Save, sequencing on the side indicator.
async function shootAllSides(btn, title, sideCount) {
  for (let i = 1; i <= sideCount; i++) {
    (await btn('Capture')).click();
    if (i < sideCount) await title(`Side ${i + 1} / ${sideCount}`);
  }
  (await btn('Save')).click();
}

test('session-locked capture names the tree VARIETY_BLOK_0001 and persists matching paths', async () => {
  const { calls, done, btn, title } = driveCapture({
    sideCount: 2,
    session: { variety: 'DAMIMAS', blok: 'A 21B', treeId: 1, autoId: true },
  });

  // No metadata screen in session mode — the camera surface appears directly.
  await shootAllSides(btn, title, 2);

  const tree = await done;
  assert.equal(tree.name, 'DAMIMAS_A21B_0001');
  assert.equal(tree.treeId, 1);
  assert.equal(tree.sideCount, 2);
  assert.equal(tree.metadata.variety, 'DAMIMAS');
  assert.equal(tree.metadata.blok, 'A 21B');

  // Side image filenames carry the side suffix; GT json drops it.
  assert.deepEqual(calls.images, [
    'images/field/DAMIMAS_A21B_0001_1.jpg',
    'images/field/DAMIMAS_A21B_0001_2.jpg',
  ]);
  assert.deepEqual(calls.json.map(j => j.rel), ['metadata/DAMIMAS_A21B_0001.json']);
});

test('manual tree-id mode honours the typed id and blok is sanitized', async () => {
  const { dom, done, btn, title } = driveCapture({
    sideCount: 2,
    session: { variety: 'TENERA', blok: 'b-07', treeId: 5, autoId: false },
  });

  // Manual mode exposes an inline numeric tree-id field on the camera surface.
  const idInput = await waitFor(() => dom.document.body.querySelector('.capture-idinput'));
  assert.equal(idInput.type, 'number', 'manual mode tree-id input is numeric');
  idInput.value = '42';

  await shootAllSides(btn, title, 2);

  const tree = await done;
  assert.equal(tree.name, 'TENERA_B07_0042', 'blok "b-07" → B07, id 42 → 0042');
  assert.equal(tree.treeId, 42);
});

// Drive a native-runtime capture with a stubbed Camera plugin, recording the
// order of permission + capture calls.
function driveNativeCapture({ session, sideCount, cameraState }) {
  const dom = makeDom();
  const order = [];
  const quiet = { ...console, info() {}, warn() {} };
  const Camera = {
    async checkPermissions() { order.push('check'); return { camera: cameraState }; },
    async requestPermissions(opts) {
      order.push('request:' + (opts && opts.permissions));
      return { camera: 'granted' };
    },
  };
  const ctx = loadModule('js/capture/capture-flow.js', {
    globals: {
      document: dom.document,
      navigator: {},
      console: quiet,
      URL: { createObjectURL: () => 'blob://x', revokeObjectURL() {} },
      CaptureSources: { default: () => ({ async capture() { order.push('capture'); return { blob: {}, width: 10, height: 10 }; } }) },
      Capacitor: { Plugins: { Camera } },
      Storage: {
        isNative: () => true,
        active: () => ({
          async persistDatasetImage(rel) { return { uri: 'file://' + rel, file: null }; },
          async writeDatasetJson() {},
        }),
      },
    },
  });
  const done = ctx.CaptureFlow.start({ sideCount, session });
  const body = dom.document.body;
  const btn = (label) => waitFor(() => findByText(body, 'button', label));
  const title = (text) => waitFor(() => findByText(body, 'h2', text));
  return { order, done, btn, title };
}

test('native capture requests the CAMERA permission BEFORE streaming (avoids the WebView grant-crash + double prompt)', async () => {
  const { order, done, btn, title } = driveNativeCapture({
    sideCount: 2,
    session: { variety: 'DAMIMAS', blok: 'A21B', treeId: 1, autoId: true },
    cameraState: 'prompt',
  });
  await shootAllSides(btn, title, 2);
  await done;

  // The permission round-trip must happen before any frame is captured, so the
  // WebView's onPermissionRequest never has to request mid-stream (the crash).
  assert.equal(order[0], 'check', 'permission state checked first');
  assert.equal(order[1], 'request:camera', 'then requested up-front');
  assert.ok(order.indexOf('request:camera') < order.indexOf('capture'),
    'permission granted before the first capture');
});

test('native capture skips the permission request when CAMERA is already granted', async () => {
  const { order, done, btn, title } = driveNativeCapture({
    sideCount: 2,
    session: { variety: 'DAMIMAS', blok: 'A21B', treeId: 1, autoId: true },
    cameraState: 'granted',
  });
  await shootAllSides(btn, title, 2);
  await done;

  assert.equal(order[0], 'check', 'permission state checked');
  assert.ok(!order.some(o => o.startsWith('request:')),
    'no redundant prompt when already granted');
});

test('cancelling the live capture surface resolves null without persisting', async () => {
  const { calls, done, btn } = driveCapture({
    sideCount: 2,
    session: { variety: 'DAMIMAS', blok: 'A21B', treeId: 1, autoId: true },
  });

  (await btn('Cancel')).click();
  const tree = await done;
  assert.equal(tree, null);
  assert.equal(calls.images.length, 0);
});
