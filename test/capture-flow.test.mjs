'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, findByText, getByText, waitFor } from './dom-stub.mjs';

function makeCaptureContext(shots) {
  const dom = makeDom();
  const writes = { images: [], metadata: [] };
  const adapter = {
    async persistDatasetImage(relPath, blob) {
      writes.images.push({ relPath, blob });
      return {
        uri: 'native://documents/PalmAnnotate/dataset/' + relPath,
        file: { name: relPath.split('/').pop(), relPath },
      };
    },
    async writeDatasetJson(relPath, data) {
      writes.metadata.push({ relPath, data });
      return { ok: true };
    },
  };
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
      CaptureSources: { default: () => source },
      Storage: { active: () => adapter },
    },
  });
  return { ctx, dom, writes, urls };
}

function waitButton(root, text) {
  return waitFor(() => findByText(root, 'button', text));
}

test('CaptureFlow captures a multi-side field tree and persists it under dataset paths', async () => {
  const shots = [
    { blob: new Blob(['side1'], { type: 'image/jpeg' }), width: 1000, height: 800 },
    { blob: new Blob(['side2'], { type: 'image/jpeg' }), width: 1000, height: 800 },
  ];
  const { ctx, dom, writes } = makeCaptureContext(shots);
  const progress = [];
  let readyTree = null;

  const promise = ctx.CaptureFlow.start({
    sideCount: 2,
    onProgress: (step, total) => progress.push([step, total]),
    onTreeReady: tree => { readyTree = tree; },
  });

  dom.document.querySelector('select').value = 'DAMIMAS';
  getByText(dom.document.body, 'button', 'Start Capture').click();

  (await waitButton(dom.document.body, 'Capture')).click();
  (await waitButton(dom.document.body, 'Use Photo')).click();

  (await waitButton(dom.document.body, 'Capture')).click();
  (await waitButton(dom.document.body, 'Use Photo')).click();

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

test('CaptureFlow cancel from side capture leaves no dataset writes', async () => {
  const { ctx, dom, writes } = makeCaptureContext([
    { blob: new Blob(['unused']), width: 100, height: 100 },
  ]);

  const promise = ctx.CaptureFlow.start({ sideCount: 4 });
  getByText(dom.document.body, 'button', 'Start Capture').click();
  await waitButton(dom.document.body, 'Capture');
  getByText(dom.document.body, 'button', 'Cancel').click();

  const tree = await promise;
  assert.equal(tree, null);
  assert.deepEqual(writes.images, []);
  assert.deepEqual(writes.metadata, []);
  assert.equal(dom.document.body.children.length, 0, 'capture overlay is removed after cancel');
});
