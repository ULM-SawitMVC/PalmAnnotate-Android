'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, findByText, getByText, waitFor } from './dom-stub.mjs';

function makeCaptureContext(shots, opts = {}) {
  const dom = makeDom();
  const writes = { images: [], files: [], metadata: [], deletes: [] };
  const adapter = {
    async persistDatasetImage(relPath, blob) {
      writes.images.push({ relPath, blob });
      if (opts.persistNoUri) return {};
      return {
        uri: 'native://documents/PalmAnnotate/dataset/' + relPath,
        file: { name: relPath.split('/').pop(), relPath },
      };
    },
    async persistDatasetFile(relPath, blob, fallback) {
      writes.files.push({ relPath, blob, fallback });
      return {
        uri: 'native://documents/PalmAnnotate/dataset/' + relPath,
        path: 'PalmAnnotate/dataset/' + relPath,
      };
    },
    async writeDatasetJson(relPath, data) {
      writes.metadata.push({ relPath, data });
      return { ok: true };
    },
    async deleteDatasetTree(treeName, sideCount) {
      writes.deletes.push({ treeName, sideCount });
      return { ok: true, removed: 0 };
    },
  };
  // A one-shot source (no live preview) — the embedded flow renders a Capture
  // button per side and calls source.capture().
  const source = {
    id: 'test-camera',
    async capture() {
      return shots.shift() || null;
    },
  };
  const urls = [];
  const URLStub = {
    createObjectURL(blob) {
      const url = 'blob://shot-' + urls.length;
      urls.push({ url, blob });
      return url;
    },
    revokeObjectURL(url) {
      const hit = urls.find(item => item.url === url);
      if (hit) hit.revoked = true;
    },
  };
  const ctx = loadModule('js/capture/capture-flow.js', {
    globals: {
      document: dom.document,
      navigator: {},
      URL: URLStub,
      CaptureSources: {
        default: () => source,
        list: () => opts.sources || [source],
      },
      Storage: { active: () => adapter, isNative: () => !!opts.native },
    },
  });
  return { ctx, dom, writes, urls };
}

function waitButton(root, text) {
  return waitFor(() => findByText(root, 'button', text));
}

function waitTitle(root, text) {
  return waitFor(() => findByText(root, 'h2', text));
}

test('CaptureFlow captures a multi-side field tree (popup-free) and persists it under dataset paths', async () => {
  const shots = [
    { blob: new Blob(['side1'], { type: 'image/jpeg' }), width: 1000, height: 800 },
    { blob: new Blob(['side2'], { type: 'image/jpeg' }), width: 1000, height: 800 },
  ];
  const { ctx, dom, writes } = makeCaptureContext(shots);
  const body = dom.document.body;
  const progress = [];
  let readyTree = null;

  const promise = ctx.CaptureFlow.start({
    sideCount: 2,
    onProgress: (step, total) => progress.push([step, total]),
    onTreeReady: tree => { readyTree = tree; },
  });

  // Freeform metadata → start the embedded capture surface.
  dom.document.querySelector('select').value = 'DAMIMAS';
  getByText(body, 'button', 'Start Capture').click();

  // Side 1 → side 2 with NO per-side confirm; the indicator advances each shot.
  (await waitButton(body, 'Capture')).click();
  await waitTitle(body, 'Side 2 / 2');
  (await waitButton(body, 'Capture')).click();

  // Single end-of-capture review → Save.
  (await waitButton(body, 'Save')).click();

  const tree = await promise;
  assert.ok(tree);
  assert.match(tree.name, /^DAMIMAS_\d{8}_\d{3}$/);
  assert.equal(tree.split, 'field');
  assert.equal(tree.sides.length, 2);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.equal(readyTree, tree);

  assert.deepEqual(
    writes.images.map(w => w.relPath),
    [`images/field/${tree.name}_1.jpg`, `images/field/${tree.name}_2.jpg`]
  );
  assert.equal(writes.metadata.length, 1);
  assert.equal(writes.metadata[0].relPath, `metadata/${tree.name}.json`);
  assert.equal(writes.metadata[0].data.variety, 'DAMIMAS');
  assert.equal(tree.sides[0].imageUri, 'native://documents/PalmAnnotate/dataset/' + writes.images[0].relPath);
  assert.equal(dom.document.body.children.length, 0, 'capture overlay is removed after completion');
});

test('CaptureFlow aborts native capture when app-storage photo persistence returns no uri', async () => {
  const shots = [
    { blob: new Blob(['side1'], { type: 'image/jpeg' }), width: 1000, height: 800 },
    { blob: new Blob(['side2'], { type: 'image/jpeg' }), width: 1000, height: 800 },
  ];
  const { ctx, dom, writes } = makeCaptureContext(shots, { native: true, persistNoUri: true });
  const body = dom.document.body;

  const promise = ctx.CaptureFlow.start({ sideCount: 2 });
  dom.document.querySelector('select').value = 'DAMIMAS';
  getByText(body, 'button', 'Start Capture').click();
  (await waitButton(body, 'Capture')).click();
  await waitTitle(body, 'Side 2 / 2');
  (await waitButton(body, 'Capture')).click();
  (await waitButton(body, 'Save')).click();

  const tree = await promise;
  assert.equal(tree, null, 'broken native persist must not record a reusable stale tree');
  assert.equal(writes.images.length, 1, 'persist was attempted');
  assert.equal(writes.metadata.length, 0, 'metadata is not written after image persist failure');
  assert.equal(dom.document.body.children.length, 0, 'capture overlay is removed after failure');
});

test('CaptureFlow cancel from the live capture surface leaves no dataset writes', async () => {
  const { ctx, dom, writes } = makeCaptureContext([
    { blob: new Blob(['unused']), width: 100, height: 100 },
  ]);
  const body = dom.document.body;

  const promise = ctx.CaptureFlow.start({ sideCount: 4 });
  getByText(body, 'button', 'Start Capture').click();
  await waitButton(body, 'Capture');
  getByText(body, 'button', 'Cancel').click();

  const tree = await promise;
  assert.equal(tree, null);
  assert.deepEqual(writes.images, []);
  assert.deepEqual(writes.metadata, []);
  assert.equal(dom.document.body.children.length, 0, 'capture overlay is removed after cancel');
});

test('CaptureFlow review lets the operator retake one side before saving', async () => {
  const shots = [
    { blob: new Blob(['s1'], { type: 'image/jpeg' }), width: 100, height: 100 },
    { blob: new Blob(['s2'], { type: 'image/jpeg' }), width: 100, height: 100 },
    { blob: new Blob(['s1-retake'], { type: 'image/jpeg' }), width: 100, height: 100 },
  ];
  const { ctx, dom, writes } = makeCaptureContext(shots);
  const body = dom.document.body;

  const promise = ctx.CaptureFlow.start({ sideCount: 2 });
  dom.document.querySelector('select').value = 'DAMIMAS';
  getByText(body, 'button', 'Start Capture').click();

  (await waitButton(body, 'Capture')).click();
  await waitTitle(body, 'Side 2 / 2');
  (await waitButton(body, 'Capture')).click();

  // Review → retake side 1 → back to the live surface for that side only.
  (await waitButton(body, 'Retake')).click();
  (await waitButton(body, 'Capture')).click();

  // Back at review → Save.
  (await waitButton(body, 'Save')).click();

  const tree = await promise;
  assert.ok(tree);
  assert.equal(tree.sides.length, 2);
  // Three frames were grabbed (2 + 1 retake) but only 2 sides are persisted.
  assert.equal(writes.images.length, 2);
  assert.equal(shots.length, 0, 'all three queued frames were consumed');
});
