'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom } from './dom-stub.mjs';

function loadViewer(globals = {}) {
  return loadModule('js/viewer/depth-viewer.js', {
    globals: { Uint16Array, Uint8Array, ...globals },
  });
}

test('DepthViewer._toUint16 decodes raw little-endian uint16', () => {
  const { DepthViewer } = loadViewer();
  const u = DepthViewer._toUint16(new Uint8Array([1, 0, 0, 1, 0xFF, 0xFF]));
  assert.deepEqual([...u], [1, 256, 65535]);
});

test('DepthViewer._range ignores invalid/out-of-display-range depth and scales to mm', () => {
  const { DepthViewer } = loadViewer();
  const r = DepthViewer._range(new Uint16Array([0, 150, 0, 300, 8000, 65535, 100]), 2);
  assert.equal(r.minMm, 300);
  assert.equal(r.maxMm, 600);
  assert.equal(r.valid, 2);
  assert.equal(r.displayFloorMm, 250);
  assert.equal(r.displayCeilingMm, 7000);
});

test('DepthViewer._range uses robust P2-P98 instead of raw min/max', () => {
  const { DepthViewer } = loadViewer();
  const samples = [];
  for (let i = 0; i < 96; i++) samples.push(1000);
  samples.push(250, 250, 7000, 7000);
  const r = DepthViewer._range(new Uint16Array(samples), 1);
  assert.equal(r.minMm, 1000);
  assert.equal(r.maxMm, 1000 + 1);
  assert.equal(r.observedMinMm, 250);
  assert.equal(r.observedMaxMm, 7000);
});

test('DepthViewer._depthColor maps invalid/out-of-display-range depth to black and valid depth into the colormap', () => {
  const { DepthViewer } = loadViewer();
  assert.deepEqual(DepthViewer._depthColor(0, 0, 1000), [0, 0, 0]);
  assert.deepEqual(DepthViewer._depthColor(249, 0, 1000), [0, 0, 0]);
  assert.deepEqual(DepthViewer._depthColor(7001, 0, 8000), [0, 0, 0]);
  const mid = DepthViewer._depthColor(500, 0, 1000);
  assert.equal(mid.length, 3);
  assert.ok(mid.some(c => c > 0), 'a valid depth gets a non-black color');
});

test('DepthViewer.open renders per-side tabs, reads depth bytes + JSON, and reports the valid range', async () => {
  const dom = makeDom();
  // 2x2 depth: 1000, 0(invalid), 2000, 1500 mm (valueScale 1), little-endian.
  const bytes = new Uint8Array([0xE8, 0x03, 0x00, 0x00, 0xD0, 0x07, 0xDC, 0x05]);
  const reads = [];
  const adapter = {
    async readDatasetBinary(ref) { reads.push(ref); return bytes; },
    async readDatasetJsonAt() { return null; },
  };
  const tree = {
    name: 'DAMIMAS_A_0001',
    metadata: { variety: 'DAMIMAS', operator: 'me' },
    sides: [
      { depthUri: 'file:///d1.raw', depth: { width: 2, height: 2, valueScale: 1, unit: 'mm', format: 'Y16' } },
      { /* built-in camera side, no depth */ },
    ],
  };

  const { DepthViewer } = loadModule('js/viewer/depth-viewer.js', {
    globals: {
      document: dom.document,
      Uint16Array, Uint8Array,
      Storage: { active: () => adapter },
      Capacitor: { convertFileSrc: u => u },
    },
  });

  const handle = DepthViewer.open(tree);
  assert.ok(handle, 'open returns a handle');

  const overlay = dom.document.querySelector('.depth-viewer');
  assert.ok(overlay, 'viewer overlay mounted');
  assert.equal(dom.document.querySelectorAll('.depth-viewer__tab').length, 2, 'one tab per side');

  // Deterministically render side 0 (depth present).
  await handle._selectSide(0);
  assert.equal(reads[0], 'file:///d1.raw', 'read the side depth uri');
  const legend = dom.document.querySelector('.depth-viewer__legend');
  assert.match(legend.textContent, /3 valid px/);
  assert.match(legend.textContent, /2×2/);
  const json = dom.document.querySelector('.depth-viewer__json');
  assert.match(json.textContent, /DAMIMAS/, 'tree metadata JSON shown');
  assert.match(json.textContent, /"valueScale": 1/, 'depth sidecar JSON shown');

  // Side 1 has no depth → a clear notice, no crash.
  await handle._selectSide(1);
  const notice = dom.document.querySelector('.depth-viewer__notice');
  assert.match(notice.textContent, /No depth/);

  // Close tears the overlay down.
  dom.document.querySelector('.depth-viewer__close').click();
  assert.equal(dom.document.querySelector('.depth-viewer'), null);
});

test('DepthViewer.open is a no-op for a tree without sides', () => {
  const dom = makeDom();
  const { DepthViewer } = loadModule('js/viewer/depth-viewer.js', {
    globals: { document: dom.document, Uint16Array, Uint8Array, console: { ...console, info() {} } },
  });
  assert.equal(DepthViewer.open({ name: 'x', sides: [] }), null);
  assert.equal(dom.document.querySelector('.depth-viewer'), null);
});
