'use strict';

import { test } from 'node:test';
// Non-strict assert — see note in yolo-io.test.mjs (cross-realm vm objects).
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

// DatasetManager.load() consumes a FileList of { name, webkitRelativePath }.
// We feed a plain array of file-like objects (an array is iterable, and load()
// only reads .name / .webkitRelativePath and keeps the object as the ref).
function file(relPath, extra = {}) {
  const name = relPath.split('/').pop();
  return { name, webkitRelativePath: relPath, ...extra };
}

function freshManager() {
  return loadModule('js/dataset.js').DatasetManager;
}

test('groups images+labels into trees, sorted, with per-tree side counts', () => {
  const DM = freshManager();
  const files = [
    // Tree A: 4 full sides under train/, plus an Output TXT override for side 1.
    file('images/train/DAMIMAS_A21B_0004_1.jpg'),
    file('images/train/DAMIMAS_A21B_0004_2.jpg'),
    file('images/train/DAMIMAS_A21B_0004_3.jpg'),
    file('images/train/DAMIMAS_A21B_0004_4.jpg'),
    file('labels/train/DAMIMAS_A21B_0004_1.txt', { tag: 'pred' }),
    file('labels/train/DAMIMAS_A21B_0004_2.txt'),
    file('labels/train/DAMIMAS_A21B_0004_3.txt'),
    file('labels/train/DAMIMAS_A21B_0004_4.txt'),
    file('Output TXT/train/DAMIMAS_A21B_0004_1.txt', { tag: 'override' }),

    // Tree B: 2 sides.
    file('images/train/LONSUM_B12C_0001_1.jpg'),
    file('images/train/LONSUM_B12C_0001_2.jpg'),
    file('labels/train/LONSUM_B12C_0001_1.txt'),
    file('labels/train/LONSUM_B12C_0001_2.txt'),

    // Tree C: sides 1 and 3 only (2 missing) -> side count 3, middle side empty.
    file('images/train/SAWIT_Z9_0007_1.jpg'),
    file('images/train/SAWIT_Z9_0007_3.jpg'),
    file('labels/train/SAWIT_Z9_0007_1.txt'),

    // Noise that must be ignored:
    file('__MACOSX/images/train/DAMIMAS_A21B_0004_1.jpg'), // macOS archive junk
    file('images/train/.DS_Store'),
    file('images/train/Thumbs.db'),
    file('images/train/desktop.ini'),
    file('images/train/._DAMIMAS_A21B_0004_1.jpg'),
    file('data.yaml'),                                     // not a label txt
    file('notes.txt'),                                     // txt outside labels/
    file('images/train/NOSIDE_0001.jpg'),                  // image w/o _N suffix
  ];

  const trees = DM.load(files);
  assert.equal(trees.length, 3);
  assert.deepEqual(trees.map(t => t.name),
    ['DAMIMAS_A21B_0004', 'LONSUM_B12C_0001', 'SAWIT_Z9_0007']);

  const [A, B, C] = trees;
  assert.equal(A.split, 'train');
  assert.equal(A.sides.length, 4);
  assert.ok(A.sides[0].imageFile, 'side 1 image present');
  // Output TXT must win over labels/ for the same stem.
  assert.equal(A.sides[0].labelFile.tag, 'override');

  assert.equal(B.sides.length, 2);

  assert.equal(C.sides.length, 3);            // max side number observed (3)
  assert.ok(C.sides[0].imageFile);            // side 1
  assert.equal(C.sides[1].imageFile, null);   // side 2 missing
  assert.ok(C.sides[2].imageFile);            // side 3

  // An image with no side suffix produced no tree.
  assert.equal(DM.findByName('NOSIDE_0001'), -1);
  assert.equal(DM.findByName('notes'), -1);
});

test('split detection recognises val/ and test/ segments', () => {
  const DM = freshManager();
  const trees = DM.load([
    file('images/val/DAMIMAS_X_0001_1.jpg'),
    file('images/val/DAMIMAS_X_0001_2.jpg'),
    file('images/test/LONSUM_Y_0002_1.jpg'),
    file('images/test/LONSUM_Y_0002_2.jpg'),
  ]);
  const byName = Object.fromEntries(trees.map(t => [t.name, t.split]));
  assert.equal(byName['DAMIMAS_X_0001'], 'val');
  assert.equal(byName['LONSUM_Y_0002'], 'test');
});

test('navigation helpers (goTo/next/prev/getIndex) stay in bounds', () => {
  const DM = freshManager();
  DM.load([
    file('images/train/T_A_0001_1.jpg'), file('images/train/T_A_0001_2.jpg'),
    file('images/train/T_B_0002_1.jpg'), file('images/train/T_B_0002_2.jpg'),
    file('images/train/T_C_0003_1.jpg'), file('images/train/T_C_0003_2.jpg'),
  ]);
  assert.equal(DM.count(), 3);
  assert.equal(DM.getIndex(), 0);
  assert.equal(DM.prev(), false);          // already at start
  assert.equal(DM.getIndex(), 0);
  assert.equal(DM.next(), true);
  assert.equal(DM.getIndex(), 1);
  assert.equal(DM.goTo(2), true);
  assert.equal(DM.next(), false);          // past the end
  assert.equal(DM.getIndex(), 2);
  assert.equal(DM.goTo(99), false);
});

test('addCapturedTree appends and selects the new tree', () => {
  const DM = freshManager();
  DM.load([
    file('images/train/T_A_0001_1.jpg'), file('images/train/T_A_0001_2.jpg'),
  ]);
  const captured = { name: 'CAPTURED_0001', split: 'unknown', sides: [{}, {}, {}, {}] };
  const idx = DM.addCapturedTree(captured);
  assert.equal(idx, 1);
  assert.equal(DM.count(), 2);
  assert.equal(DM.getIndex(), 1);
  assert.equal(DM.getTree().name, 'CAPTURED_0001');
  assert.equal(DM.findByName('CAPTURED_0001'), 1);
});
