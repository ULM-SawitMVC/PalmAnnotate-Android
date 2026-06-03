'use strict';

// Direct unit coverage for js/dedup-utils.js — the geometric cross-side dedup
// suggester (suggestPairs) and the Union-Find it shares with the rest of the
// app. These were previously only exercised indirectly (through results.js and
// session.js); this file pins their behaviour at the boundaries: seam gating,
// the hard size-ratio gate, the class PENALTY multiplier, mutual-best vs greedy
// assignment, score→category thresholds, and Union-Find path compression / rank.

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

// dedup-utils.js attaches nothing to window — its functions live at top level
// (visible to co-loaded scripts in the browser). Capture them via the epilogue.
function loadDedupUtils() {
  const ctx = loadModule('js/dedup-utils.js', {
    epilogue: 'window.__du = { suggestPairs, createUnionFind, pairKey };',
  });
  return ctx.__du;
}

const IMG = { w: 1000, h: 1000 };

// A bbox near a vertical band of the image. `frac` is the horizontal centre as a
// fraction of width; the box is a fixed 100x100 centred vertically at y≈450.
function boxAt(id, classId, frac, { size = 100, cyFrac = 0.45 } = {}) {
  const cx = frac * IMG.w, cy = cyFrac * IMG.h;
  return {
    id, classId,
    x1: cx - size / 2, y1: cy - size / 2,
    x2: cx + size / 2, y2: cy + size / 2,
  };
}

// ── Union-Find ────────────────────────────────────────────────────────────────

test('createUnionFind: union merges sets, find resolves the shared root', () => {
  const { createUnionFind } = loadDedupUtils();
  const uf = createUnionFind(['a', 'b', 'c', 'd']);

  assert.equal(uf.find('a'), 'a', 'each element starts as its own root');
  uf.union('a', 'b');
  uf.union('c', 'd');
  assert.equal(uf.find('a'), uf.find('b'));
  assert.equal(uf.find('c'), uf.find('d'));
  assert.notEqual(uf.find('a'), uf.find('c'), 'disjoint sets stay separate');

  uf.union('b', 'c'); // bridge the two pairs into one set of four
  const root = uf.find('a');
  for (const x of ['a', 'b', 'c', 'd']) assert.equal(uf.find(x), root);
});

test('createUnionFind: union of already-joined nodes is a no-op (idempotent)', () => {
  const { createUnionFind } = loadDedupUtils();
  const uf = createUnionFind(['x', 'y']);
  uf.union('x', 'y');
  const before = uf.find('x');
  uf.union('x', 'y');
  uf.union('y', 'x');
  assert.equal(uf.find('x'), before);
  assert.equal(uf.find('y'), before);
});

test('pairKey is order-independent (canonical undirected edge key)', () => {
  const { pairKey } = loadDedupUtils();
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
  assert.equal(pairKey('0:b1', '1:b2'), pairKey('1:b2', '0:b1'));
  assert.notEqual(pairKey('a', 'b'), pairKey('a', 'c'));
});

// ── suggestPairs: happy path ────────────────────────────────────────────────

test('suggestPairs: a well-aligned seam pair is suggested as "auto"', () => {
  const { suggestPairs } = loadDedupUtils();
  // sideA's shared edge is LEFT (x≈0); sideB's is RIGHT (x≈1).
  const A = [boxAt('a0', 1, 0.10)];
  const B = [boxAt('b0', 1, 0.90)];

  const pairs = suggestPairs(A, IMG, B, IMG);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].bboxIdA, 'a0');
  assert.equal(pairs[0].bboxIdB, 'b0');
  assert.equal(pairs[0].category, 'auto', 'clean geometry + same class scores >= autoMin');
  assert.ok(pairs[0].score > 0.75 && pairs[0].score <= 1);
  // Signals are exposed for the UI / debugging.
  assert.ok('seam' in pairs[0].signals && 'vert' in pairs[0].signals);
});

// ── suggestPairs: seam gate ─────────────────────────────────────────────────

test('suggestPairs: boxes outside the seam band are gated out entirely', () => {
  const { suggestPairs } = loadDedupUtils();
  // sideA box sits in the FAR half (centre x=0.8 > 0.5) — physically cannot be
  // the shared bunch, so no candidate can form even with a perfect partner.
  const A = [boxAt('a0', 1, 0.80)];
  const B = [boxAt('b0', 1, 0.90)];
  assert.deepEqual(suggestPairs(A, IMG, B, IMG), []);
});

// ── suggestPairs: hard size-ratio gate ──────────────────────────────────────

test('suggestPairs: a drastic size mismatch is dropped by the hard size gate', () => {
  const { suggestPairs } = loadDedupUtils();
  const A = [boxAt('a0', 1, 0.10, { size: 100 })];   // area 100*100
  const B = [boxAt('b0', 1, 0.90, { size: 20 })];    // area 20*20 → ratio 0.04 < 0.30
  assert.deepEqual(suggestPairs(A, IMG, B, IMG), []);
});

// ── suggestPairs: class penalty multiplier ──────────────────────────────────

test('suggestPairs: class disagreement lowers the score (penalty multiplier)', () => {
  const { suggestPairs } = loadDedupUtils();
  // Identical geometry; only the class differs. Keep both pairs by dropping the
  // candidate floor to 0 so we can compare raw scores.
  const same = suggestPairs(
    [boxAt('a', 1, 0.10)], IMG, [boxAt('b', 1, 0.90)], IMG, { candidateMin: 0 }
  );
  const farClass = suggestPairs(
    [boxAt('a', 1, 0.10)], IMG, [boxAt('b', 3, 0.90)], IMG, { candidateMin: 0 }
  );
  assert.equal(same.length, 1);
  assert.equal(farClass.length, 1);
  // Same class → multiplier 1.0; |Δclass|=2 → multiplier 0.5.
  assert.ok(farClass[0].score < same[0].score);
  assert.ok(Math.abs(farClass[0].score - same[0].score * 0.5) < 1e-9);
});

test('suggestPairs: a 2-grade class gap drops below the default candidate floor', () => {
  const { suggestPairs } = loadDedupUtils();
  // Default candidateMin is 0.50; clean geometry scores ~0.91, ×0.5 = ~0.455.
  const pairs = suggestPairs([boxAt('a', 1, 0.10)], IMG, [boxAt('b', 3, 0.90)], IMG);
  assert.deepEqual(pairs, []);
});

// ── suggestPairs: assignment strategy ───────────────────────────────────────

test('suggestPairs: mutual-best keeps only the reciprocal top pick', () => {
  const { suggestPairs } = loadDedupUtils();
  // Two A boxes both want the single B box. The closer-aligned A wins; the other
  // gets nothing because B's best partner is not it (mutual-best assignment).
  const A = [
    boxAt('a_close', 1, 0.10, { cyFrac: 0.45 }), // perfectly aligned with B
    boxAt('a_far',   1, 0.10, { cyFrac: 0.80 }), // vertically off
  ];
  const B = [boxAt('b0', 1, 0.90, { cyFrac: 0.45 })];

  const pairs = suggestPairs(A, IMG, B, IMG);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].bboxIdA, 'a_close');
});

test('suggestPairs: greedy fallback can also assign one pair per box', () => {
  const { suggestPairs } = loadDedupUtils();
  const A = [boxAt('a0', 1, 0.10), boxAt('a1', 1, 0.12, { cyFrac: 0.7 })];
  const B = [boxAt('b0', 1, 0.90), boxAt('b1', 1, 0.88, { cyFrac: 0.7 })];

  const pairs = suggestPairs(A, IMG, B, IMG, { mutualBest: false });
  // Greedy assigns highest-scoring disjoint pairs; each box used at most once.
  const usedA = new Set(pairs.map(p => p.bboxIdA));
  const usedB = new Set(pairs.map(p => p.bboxIdB));
  assert.equal(usedA.size, pairs.length, 'no A box reused');
  assert.equal(usedB.size, pairs.length, 'no B box reused');
  assert.ok(pairs.length >= 1);
});

// ── suggestPairs: degenerate inputs ─────────────────────────────────────────

test('suggestPairs: empty side(s) yield no suggestions', () => {
  const { suggestPairs } = loadDedupUtils();
  assert.deepEqual(suggestPairs([], IMG, [boxAt('b', 1, 0.9)], IMG), []);
  assert.deepEqual(suggestPairs([boxAt('a', 1, 0.1)], IMG, [], IMG), []);
  assert.deepEqual(suggestPairs([], IMG, [], IMG), []);
});

test('suggestPairs: thresholds are configurable via opts', () => {
  const { suggestPairs } = loadDedupUtils();
  const A = [boxAt('a', 1, 0.10)];
  const B = [boxAt('b', 1, 0.90)];
  // Force the clean pair (~0.91) below "auto" so it lands in "candidate".
  const pairs = suggestPairs(A, IMG, B, IMG, { autoMin: 0.95 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].category, 'candidate');
});
