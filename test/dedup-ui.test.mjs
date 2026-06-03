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

function bbox(id, classId = 0, coords = [10, 10, 110, 110]) {
  const className = ['B1', 'B2', 'B3', 'B4'][classId];
  const [x1, y1, x2, y2] = coords;
  return { id, classId, className, x1, y1, x2, y2 };
}

function loadDedup(state = null) {
  const dom = makeDom();
  const windowEvents = new Map();
  const calls = [];
  const session = state || {
    sides: [
      { sideIndex: 0, imageUrl: 'img://side-1', bboxes: [bbox('a', 0)] },
      { sideIndex: 1, imageUrl: 'img://side-2', bboxes: [bbox('b', 1)] },
      { sideIndex: 2, imageUrl: 'img://side-3', bboxes: [] },
      { sideIndex: 3, imageUrl: 'img://side-4', bboxes: [] },
    ],
    confirmedLinks: [],
    suggestedLinks: [
      {
        linkId: 'sug-1',
        sideA: 0,
        bboxIdA: 'a',
        sideB: 1,
        bboxIdB: 'b',
        score: 0.9,
        category: 'auto',
        signals: { seam: 1, vert: 0.9 },
      },
    ],
    dirty: false,
  };
  let linkSeq = 0;
  const ActiveSession = {
    get: () => session,
    addManualLink(sideA, bboxIdA, sideB, bboxIdB) {
      calls.push({ fn: 'addManualLink', sideA, bboxIdA, sideB, bboxIdB });
      const link = { linkId: 'lnk-' + (++linkSeq), sideA, bboxIdA, sideB, bboxIdB };
      session.confirmedLinks.push(link);
      session.dirty = true;
      return link;
    },
    setBboxClass(sideIdx, bboxId, classId) {
      calls.push({ fn: 'setBboxClass', sideIdx, bboxId, classId });
      const box = session.sides[sideIdx].bboxes.find(b => b.id === bboxId);
      if (box) {
        box.classId = classId;
        box.className = ['B1', 'B2', 'B3', 'B4'][classId];
      }
      session.dirty = true;
    },
    removeBbox(sideIdx, bboxId) {
      calls.push({ fn: 'removeBbox', sideIdx, bboxId });
      session.sides[sideIdx].bboxes = session.sides[sideIdx].bboxes.filter(b => b.id !== bboxId);
      session.confirmedLinks = session.confirmedLinks.filter(
        l => !((l.sideA === sideIdx && l.bboxIdA === bboxId) || (l.sideB === sideIdx && l.bboxIdB === bboxId))
      );
      session.dirty = true;
    },
    removeConfirmedLink(linkId) {
      calls.push({ fn: 'removeConfirmedLink', linkId });
      session.confirmedLinks = session.confirmedLinks.filter(l => l.linkId !== linkId);
    },
    confirmAllAutoForPair(sideA, sideB) {
      calls.push({ fn: 'confirmAllAutoForPair', sideA, sideB });
      for (const sug of session.suggestedLinks.filter(s => s.category === 'auto')) {
        this.addManualLink(sug.sideA, sug.bboxIdA, sug.sideB, sug.bboxIdB);
      }
      session.suggestedLinks = [];
    },
    confirmLink(linkId) {
      calls.push({ fn: 'confirmLink', linkId });
      session.suggestedLinks = session.suggestedLinks.filter(s => s.linkId !== linkId);
    },
    rejectLink(linkId) {
      calls.push({ fn: 'rejectLink', linkId });
      session.suggestedLinks = session.suggestedLinks.filter(s => s.linkId !== linkId);
    },
    addBbox(sideIdx, box) {
      calls.push({ fn: 'addBbox', sideIdx, box });
      session.sides[sideIdx].bboxes.push(box);
    },
  };

  const ctx = loadModule(['js/yolo-io.js', 'js/canvas.js', 'js/dedup-ui.js'], {
    globals: {
      document: dom.document,
      Image: InstantImage,
      devicePixelRatio: 1,
      innerWidth: 1280,
      innerHeight: 800,
      ActiveSession,
      TREE_SIDE_LABELS: ['Side 1', 'Side 2', 'Side 3', 'Side 4'],
      ADJACENT_PAIRS: [[0, 1], [1, 2], [2, 3], [3, 0]],
      addEventListener(type, handler) {
        if (!windowEvents.has(type)) windowEvents.set(type, new Set());
        windowEvents.get(type).add(handler);
      },
      removeEventListener(type, handler) {
        const set = windowEvents.get(type);
        if (set) set.delete(handler);
      },
    },
  });

  const left = dom.document.createElement('canvas');
  const right = dom.document.createElement('canvas');
  const suggestions = dom.document.createElement('div');
  const links = dom.document.createElement('div');
  left.clientWidth = right.clientWidth = 1000;
  left.clientHeight = right.clientHeight = 1000;
  dom.document.body.append(left, right, suggestions, links);
  ctx.DedupUI.init(left, right, suggestions, links);

  function dispatchWindow(type, event = {}) {
    const set = windowEvents.get(type);
    if (set) {
      for (const handler of Array.from(set)) handler({
        type,
        button: 0,
        clientX: 20,
        clientY: 20,
        preventDefault() {},
        ...event,
      });
    }
  }

  return { ctx, dom, session, calls, left, right, suggestions, links, dispatchWindow };
}

async function waitForRender() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function mouseDown(el, x = 20, y = 20) {
  el.dispatchEvent({
    type: 'mousedown',
    button: 0,
    clientX: x,
    clientY: y,
    target: el,
    preventDefault() {},
  });
}

test('DedupUI manual click-link creates a confirmed adjacent-side link', async () => {
  const { ctx, session, calls, left, right, links, dispatchWindow } = loadDedup();

  ctx.DedupUI.showPair(0);
  await waitForRender();
  mouseDown(left);
  dispatchWindow('mouseup');
  mouseDown(right);
  dispatchWindow('mouseup');
  await waitForRender();

  assert.equal(session.confirmedLinks.length, 1);
  assert.deepEqual(calls.find(c => c.fn === 'addManualLink'), {
    fn: 'addManualLink',
    sideA: 0,
    bboxIdA: 'a',
    sideB: 1,
    bboxIdB: 'b',
  });
  assert.match(links.textContent, /B2 \(Side 2\).*B1 \(Side 1\)/);
});

test('DedupUI toolbar class change and delete target the selected bbox', async () => {
  const { ctx, session, calls, right, dispatchWindow } = loadDedup();

  ctx.DedupUI.showPair(0);
  await waitForRender();
  mouseDown(right);
  dispatchWindow('mouseup');
  await waitForRender();

  assert.deepEqual(ctx.DedupUI.getSelectedInfo(), {
    sideIdx: 0,
    sideLabel: 'Side 1',
    bboxId: 'a',
    className: 'B1',
    classId: 0,
  });

  assert.equal(ctx.DedupUI.changeSelectedClass('3'), true);
  assert.equal(session.sides[0].bboxes[0].className, 'B3');
  assert.equal(calls.some(c => c.fn === 'setBboxClass' && c.classId === 2), true);

  assert.equal(ctx.DedupUI.deleteSelected(), true);
  assert.equal(session.sides[0].bboxes.length, 0);
  assert.equal(calls.some(c => c.fn === 'removeBbox' && c.bboxId === 'a'), true);
});

test('DedupUI suggestion visibility and accept-all button drive session actions', async () => {
  const { ctx, calls, suggestions } = loadDedup();

  ctx.DedupUI.showPair(0);
  await waitForRender();
  assert.equal(ctx.DedupUI.getSuggestionsVisible(), true);
  assert.match(suggestions.textContent, /Accept All Auto \(1\)/);

  ctx.DedupUI.setSuggestionsVisible(false);
  await waitForRender();
  assert.equal(ctx.DedupUI.getSuggestionsVisible(), false);
  assert.match(suggestions.innerHTML, /Automatic suggestions are hidden/);

  ctx.DedupUI.setSuggestionsVisible(true);
  await waitForRender();
  suggestions.querySelector('button').click();
  await waitForRender();

  assert.equal(calls.some(c => c.fn === 'confirmAllAutoForPair' && c.sideA === 0 && c.sideB === 1), true);
});
