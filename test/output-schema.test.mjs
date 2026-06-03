'use strict';

import { test } from 'node:test';
// Non-strict assert — see note in yolo-io.test.mjs (cross-realm vm objects).
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

function freshSchema() {
  return loadModule('js/output-schema.js').OutputSchema;
}

test('generate() builds a SawitMVC v4 tree document', () => {
  const OS = freshSchema();
  const session = {
    treeName: 'DAMIMAS_A21B_0001',
    split: 'train',
    sides: [
      { sideIndex: 0, label: 'Side 1', imageWidth: 1000, imageHeight: 1000,
        bboxes: [{ id: 'b0', classId: 1, className: 'B2', x1: 100, y1: 100, x2: 300, y2: 300 }] },
      { sideIndex: 1, label: 'Side 2', imageWidth: 1000, imageHeight: 1000,
        bboxes: [{ id: 'b0', classId: 1, className: 'B2', x1: 120, y1: 120, x2: 320, y2: 320 }] },
    ],
    confirmedLinks: [{ linkId: 'L0', sideA: 0, bboxIdA: 'b0', sideB: 1, bboxIdB: 'b0' }],
  };
  const result = {
    clusters: new Map([['c1', [
      { _sideIndex: 0, id: 'b0', className: 'B2', x1: 100, y1: 100, x2: 300, y2: 300 },
      { _sideIndex: 1, id: 'b0', className: 'B2', x1: 120, y1: 120, x2: 320, y2: 320 },
    ]]]),
    uniqueCount: 1, rawCount: 2, linkedCount: 1, classCounts: { B2: 2 },
  };

  const out = OS.generate(session, result, /* datasetTree */ null);

  assert.equal(out.version, 4);
  assert.equal(out.tree_id, 'DAMIMAS_A21B_0001');
  assert.equal(out.metadata.variety, 'DAMIMAS');

  // Image section: uniform side_N keys, derived filenames, yolo+pixel coords.
  assert.ok(out.images.side_1 && out.images.side_2);
  assert.equal(out.images.side_1.filename, 'DAMIMAS_A21B_0001_1.jpg');
  assert.equal(out.images.side_1.bbox_count, 1);
  const ann = out.images.side_1.annotations[0];
  assert.equal(ann.class_name, 'B2');
  assert.deepEqual(ann.bbox_pixel, [100, 100, 300, 300]);
  assert.deepEqual(ann.bbox_yolo, [0.2, 0.2, 0.2, 0.2]); // centre .2,.2 size .2,.2

  // Bunch section: one clustered bunch with 2 appearances.
  assert.equal(out.bunches.length, 1);
  assert.equal(out.bunches[0].appearance_count, 2);
  assert.equal(out.bunches[0].class, 'B2');

  // Confirmed cross-link persisted (adjacent 0<->1), box-index-stable ids.
  assert.equal(out._confirmedLinks.length, 1);
  assert.deepEqual(
    [out._confirmedLinks[0].sideA, out._confirmedLinks[0].bboxIdA,
     out._confirmedLinks[0].sideB, out._confirmedLinks[0].bboxIdB],
    [0, 'b0', 1, 'b0']);

  // Summary tallies.
  assert.equal(out.summary.total_unique_bunches, 1);
  assert.equal(out.summary.total_detections, 2);
  assert.equal(out.summary.duplicates_linked, 1);
  assert.deepEqual(out.summary.by_side, { side_1: 1, side_2: 1 });
});

test('generate() drops non-adjacent confirmed links (4-side ring)', () => {
  const OS = freshSchema();
  const mkSide = (i) => ({
    sideIndex: i, label: `Side ${i + 1}`, imageWidth: 1000, imageHeight: 1000,
    bboxes: [{ id: 'b0', classId: 2, className: 'B3', x1: 10, y1: 10, x2: 90, y2: 90 }],
  });
  const session = {
    treeName: 'LONSUM_C_0009', split: 'train',
    sides: [mkSide(0), mkSide(1), mkSide(2), mkSide(3)],
    confirmedLinks: [
      { sideA: 0, bboxIdA: 'b0', sideB: 1, bboxIdB: 'b0' }, // adjacent  -> kept
      { sideA: 0, bboxIdA: 'b0', sideB: 2, bboxIdB: 'b0' }, // opposite  -> dropped
    ],
  };
  const out = OS.generate(session, /* result */ null, null);
  assert.equal(out._confirmedLinks.length, 1);
  assert.equal(out._confirmedLinks[0].sideA, 0);
  assert.equal(out._confirmedLinks[0].sideB, 1);
  // by_side present for all four sides.
  assert.deepEqual(Object.keys(out.summary.by_side), ['side_1', 'side_2', 'side_3', 'side_4']);
});

test('generate() -> toSessionJSON() round-trips sides and links', () => {
  const OS = freshSchema();
  const session = {
    treeName: 'DAMIMAS_A21B_0001', split: 'train',
    sides: [
      { sideIndex: 0, label: 'Side 1', imageWidth: 1000, imageHeight: 1000,
        bboxes: [{ id: 'b0', classId: 1, className: 'B2', x1: 100, y1: 100, x2: 300, y2: 300 }] },
      { sideIndex: 1, label: 'Side 2', imageWidth: 1000, imageHeight: 1000,
        bboxes: [{ id: 'b0', classId: 1, className: 'B2', x1: 120, y1: 120, x2: 320, y2: 320 }] },
    ],
    confirmedLinks: [{ linkId: 'L0', sideA: 0, bboxIdA: 'b0', sideB: 1, bboxIdB: 'b0' }],
  };
  const out = OS.generate(session, null, null);
  const round = OS.toSessionJSON(out);

  assert.equal(round.treeName, 'DAMIMAS_A21B_0001');
  assert.equal(round.split, 'train');
  assert.equal(round.sides.length, 2);
  assert.equal(round.sides[0].sideIndex, 0);
  assert.equal(round.sides[0].bboxes[0].id, 'b0');
  assert.deepEqual(
    [round.sides[0].bboxes[0].x1, round.sides[0].bboxes[0].y1,
     round.sides[0].bboxes[0].x2, round.sides[0].bboxes[0].y2],
    [100, 100, 300, 300]);

  assert.equal(round.confirmedLinks.length, 1);
  assert.equal(round.confirmedLinks[0].sideA, 0);
  assert.equal(round.confirmedLinks[0].sideB, 1);
  assert.equal(round.confirmedLinks[0].bboxIdA, 'b0');
});

test('generate() keeps the operator-recorded variety instead of truncating from the name', () => {
  const OS = freshSchema();
  // A custom "Other" variety with a space + digit. Deriving from the tree name
  // (^[A-Za-z]+) would yield just "TENERA" — the real variety must survive.
  const session = {
    treeName: 'TENERA_MARIHAT_20260604_007', split: 'field',
    sides: [
      { sideIndex: 0, label: 'Side 1', imageWidth: 1000, imageHeight: 1000,
        bboxes: [{ id: 'b0', classId: 0, className: 'B1', x1: 10, y1: 10, x2: 90, y2: 90 }] },
      { sideIndex: 1, label: 'Side 2', imageWidth: 1000, imageHeight: 1000, bboxes: [] },
    ],
    confirmedLinks: [],
  };
  const datasetTree = {
    name: 'TENERA_MARIHAT_20260604_007', split: 'field',
    metadata: { variety: 'Tenera Marihat 2', blok: 'A21B' },
    sides: [{ imageFile: { name: 'TENERA_MARIHAT_20260604_007_1.jpg' } }, { imageFile: null }],
  };
  const out = OS.generate(session, null, datasetTree);
  assert.equal(out.metadata.variety, 'Tenera Marihat 2');
});

test('generate() falls back to name-derived variety when the tree carries no metadata', () => {
  const OS = freshSchema();
  const session = {
    treeName: 'DAMIMAS_A21B_0001', split: 'train',
    sides: [{ sideIndex: 0, label: 'Side 1', imageWidth: 1000, imageHeight: 1000, bboxes: [] },
            { sideIndex: 1, label: 'Side 2', imageWidth: 1000, imageHeight: 1000, bboxes: [] }],
    confirmedLinks: [],
  };
  // Folder-loaded trees (web) have no metadata field at all.
  const datasetTree = { name: 'DAMIMAS_A21B_0001', split: 'train', sides: [{}, {}] };
  const out = OS.generate(session, null, datasetTree);
  assert.equal(out.metadata.variety, 'DAMIMAS');
});

test('generate() skips an empty cluster instead of crashing on the majority vote', () => {
  const OS = freshSchema();
  const session = {
    treeName: 'DAMIMAS_A21B_0001', split: 'train',
    sides: [
      { sideIndex: 0, label: 'Side 1', imageWidth: 1000, imageHeight: 1000,
        bboxes: [{ id: 'b0', classId: 1, className: 'B2', x1: 10, y1: 10, x2: 90, y2: 90 }] },
      { sideIndex: 1, label: 'Side 2', imageWidth: 1000, imageHeight: 1000, bboxes: [] },
    ],
    confirmedLinks: [],
  };
  // A degenerate clusters map: one empty cluster (must be skipped) + one real one.
  const result = {
    clusters: new Map([
      ['empty', []],
      ['real', [{ _sideIndex: 0, id: 'b0', className: 'B2', x1: 10, y1: 10, x2: 90, y2: 90 }]],
    ]),
    uniqueCount: 1, rawCount: 1, linkedCount: 0, classCounts: { B2: 1 },
  };
  let out;
  assert.doesNotThrow(() => { out = OS.generate(session, result, null); });
  assert.equal(out.bunches.length, 1, 'only the non-empty cluster becomes a bunch');
  assert.equal(out.bunches[0].class, 'B2');
});

test('toSessionJSON() throws on malformed input', () => {
  const OS = freshSchema();
  assert.throws(() => OS.toSessionJSON(null), /Invalid output JSON/);
  assert.throws(() => OS.toSessionJSON({}), /Invalid output JSON/);
});
