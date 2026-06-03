'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom } from './dom-stub.mjs';

class InstantImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.naturalWidth = 1000;
    this.naturalHeight = 1000;
  }

  get src() { return this._src; }
  set src(value) {
    this._src = value;
    setTimeout(() => {
      if (this.onload) this.onload();
    }, 0);
  }
}

class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    this.connected = true;
  }

  observe() {}
  disconnect() {
    this.connected = false;
  }
}

function loadEditor() {
  const dom = makeDom();
  const ctx = loadModule(['js/yolo-io.js', 'js/canvas.js', 'js/bbox-editor.js'], {
    globals: {
      document: dom.document,
      Image: InstantImage,
      ResizeObserver: FakeResizeObserver,
      devicePixelRatio: 1,
      innerWidth: 1280,
      innerHeight: 800,
    },
  });
  const canvas = dom.document.createElement('canvas');
  canvas.clientWidth = 1000;
  canvas.clientHeight = 1000;
  dom.document.body.appendChild(canvas);
  return { ctx, dom, canvas };
}

function pointer(canvas, type, x, y, pointerType = 'mouse') {
  canvas.dispatchEvent({
    type,
    pointerId: 1,
    pointerType,
    clientX: x,
    clientY: y,
    target: canvas,
  });
}

async function tick() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('BBoxEditor draws, reclasses, and deletes a bbox through pointer/touch-safe API', async () => {
  const { ctx, canvas } = loadEditor();
  const updates = [];
  const classChanges = [];
  const editor = ctx.BBoxEditor.create(
    canvas,
    'img://side-1',
    [],
    bboxes => updates.push(bboxes),
    (bboxId, classId) => classChanges.push({ bboxId, classId })
  );
  await tick();

  pointer(canvas, 'pointerdown', 10, 10);
  pointer(canvas, 'pointermove', 120, 120);
  pointer(canvas, 'pointerup', 120, 120);

  assert.equal(updates.at(-1).length, 1);
  assert.equal(updates.at(-1)[0].className, 'B2');
  assert.equal(editor.getSelectedId(), updates.at(-1)[0].id);

  editor.setSelectedClass(2);
  assert.equal(updates.at(-1)[0].className, 'B3');
  assert.deepEqual(classChanges.at(-1), { bboxId: updates.at(-1)[0].id, classId: 2 });

  editor.deleteSelected();
  assert.equal(updates.at(-1).length, 0);
  editor.destroy();
  assert.equal(canvas.style.touchAction, undefined);
});

test('BBoxEditor._render survives a resize before the image loads (tr still null)', async () => {
  // Regression: on-device, a layout pass (ResizeObserver) fired before img.onload,
  // so _rebuildTransforms left tr=null and _render threw an uncaught
  // "Cannot read properties of null (reading 'scaleToCanvas')", aborting the
  // editor pipeline. The guard in _render must make this a no-op, not a throw.
  let capturedResize = null;
  class CapturingResizeObserver {
    constructor(cb) { capturedResize = cb; }
    observe() {}
    disconnect() {}
  }
  // An image whose onload never fires → image and tr stay null.
  class NeverImage {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
    set src(_v) { /* never invokes onload */ }
    get src() { return this._src; }
  }

  const dom = makeDom();
  const ctx = loadModule(['js/yolo-io.js', 'js/canvas.js', 'js/bbox-editor.js'], {
    globals: {
      document: dom.document,
      Image: NeverImage,
      ResizeObserver: CapturingResizeObserver,
      devicePixelRatio: 1,
      innerWidth: 1280,
      innerHeight: 800,
    },
  });
  const canvas = dom.document.createElement('canvas');
  canvas.clientWidth = 1000;
  canvas.clientHeight = 1000;
  dom.document.body.appendChild(canvas);

  ctx.BBoxEditor.create(canvas, 'img://never', [], () => {});
  assert.equal(typeof capturedResize, 'function');
  // Firing the resize before the image has loaded must NOT throw.
  assert.doesNotThrow(() => capturedResize());
});

test('BBoxEditor ignores sub-minimum accidental drags on touch screens', async () => {
  const { ctx, canvas } = loadEditor();
  const updates = [];
  ctx.BBoxEditor.create(
    canvas,
    'img://side-1',
    [],
    bboxes => updates.push(bboxes)
  );
  await tick();

  pointer(canvas, 'pointerdown', 10, 10, 'touch');
  pointer(canvas, 'pointermove', 12, 12, 'touch');
  pointer(canvas, 'pointerup', 12, 12, 'touch');

  assert.equal(updates.length, 0);
});
