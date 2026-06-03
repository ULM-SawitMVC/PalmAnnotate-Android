'use strict';

import { test } from 'node:test';
// Non-strict assert: modules build their return values inside a `node:vm`
// realm, so arrays/objects carry that realm's prototypes. Loose deepEqual
// compares structure without the cross-realm prototype identity check that
// deepStrictEqual enforces. Scalar checks (numbers/strings) are unaffected.
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

// yolo-io.js declares top-level `const`s (CLASS_MAP, VALID_CLASS_IDS) and
// `function`s (parseYoloLabel, toYoloFormat). The const bindings are lexical
// (not on window), so we capture them via an epilogue in the same script scope.
function load() {
  const ctx = loadModule('js/yolo-io.js', {
    epilogue: 'window.__y = { CLASS_MAP, VALID_CLASS_IDS, parseYoloLabel, toYoloFormat };',
  });
  return ctx.__y;
}

test('CLASS_MAP / VALID_CLASS_IDS reflect the Damimas 4-class scheme', () => {
  const { CLASS_MAP, VALID_CLASS_IDS } = load();
  assert.equal(CLASS_MAP[0], 'B1');
  assert.equal(CLASS_MAP[1], 'B2');
  assert.equal(CLASS_MAP[2], 'B3');
  assert.equal(CLASS_MAP[3], 'B4');
  assert.ok(VALID_CLASS_IDS.has(0) && VALID_CLASS_IDS.has(3));
  assert.ok(!VALID_CLASS_IDS.has(4));
  assert.ok(!VALID_CLASS_IDS.has(-1));
});

test('parseYoloLabel converts normalized coords to pixel corners', () => {
  const { parseYoloLabel } = load();
  // class 1, centre (0.5,0.5), size (0.2,0.4) on a 1000x500 image.
  const out = parseYoloLabel('1 0.5 0.5 0.2 0.4', 1000, 500);
  assert.equal(out.length, 1);
  const b = out[0];
  assert.equal(b.id, 'b0');
  assert.equal(b.classId, 1);
  assert.equal(b.className, 'B2');
  assert.equal(b.x1, 400); // (0.5-0.1)*1000
  assert.equal(b.y1, 150); // (0.5-0.2)*500
  assert.equal(b.x2, 600); // (0.5+0.1)*1000
  assert.equal(b.y2, 350); // (0.5+0.2)*500
});

test('parseYoloLabel skips invalid / out-of-range / malformed lines', () => {
  const { parseYoloLabel } = load();
  const text = [
    '0 0.5 0.5 0.2 0.2', // ok  -> b0
    '9 0.5 0.5 0.1 0.1', // class 9 not in 0..3 -> skip
    '1 0.5',             // too few fields -> skip
    'x y z a b',         // NaN -> skip
    '',                  // blank -> skip
    '2 0.25 0.25 0.1 0.1', // ok -> b1
  ].join('\n');
  const out = parseYoloLabel(text, 800, 800);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(b => b.classId), [0, 2]);
  assert.deepEqual(out.map(b => b.id), ['b0', 'b1']);
});

test('parseYoloLabel clamps boxes to image bounds', () => {
  const { parseYoloLabel } = load();
  // centre near the corner with a big box -> corners spill past [0,W]/[0,H].
  const out = parseYoloLabel('0 0.95 0.95 0.2 0.2', 1000, 1000);
  const b = out[0];
  assert.equal(b.x1, 850); // (0.95-0.1)*1000
  assert.equal(b.y1, 850);
  assert.equal(b.x2, 1000); // (0.95+0.1)*1000 = 1050 -> clamped to 1000
  assert.equal(b.y2, 1000);
});

test('empty / whitespace input yields no boxes', () => {
  const { parseYoloLabel } = load();
  assert.deepEqual(parseYoloLabel('', 100, 100), []);
  assert.deepEqual(parseYoloLabel('   \n  \n', 100, 100), []);
  assert.deepEqual(parseYoloLabel(null, 100, 100), []);
});

test('parse -> serialize -> parse round-trips coordinates', () => {
  const { parseYoloLabel, toYoloFormat } = load();
  const W = 1280, H = 960;
  const original = parseYoloLabel('3 0.4 0.6 0.2 0.3\n0 0.5 0.5 0.1 0.1', W, H);
  const text = toYoloFormat(original, W, H);
  const reparsed = parseYoloLabel(text, W, H);
  assert.equal(reparsed.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(reparsed[i].classId, original[i].classId);
    for (const k of ['x1', 'y1', 'x2', 'y2']) {
      // 6-dp serialization -> sub-pixel tolerance after the W/H round-trip.
      assert.ok(Math.abs(reparsed[i][k] - original[i][k]) < 0.05,
        `${k}: ${reparsed[i][k]} vs ${original[i][k]}`);
    }
  }
});
