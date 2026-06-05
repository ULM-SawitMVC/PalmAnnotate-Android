'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

function loadQuality() {
  return loadModule('js/quality-check.js');
}

test('QualityCheck capture report flags incomplete RGB-depth pairs and metadata gaps', () => {
  const { QualityCheck } = loadQuality();
  const report = QualityCheck.analyzeCaptureShots([
    { blob: new Blob(['rgb']), width: 10, height: 10, depthBlob: new Blob(['d']), depth: { width: 10, height: 10 } },
    { blob: new Blob(['rgb']), width: 10, height: 10 },
    null,
  ], 3, { variety: 'DAMIMAS', timestamp: '2026-06-05T00:00:00Z' });

  assert.equal(report.status, 'error');
  assert.equal(report.metrics.capturedSides, 2);
  assert.equal(report.metrics.depthSides, 1);
  assert.ok(report.issues.some(i => i.code === 'capture_rgb_depth_incomplete'));
  assert.ok(report.issues.some(i => i.code === 'capture_view_missing'));
  assert.ok(report.issues.some(i => i.code === 'metadata_gps_missing'));
});

test('QualityCheck tree report summarizes views, boxes, links, and class mismatch warnings', () => {
  const { QualityCheck } = loadQuality();
  const tree = {
    name: 'DAMIMAS_A22B_0001',
    metadata: { variety: 'DAMIMAS', blok: 'A22B', treeId: 1, timestamp: 'x', gps: { lat: 1, lng: 2, accuracy: 8 } },
    sides: [
      { imageUri: 'img1', depthUri: 'd1', depth: { width: 2, height: 2 } },
      { imageUri: 'img2' },
    ],
  };
  const session = {
    sideCount: 2,
    sides: [
      { sideIndex: 0, bboxes: [{ id: 'a' }] },
      { sideIndex: 1, bboxes: [] },
    ],
    confirmedLinks: [],
  };
  const report = QualityCheck.analyzeTree(tree, session, { mismatches: [{}], result: null });

  assert.equal(report.status, 'error');
  assert.equal(report.metrics.imageSides, 2);
  assert.equal(report.metrics.depthSides, 1);
  assert.equal(report.metrics.totalBoxes, 1);
  assert.ok(report.issues.some(i => i.code === 'tree_rgb_depth_incomplete'));
  assert.ok(report.issues.some(i => i.code === 'annotation_class_mismatch'));
});
