'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, waitFor } from './dom-stub.mjs';

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

function bbox(id, classId, coords) {
  const names = ['B1', 'B2', 'B3', 'B4'];
  const [x1, y1, x2, y2] = coords || [10, 10, 110, 110];
  return { id, classId, className: names[classId], x1, y1, x2, y2 };
}

function makeState() {
  return {
    sides: [
      { sideIndex: 0, imageUrl: 'img://side-1', bboxes: [bbox('a', 0)] },
      { sideIndex: 1, imageUrl: 'img://side-2', bboxes: [bbox('b', 1)] },
      { sideIndex: 2, imageUrl: 'img://side-3', bboxes: [] },
      { sideIndex: 3, imageUrl: 'img://side-4', bboxes: [] },
    ],
    confirmedLinks: [],
    suggestedLinks: [],
    dirty: false,
  };
}

function loadCarousel(state = makeState()) {
  const dom = makeDom();
  const calls = [];
  let linkSeq = 0;
  const ActiveSession = {
    get: () => state,
    setBboxClass(sideIndex, bboxId, classId, opts) {
      calls.push({ fn: 'setBboxClass', sideIndex, bboxId, classId, opts });
      const box = state.sides[sideIndex].bboxes.find(b => b.id === bboxId);
      if (box) {
        box.classId = classId;
        box.className = ['B1', 'B2', 'B3', 'B4'][classId];
      }
      state.dirty = true;
    },
    removeBbox(sideIndex, bboxId) {
      calls.push({ fn: 'removeBbox', sideIndex, bboxId });
      state.sides[sideIndex].bboxes = state.sides[sideIndex].bboxes.filter(b => b.id !== bboxId);
      state.confirmedLinks = state.confirmedLinks.filter(
        l => !((l.sideA === sideIndex && l.bboxIdA === bboxId) || (l.sideB === sideIndex && l.bboxIdB === bboxId))
      );
      state.dirty = true;
    },
    addManualLink(sideA, bboxIdA, sideB, bboxIdB) {
      calls.push({ fn: 'addManualLink', sideA, bboxIdA, sideB, bboxIdB });
      const adjacent = [[0, 1], [1, 2], [2, 3], [3, 0]].some(
        ([a, b]) => (a === sideA && b === sideB) || (a === sideB && b === sideA)
      );
      if (!adjacent) return null;
      const link = { linkId: 'lnk-' + (++linkSeq), sideA, bboxIdA, sideB, bboxIdB };
      state.confirmedLinks.push(link);
      state.dirty = true;
      return link;
    },
    removeConfirmedLink(linkId) {
      calls.push({ fn: 'removeConfirmedLink', linkId });
      state.confirmedLinks = state.confirmedLinks.filter(l => l.linkId !== linkId);
      state.dirty = true;
    },
    propagateClassFromBox() {},
  };

  const ctx = loadModule(['js/canvas.js', 'js/carousel/carousel-ui.js'], {
    globals: {
      document: dom.document,
      Image: InstantImage,
      devicePixelRatio: 1,
      requestAnimationFrame: cb => cb(),
      ActiveSession,
      DatasetManager: { imageUrlForSide: side => side && side.imageUrl },
      TREE_SIDE_LABELS: ['Side 1', 'Side 2', 'Side 3', 'Side 4'],
      ADJACENT_PAIRS: [[0, 1], [1, 2], [2, 3], [3, 0]],
      CLASS_MAP: { 0: 'B1', 1: 'B2', 2: 'B3', 3: 'B4' },
      BBoxEditor: {
        create() {
          return {
            destroy() {},
            syncBboxes() {},
            getSelectedId() { return null; },
            setSelectedClass() {},
            deleteSelected() {},
          };
        },
      },
    },
  });

  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  ctx.CarouselUI.init(container);
  return { ctx, dom, state, calls, container };
}

function pointer(el, type, x, y, extra = {}) {
  el.dispatchEvent({
    type,
    pointerId: 1,
    pointerType: extra.pointerType || 'touch',
    clientX: x,
    clientY: y,
    target: extra.target || el,
  });
}

async function waitForImageRender() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('CarouselUI touch review lets operator select a box, change class, and delete it', async () => {
  const { dom, state, calls } = loadCarousel();
  await waitForImageRender();

  const stage = dom.document.querySelector('.carousel-stage');
  const canvas = dom.document.querySelector('.carousel-canvas');
  pointer(stage, 'pointerdown', 20, 20, { target: canvas });
  pointer(stage, 'pointerup', 20, 20, { target: canvas });

  const classChip = dom.document.querySelector('[data-class="2"]');
  assert.equal(classChip.disabled, false);
  classChip.click();

  assert.equal(state.sides[0].bboxes[0].classId, 2);
  assert.equal(state.sides[0].bboxes[0].className, 'B3');
  assert.equal(calls.some(c => c.fn === 'setBboxClass' && c.opts && c.opts.propagate), true);

  dom.document.querySelector('[data-role="delete"]').click();
  assert.equal(state.sides[0].bboxes.length, 0);
  assert.equal(calls.some(c => c.fn === 'removeBbox' && c.bboxId === 'a'), true);
});

test('CarouselUI links adjacent sides and removes the link from the touch list', async () => {
  const { ctx, dom, state, calls } = loadCarousel();
  await waitForImageRender();

  const stage = dom.document.querySelector('.carousel-stage');
  const canvas = dom.document.querySelector('.carousel-canvas');
  pointer(stage, 'pointerdown', 20, 20, { target: canvas });
  pointer(stage, 'pointerup', 20, 20, { target: canvas });
  dom.document.querySelector('[data-role="link"]').click();

  ctx.CarouselUI.goToSide(1);
  await waitForImageRender();
  pointer(stage, 'pointerdown', 20, 20, { target: canvas });
  pointer(stage, 'pointerup', 20, 20, { target: canvas });

  assert.equal(state.confirmedLinks.length, 1);
  assert.equal(state.confirmedLinks[0].bboxIdA, 'a');
  assert.equal(state.confirmedLinks[0].bboxIdB, 'b');
  assert.equal(calls.some(c => c.fn === 'addManualLink' && c.sideA === 0 && c.sideB === 1), true);

  dom.document.querySelector('.crsl-link-del').click();
  assert.equal(state.confirmedLinks.length, 0);
  assert.equal(calls.some(c => c.fn === 'removeConfirmedLink'), true);
});

test('CarouselUI renders host-hook chrome (Home/More + action row) and fires the hooks', async () => {
  const { ctx, dom, container } = loadCarousel();
  const fired = [];
  ctx.CarouselUI.init(container, {
    hooks: {
      onHome: () => fired.push('home'),
      onMore: () => fired.push('more'),
      onBrowsePrev: () => fired.push('prev'),
      onBrowseNext: () => fired.push('next'),
      onDetect: () => fired.push('detect'),
      onNextTree: () => fired.push('nexttree'),
      onSaveExit: () => fired.push('saveexit'),
      treeLabel: 'DAMIMAS_A21B_0001',
    },
  });
  await waitForImageRender();

  // Compact topbar: tree label + Home/browse buttons.
  assert.equal(dom.document.querySelector('.crsl-treelabel').textContent, 'DAMIMAS_A21B_0001');
  const nav = dom.document.querySelector('.crsl-topnav');
  assert.ok(nav, 'compact topbar nav is rendered');
  assert.equal(nav.querySelectorAll('.crsl-topbtn').length, 3,
    'home + browse prev + browse next');

  // Bottom action row: Detect again / Save & exit / Next tree.
  assert.ok(dom.document.querySelector('.crsl-action--detect'));
  assert.ok(dom.document.querySelector('.crsl-action--next'));
  assert.ok(dom.document.querySelector('.crsl-action--save'));

  dom.document.querySelector('.crsl-topbtn--home').click();
  dom.document.querySelector('.crsl-topbtn--more').click();
  dom.document.querySelector('.crsl-action--detect').click();
  dom.document.querySelector('.crsl-action--next').click();
  dom.document.querySelector('.crsl-action--save').click();
  assert.deepEqual(fired, ['home', 'more', 'detect', 'nexttree', 'saveexit']);

  // setTreeLabel updates the topbar label in place.
  ctx.CarouselUI.setTreeLabel('DAMIMAS_A21B_0002');
  assert.equal(dom.document.querySelector('.crsl-treelabel').textContent, 'DAMIMAS_A21B_0002');
});

test('CarouselUI without hooks renders no host chrome (web/desktop compatibility)', async () => {
  const { dom } = loadCarousel();
  await waitForImageRender();
  assert.equal(dom.document.querySelector('.crsl-topnav'), null);
  assert.equal(dom.document.querySelector('.crsl-actionrow'), null);
  assert.equal(dom.document.querySelector('.crsl-topbtn--more'), null);
});

test('CarouselUI horizontal swipe changes side while vertical drag does not', async () => {
  const { dom } = loadCarousel();
  await waitForImageRender();
  const stage = dom.document.querySelector('.carousel-stage');
  const canvas = dom.document.querySelector('.carousel-canvas');
  const label = dom.document.querySelector('.crsl-sidelabel');

  assert.match(label.textContent, /^Side 1/);
  pointer(stage, 'pointerdown', 200, 100, { target: canvas });
  pointer(stage, 'pointermove', 120, 104, { target: canvas });
  pointer(stage, 'pointerup', 120, 104, { target: canvas });
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.match(label.textContent, /^Side 2/);

  pointer(stage, 'pointerdown', 200, 100, { target: canvas });
  pointer(stage, 'pointermove', 208, 200, { target: canvas });
  pointer(stage, 'pointerup', 208, 200, { target: canvas });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(label.textContent, /^Side 2/);
});
