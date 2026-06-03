'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

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
  const className = ['B1', 'B2', 'B3', 'B4'][classId] || ('C' + classId);
  const [x1, y1, x2, y2] = coords;
  return { id, classId, className, x1, y1, x2, y2 };
}

function makeTree(sideCount = 4, labels = {}) {
  return {
    name: 'DAMIMAS_A21B_0001',
    split: 'train',
    sides: Array.from({ length: sideCount }, (_, i) => ({
      imageUri: `native-image-${i + 1}`,
      labelUri: `native-label-${i + 1}`,
      labelText: labels[i] || '',
    })),
  };
}

function loadSession(labelTextByUri = {}) {
  const DatasetManager = {
    imageUrlForSide(side) {
      return side && (side.imageUri || side.imageUrl || ('mem://' + side.labelUri));
    },
    async labelTextForSide(side) {
      if (!side) return null;
      return labelTextByUri[side.labelUri] ?? side.labelText ?? null;
    },
  };
  return loadModule(['js/yolo-io.js', 'js/dedup-utils.js', 'js/session.js'], {
    globals: { DatasetManager, Image: InstantImage },
    epilogue: 'window.__sessionHelpers = { generateSideLabels, generateAdjacentPairs };',
  });
}

async function loadSavedSession(ctx, sideCount = 4, savedOverrides = {}) {
  const saved = {
    treeName: 'DAMIMAS_A21B_0001',
    split: 'train',
    sides: Array.from({ length: sideCount }, (_, i) => ({
      sideIndex: i,
      label: `Side ${i + 1}`,
      imageWidth: 1000,
      imageHeight: 1000,
      bboxes: [],
    })),
    confirmedLinks: [],
    suggestedLinks: [],
    ...savedOverrides,
  };
  return ctx.ActiveSession.fromJSON(saved, makeTree(sideCount));
}

test('side labels and adjacent pairs adapt to 2, 4, and 8 side datasets', async () => {
  const ctx = loadSession();
  assert.deepEqual(ctx.__sessionHelpers.generateSideLabels(4), ['Side 1', 'Side 2', 'Side 3', 'Side 4']);
  assert.deepEqual(ctx.__sessionHelpers.generateAdjacentPairs(2), [[0, 1]]);
  assert.deepEqual(ctx.__sessionHelpers.generateAdjacentPairs(4), [[0, 1], [1, 2], [2, 3], [3, 0]]);

  await ctx.ActiveSession.loadTree(makeTree(8));
  assert.equal(ctx.ActiveSession.sideCount, 8);
  assert.deepEqual(ctx.ActiveSession.TREE_SIDE_LABELS, [
    'Side 1', 'Side 2', 'Side 3', 'Side 4',
    'Side 5', 'Side 6', 'Side 7', 'Side 8',
  ]);
  assert.deepEqual(ctx.ActiveSession.ADJACENT_PAIRS.at(-1), [7, 0]);
});

test('loadTree reads native labels through DatasetManager and keeps session clean', async () => {
  const ctx = loadSession({
    'native-label-1': '0 0.5 0.5 0.2 0.2',
    'native-label-2': '1 0.25 0.25 0.1 0.1',
  });
  const state = await ctx.ActiveSession.loadTree(makeTree(4));

  assert.equal(state.treeName, 'DAMIMAS_A21B_0001');
  assert.equal(state.sides.length, 4);
  assert.equal(state.sides[0].imageWidth, 1000);
  assert.equal(state.sides[0].bboxes.length, 1);
  assert.equal(state.sides[0].bboxes[0].className, 'B1');
  assert.equal(state.sides[1].bboxes[0].className, 'B2');
  assert.equal(ctx.ActiveSession.isDirty(), false);
});

test('manual links only allow adjacent pairs, replace same-pair endpoints, and preserve other-pair links', async () => {
  const ctx = loadSession();
  await loadSavedSession(ctx, 4, {
    sides: [
      { sideIndex: 0, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('a')] },
      { sideIndex: 1, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('b'), bbox('b2')] },
      { sideIndex: 2, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('c')] },
      { sideIndex: 3, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('d')] },
    ],
  });

  assert.equal(ctx.ActiveSession.addManualLink(0, 'a', 2, 'c'), null, 'non-adjacent link is blocked');

  const link01 = ctx.ActiveSession.addManualLink(0, 'a', 1, 'b');
  const link12 = ctx.ActiveSession.addManualLink(1, 'b', 2, 'c');
  const link30 = ctx.ActiveSession.addManualLink(3, 'd', 0, 'a');
  assert.ok(link01 && link12 && link30);
  assert.equal(ctx.ActiveSession.get().confirmedLinks.length, 3);

  const replacement = ctx.ActiveSession.addManualLink(0, 'a', 1, 'b2');
  assert.ok(replacement);
  const links = ctx.ActiveSession.get().confirmedLinks;
  assert.equal(links.length, 3, 'only the 0-1 pair was replaced');
  assert.equal(links.some(l => l.sideA === 0 && l.bboxIdA === 'a' && l.sideB === 1 && l.bboxIdB === 'b'), false);
  assert.equal(links.some(l => l.sideA === 0 && l.bboxIdA === 'a' && l.sideB === 1 && l.bboxIdB === 'b2'), true);
  assert.equal(links.some(l => l.linkId === link12.linkId), true);
  assert.equal(links.some(l => l.linkId === link30.linkId), true);
});

test('class updates propagate through confirmed clusters and mismatch detection reports unresolved clusters', async () => {
  const ctx = loadSession();
  await loadSavedSession(ctx, 4, {
    sides: [
      { sideIndex: 0, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('a', 0)] },
      { sideIndex: 1, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('b', 0)] },
      { sideIndex: 2, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('c', 0)] },
      { sideIndex: 3, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('d', 2)] },
    ],
    confirmedLinks: [
      { sideA: 0, bboxIdA: 'a', sideB: 1, bboxIdB: 'b' },
      { sideA: 1, bboxIdA: 'b', sideB: 2, bboxIdB: 'c' },
    ],
  });

  ctx.ActiveSession.updateBbox(1, 'b', { classId: 2, className: 'B3' });
  const mismatches = ctx.ActiveSession.getMismatchedClusters();
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0].classIds.sort(), [0, 2]);

  const affected = ctx.ActiveSession.propagateClassFromBox(1, 'b');
  assert.equal(affected.length, 3);
  assert.deepEqual(ctx.ActiveSession.get().sides.slice(0, 3).map(s => s.bboxes[0].className), ['B3', 'B3', 'B3']);
  assert.equal(ctx.ActiveSession.getMismatchedClusters().length, 0);
});

test('fromJSON sanitizes stale links and expands legacy non-adjacent clusters into adjacent links', async () => {
  const ctx = loadSession();
  const state = await loadSavedSession(ctx, 4, {
    sides: [
      { sideIndex: 0, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('a')] },
      { sideIndex: 1, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('b')] },
      { sideIndex: 2, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('c')] },
      { sideIndex: 3, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('d')] },
    ],
    confirmedLinks: [
      { sideA: 0, bboxIdA: 'a', sideB: 1, bboxIdB: 'b' },
      { sideA: 1, bboxIdA: 'b', sideB: 0, bboxIdB: 'a' }, // duplicate reversed
      { sideA: 0, bboxIdA: 'a', sideB: 2, bboxIdB: 'c' }, // legacy non-adjacent cluster hint
      { sideA: 2, bboxIdA: 'missing', sideB: 3, bboxIdB: 'd' }, // stale bbox
      { sideA: 3, bboxIdA: 'd', sideB: 3, bboxIdB: 'd' }, // same side
    ],
  });

  const pairs = state.confirmedLinks.map(l => `${l.sideA}:${l.bboxIdA}->${l.sideB}:${l.bboxIdB}`).sort();
  assert.deepEqual(pairs, ['0:a->1:b', '1:b->2:c']);
  assert.equal(state.dirty, false);
});

test('runSuggestions and confirmAllAutoForPair promote only auto suggestions for the active pair', async () => {
  const ctx = loadSession();
  await loadSavedSession(ctx, 4, {
    sides: [
      { sideIndex: 0, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('a', 1, [0, 400, 100, 520])] },
      { sideIndex: 1, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('b', 1, [900, 400, 1000, 520])] },
      { sideIndex: 2, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('c', 1, [0, 100, 100, 220])] },
      { sideIndex: 3, imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('d', 1, [900, 100, 1000, 220])] },
    ],
  });

  ctx.ActiveSession.runSuggestions({ autoMin: 0.7, candidateMin: 0.45 });
  const suggested = ctx.ActiveSession.get().suggestedLinks;
  assert.ok(suggested.length >= 2, 'expected suggestions on at least two adjacent pairs');

  ctx.ActiveSession.confirmAllAutoForPair(0, 1);
  const state = ctx.ActiveSession.get();
  assert.equal(state.confirmedLinks.length, 1);
  assert.equal(state.confirmedLinks[0].sideA, 0);
  assert.equal(state.confirmedLinks[0].sideB, 1);
  assert.equal(state.suggestedLinks.some(l => l.sideA === 0 && l.sideB === 1 && l.category === 'auto'), false);
  assert.equal(state.suggestedLinks.some(l => l.category === 'auto'), true);
});

