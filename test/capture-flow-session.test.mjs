'use strict';

// Coverage for CaptureFlow's session-locked mode + new file naming
// (Phase 1 of the capture-flow rework). We drive the real per-pohon panel:
// locked variety/blok badge, tree-id field, then two side captures, and assert
// the resulting tree name + persisted paths follow VARIETY_BLOK_0001.

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
  const btn = (label) => waitFor(() => findByText(dom.document.body, 'button', label));
  return { dom, calls, done, btn };
}

test('session-locked capture names the tree VARIETY_BLOK_0001 and persists matching paths', async () => {
  const { calls, done, btn } = driveCapture({
    sideCount: 2,
    session: { variety: 'DAMIMAS', blok: 'A 21B', treeId: 1, autoId: true },
  });

  // Locked metadata panel → start the per-side capture.
  (await btn('Start Capture')).click();

  // Two sides: Capture → Use Photo each.
  for (let i = 0; i < 2; i++) {
    (await btn('Capture')).click();
    (await btn('Use Photo')).click();
  }

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
  const { dom, done, btn } = driveCapture({
    sideCount: 2,
    session: { variety: 'TENERA', blok: 'b-07', treeId: 5, autoId: false },
  });

  // Manual mode: the tree-id input is editable; change it before capturing.
  await btn('Start Capture');
  const idInput = dom.document.body.querySelector('.capture-input');
  assert.ok(idInput, 'manual mode exposes an editable tree-id input');
  assert.equal(idInput.type, 'number', 'manual mode tree-id input is numeric');
  idInput.value = '42';

  (await btn('Start Capture')).click();
  for (let i = 0; i < 2; i++) {
    (await btn('Capture')).click();
    (await btn('Use Photo')).click();
  }

  const tree = await done;
  assert.equal(tree.name, 'TENERA_B07_0042', 'blok "b-07" → B07, id 42 → 0042');
  assert.equal(tree.treeId, 42);
});

test('cancelling the locked panel resolves null without persisting', async () => {
  const { calls, done, btn } = driveCapture({
    sideCount: 2,
    session: { variety: 'DAMIMAS', blok: 'A21B', treeId: 1, autoId: true },
  });

  (await btn('Cancel')).click();
  const tree = await done;
  assert.equal(tree, null);
  assert.equal(calls.images.length, 0);
});
