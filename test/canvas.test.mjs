'use strict';

// Unit coverage for js/canvas.js (CanvasRenderer): the colour helpers that the
// editor / dedup / carousel all rely on for class-consistent colouring, plus
// drawDetections() label composition — including the regression guard for the
// "NaN%" label that appeared when a box carried no confidence score.

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

function loadCanvas() {
  const ctx = loadModule('js/canvas.js');
  return ctx.CanvasRenderer;
}

// A 2D-context spy that records every fillText so we can assert on labels.
function recordingCtx() {
  const calls = { fillText: [], strokeRect: [], fillRect: [] };
  return {
    calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    strokeRect(...a) { calls.strokeRect.push(a); },
    fillRect(...a) { calls.fillRect.push(a); },
    fillText(text, x, y) { calls.fillText.push({ text, x, y }); },
    measureText(text) { return { width: String(text || '').length * 7 }; },
  };
}

test('getColor wraps around the palette by modulo', () => {
  const R = loadCanvas();
  assert.equal(R.getColor(0), R.getColor(10), '10 colours → index 10 wraps to 0');
  assert.equal(R.getColor(3), R.getColor(13));
  assert.notEqual(R.getColor(0), R.getColor(1));
});

test('normalizeClassKey trims, strips spaces, and uppercases; null → OBJECT', () => {
  const R = loadCanvas();
  assert.equal(R.normalizeClassKey('  b1 '), 'B1');
  assert.equal(R.normalizeClassKey('Ripe Bunch'), 'RIPEBUNCH');
  assert.equal(R.normalizeClassKey(null), 'OBJECT');
  assert.equal(R.normalizeClassKey(undefined), 'OBJECT');
});

test('getClassColor returns the explicit maturity colour for B0–B6', () => {
  const R = loadCanvas();
  assert.equal(R.getClassColor('B1'), '#3b82f6');
  assert.equal(R.getClassColor('b2'), '#ef4444', 'case-insensitive via normalize');
  assert.equal(R.getClassColor('B4'), '#8b5cf6');
});

test('getClassColor is deterministic for unmapped classes (stable hash)', () => {
  const R = loadCanvas();
  const first = R.getClassColor('ZZTOP');
  assert.equal(first, R.getClassColor('ZZTOP'), 'same input → same colour');
  assert.ok(first.startsWith('#'));
});

test('getTrackColor: null/undefined → first colour, numeric → modulo palette', () => {
  const R = loadCanvas();
  assert.equal(R.getTrackColor(null), R.getColor(0));
  assert.equal(R.getTrackColor(undefined), R.getColor(0));
  assert.equal(R.getTrackColor(13), R.getColor(3));
  assert.equal(R.getTrackColor(-3), R.getColor(3), 'negative ids use abs value');
});

test('drawDetections renders a percentage label when confidence is present', () => {
  const R = loadCanvas();
  const ctx = recordingCtx();
  R.drawDetections(ctx, [
    { box: { x1: 10, y1: 10, x2: 110, y2: 110 }, name: 'B1', confidence: 0.95 },
  ], 1000, 1000);
  assert.equal(ctx.calls.fillText.length, 1);
  assert.equal(ctx.calls.fillText[0].text, 'B1 95.0%');
});

test('drawDetections omits the percentage instead of printing "NaN%" when conf is absent', () => {
  const R = loadCanvas();
  const ctx = recordingCtx();
  // A manually-drawn box (no confidence / conf field) — the regression case.
  R.drawDetections(ctx, [
    { box: { x1: 0, y1: 0, x2: 50, y2: 50 }, name: 'B2' },
  ], 800, 600);
  assert.equal(ctx.calls.fillText.length, 1);
  assert.equal(ctx.calls.fillText[0].text, 'B2', 'no trailing percentage');
  assert.doesNotMatch(ctx.calls.fillText[0].text, /NaN/);
});

test('drawDetections supports array boxes, the conf alias, and a track-id prefix', () => {
  const R = loadCanvas();
  const ctx = recordingCtx();
  R.drawDetections(ctx, [
    { bbox: [0, 0, 20, 20], name: 'B3', conf: 0.5, trackId: 7 },
  ], 640, 640);
  assert.equal(ctx.calls.fillText[0].text, '#7 B3 50.0%');
});

test('drawDetections is a no-op for empty / missing detection lists', () => {
  const R = loadCanvas();
  const ctx = recordingCtx();
  R.drawDetections(ctx, [], 100, 100);
  R.drawDetections(ctx, null, 100, 100);
  assert.equal(ctx.calls.fillText.length, 0);
  assert.equal(ctx.calls.strokeRect.length, 0);
});

test('drawDetections skips entries that carry no box', () => {
  const R = loadCanvas();
  const ctx = recordingCtx();
  R.drawDetections(ctx, [{ name: 'B1', confidence: 0.9 }], 100, 100);
  assert.equal(ctx.calls.fillText.length, 0, 'no box → nothing drawn');
});
