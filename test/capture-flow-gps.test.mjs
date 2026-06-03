'use strict';

// Coverage for the capture-flow GPS path (the "GPS Unavailable" fix). We drive
// the real metadata form's "Get GPS" button so the private _getPosition() is
// exercised through its actual wiring, across all four resolution paths:
//   1. native Capacitor Geolocation plugin (granted)
//   2. native plugin permission denied  → no position request, status cleared
//   3. web navigator.geolocation         → coords
//   4. web geolocation error / none      → "Unavailable" (never throws)

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, findByText, waitFor } from './dom-stub.mjs';

// Open CaptureFlow's metadata form and hand back the GPS controls plus a
// `cancel()` that tears the flow down (resolving its start() promise).
function openGpsForm(extraGlobals = {}) {
  const dom = makeDom();
  const ctx = loadModule('js/capture/capture-flow.js', {
    globals: {
      document: dom.document,
      navigator: {},
      URL: { createObjectURL: () => 'blob://x', revokeObjectURL() {} },
      CaptureSources: { default: () => ({ id: 'stub', async capture() { return null; } }) },
      Storage: { active: () => ({}) },
      ...extraGlobals,
    },
  });

  const done = ctx.CaptureFlow.start({ sideCount: 2 });
  const gpsBtn = findByText(dom.document.body, 'button', 'Get GPS');
  assert.ok(gpsBtn, 'metadata form exposes a "Get GPS" button');
  const gpsStatus = dom.document.body.querySelector('.capture-gps__status');
  assert.ok(gpsStatus, 'metadata form exposes a GPS status element');

  function cancel() {
    const cancelBtn = findByText(dom.document.body, 'button', 'Cancel');
    if (cancelBtn) cancelBtn.click();
    return done;
  }
  return { gpsBtn, gpsStatus, cancel };
}

const settled = (status) =>
  status.textContent !== 'Locating…' && status.textContent !== 'Not set';

test('GPS via native Capacitor Geolocation plugin shows the fixed coordinates', async () => {
  let positionRequested = false;
  const Capacitor = {
    Plugins: {
      Geolocation: {
        async requestPermissions() { return { location: 'granted' }; },
        async getCurrentPosition() {
          positionRequested = true;
          return { coords: { latitude: 1.234567, longitude: 103.456789, accuracy: 5 } };
        },
      },
    },
  };

  const { gpsBtn, gpsStatus, cancel } = openGpsForm({ Capacitor });
  gpsBtn.click();

  await waitFor(() => settled(gpsStatus));
  assert.equal(positionRequested, true);
  assert.equal(gpsStatus.textContent, '1.23457, 103.45679');
  await cancel();
});

test('GPS denial on native plugin degrades to "Unavailable" without requesting a fix', async () => {
  let positionRequested = false;
  const Capacitor = {
    Plugins: {
      Geolocation: {
        async requestPermissions() { return { location: 'denied' }; },
        async getCurrentPosition() { positionRequested = true; return { coords: {} }; },
      },
    },
  };

  const { gpsBtn, gpsStatus, cancel } = openGpsForm({ Capacitor });
  gpsBtn.click();

  await waitFor(() => settled(gpsStatus));
  assert.equal(positionRequested, false, 'a denied permission must not request a position');
  assert.equal(gpsStatus.textContent, 'Unavailable');
  await cancel();
});

test('GPS via web navigator.geolocation shows the fixed coordinates', async () => {
  const navigator = {
    geolocation: {
      getCurrentPosition(success) {
        success({ coords: { latitude: -2.5, longitude: 117.25, accuracy: 12 } });
      },
    },
  };

  const { gpsBtn, gpsStatus, cancel } = openGpsForm({ navigator });
  gpsBtn.click();

  await waitFor(() => settled(gpsStatus));
  assert.equal(gpsStatus.textContent, '-2.50000, 117.25000');
  await cancel();
});

test('GPS error on web geolocation degrades to "Unavailable" (no throw)', async () => {
  const navigator = {
    geolocation: {
      getCurrentPosition(_success, error) { error(new Error('denied')); },
    },
  };

  const { gpsBtn, gpsStatus, cancel } = openGpsForm({ navigator });
  gpsBtn.click();

  await waitFor(() => settled(gpsStatus));
  assert.equal(gpsStatus.textContent, 'Unavailable');
  await cancel();
});

test('GPS with no geolocation provider at all degrades to "Unavailable"', async () => {
  const { gpsBtn, gpsStatus, cancel } = openGpsForm({ navigator: {} });
  gpsBtn.click();

  await waitFor(() => settled(gpsStatus));
  assert.equal(gpsStatus.textContent, 'Unavailable');
  await cancel();
});
