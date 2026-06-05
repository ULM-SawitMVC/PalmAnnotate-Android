'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

function bbox(id, classId, className, coords = [100, 100, 300, 300]) {
  const [x1, y1, x2, y2] = coords;
  return { id, classId, className, x1, y1, x2, y2 };
}

function makeSession() {
  return {
    treeName: 'DAMIMAS_A21B_0001',
    split: 'train',
    confirmedLinks: [
      { sideA: 0, bboxIdA: 'a', sideB: 1, bboxIdB: 'b' },
      { sideA: 1, bboxIdA: 'b', sideB: 2, bboxIdB: 'c' },
      { sideA: 0, bboxIdA: 'missing', sideB: 2, bboxIdB: 'c' },
    ],
    sides: [
      { sideIndex: 0, label: 'Side 1', imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('a', 1, 'B2')] },
      { sideIndex: 1, label: 'Side 2', imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('b', 1, 'B2')] },
      { sideIndex: 2, label: 'Side 3', imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('c', 2, 'B3')] },
      { sideIndex: 3, label: 'Side 4', imageWidth: 1000, imageHeight: 1000, bboxes: [bbox('d', 0, 'B1')] },
    ],
  };
}

function makeDownloadDom() {
  const blobs = [];
  const downloads = [];
  const doc = {
    body: {
      appendChild() {},
      removeChild() {},
    },
    createElement(tag) {
      if (String(tag).toLowerCase() !== 'a') return { style: {}, appendChild() {} };
      return {
        href: '',
        download: '',
        click() {
          const idx = Number(String(this.href).replace('blob:test-', ''));
          downloads.push({ filename: this.download, blob: blobs[idx] });
        },
        remove() {},
      };
    },
  };
  const URLStub = {
    createObjectURL(blob) {
      const idx = blobs.push(blob) - 1;
      return 'blob:test-' + idx;
    },
    revokeObjectURL() {},
  };
  return { doc, URLStub, downloads };
}

function loadResults() {
  const { doc, URLStub, downloads } = makeDownloadDom();
  const ActiveSession = {
    toJSON() {
      return { version: 1, treeName: 'DAMIMAS_A21B_0001', sides: [] };
    },
  };
  const ctx = loadModule(['js/yolo-io.js', 'js/dedup-utils.js', 'js/results.js'], {
    globals: { document: doc, URL: URLStub, Blob, ActiveSession },
  });
  return { Results: ctx.Results, downloads };
}

async function downloadTexts(downloads) {
  const out = {};
  for (const d of downloads) out[d.filename] = await d.blob.text();
  return out;
}

test('compute() counts raw detections, unique clusters, stale links, and class majority', () => {
  const { Results } = loadResults();
  const result = Results.compute(makeSession());

  assert.equal(result.rawCount, 4);
  assert.equal(result.linkedCount, 2, 'stale missing-bbox link is ignored');
  assert.equal(result.uniqueCount, 2);
  assert.equal(result.classCounts.B2, 1, 'linked a-b-c cluster majority is B2');
  assert.equal(result.classCounts.B1, 1);
  assert.deepEqual(result.sideCounts, { 'Side 1': 1, 'Side 2': 1, 'Side 3': 1, 'Side 4': 1 });
});

test('render() writes the operator-facing result summary and tables', () => {
  const { Results } = loadResults();
  const result = Results.compute(makeSession());
  const container = { innerHTML: '' };
  Results.render(result, container);

  assert.match(container.innerHTML, /Unique Bunches/);
  assert.match(container.innerHTML, /Total Detections/);
  assert.match(container.innerHTML, /Linked Duplicates/);
  assert.match(container.innerHTML, /class-b2/);
  assert.match(container.innerHTML, /Side 4/);
});

test('exportCSV(), exportJSON(), and exportIdentityJSON() produce expected downloadable artifacts', async () => {
  const { Results, downloads } = loadResults();
  const session = makeSession();
  const result = Results.compute(session);

  Results.exportCSV(session, result);
  Results.exportJSON(session, result);
  Results.exportIdentityJSON(session, result);

  const texts = await downloadTexts(downloads);
  assert.match(texts['DAMIMAS_A21B_0001_result.csv'], /^tree_name,split,unique,raw,B1,B2,B3,B4\n/);
  assert.match(texts['DAMIMAS_A21B_0001_result.csv'], /DAMIMAS_A21B_0001,train,2,4,1,1,0,0/);

  const sessionJson = JSON.parse(texts['DAMIMAS_A21B_0001_session.json']);
  assert.equal(sessionJson.result.uniqueCount, 2);
  assert.equal(sessionJson.result.rawCount, 4);
  assert.ok(sessionJson.exportedAt);

  const identityJson = JSON.parse(texts['DAMIMAS_A21B_0001_identity.json']);
  assert.equal(identityJson.totalUniqueBunches, 2);
  assert.equal(identityJson.classMismatchCount, 1);
  assert.equal(identityJson.bunches.some(b => b.classMismatch), true);
});

test('exports write through the Storage adapter on native (not a no-op blob download)', async () => {
  // Regression: the Android WebView ignores blob/anchor downloads, so the export
  // buttons silently did nothing. They must route through Storage.saveExport.
  const saved = [];
  const safMirror = [];
  const Storage = {
    isNative: () => true,
    active: () => ({
      saveExport: async (filename, content) => {
        saved.push({ filename, content });
        return { ok: true, dirName: 'PalmAnnotate/exports' };
      },
    }),
  };
  const SafStore = {
    isSupported: () => true,
    writeText: async (relPath, content) => { safMirror.push({ relPath, content }); return { ok: true }; },
  };
  const { doc, URLStub, downloads } = makeDownloadDom();
  const ActiveSession = { toJSON: () => ({ version: 1, treeName: 'DAMIMAS_A21B_0001', sides: [] }) };
  const ctx = loadModule(['js/yolo-io.js', 'js/dedup-utils.js', 'js/results.js'], {
    globals: { document: doc, URL: URLStub, Blob, ActiveSession, Storage, SafStore },
  });
  const session = makeSession();
  const result = ctx.Results.compute(session);

  const summary = await ctx.Results.exportCSV(session, result);
  assert.equal(summary.native, true);
  assert.equal(summary.count, 1);
  assert.equal(downloads.length, 0, 'must not fall back to a blob download on native');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].filename, 'DAMIMAS_A21B_0001_result.csv');
  assert.match(saved[0].content, /DAMIMAS_A21B_0001,train,2,4/);
  // Also mirrored into the SAF export folder under exports/.
  assert.equal(safMirror[0].relPath, 'exports/DAMIMAS_A21B_0001_result.csv');
});

test('exportYoloWithMismatch() splits unresolved class-mismatch boxes into side-specific mismatch files', async () => {
  const { Results, downloads } = loadResults();
  const session = makeSession();
  const result = Results.compute(session);

  Results.exportYoloWithMismatch(session, result);
  const texts = await downloadTexts(downloads);

  assert.equal(Object.keys(texts).sort().join('|'), [
    'DAMIMAS_A21B_0001_1.txt',
    'DAMIMAS_A21B_0001_1_mismatch.txt',
    'DAMIMAS_A21B_0001_2.txt',
    'DAMIMAS_A21B_0001_2_mismatch.txt',
    'DAMIMAS_A21B_0001_3.txt',
    'DAMIMAS_A21B_0001_3_mismatch.txt',
    'DAMIMAS_A21B_0001_4.txt',
  ].sort().join('|'));

  assert.equal(texts['DAMIMAS_A21B_0001_1.txt'], '');
  assert.match(texts['DAMIMAS_A21B_0001_1_mismatch.txt'], /^1 /);
  assert.match(texts['DAMIMAS_A21B_0001_2_mismatch.txt'], /^1 /);
  assert.match(texts['DAMIMAS_A21B_0001_3_mismatch.txt'], /^2 /);
  assert.match(texts['DAMIMAS_A21B_0001_4.txt'], /^0 /);
});

