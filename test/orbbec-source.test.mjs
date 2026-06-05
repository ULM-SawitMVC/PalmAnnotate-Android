'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom } from './dom-stub.mjs';

const quietConsole = { ...console, info() {} };

function loadOrbbec({ native = true, plugin = null } = {}) {
  const Capacitor = {
    isNativePlatform: () => native,
    Plugins: plugin ? { Orbbec: plugin } : {},
  };
  return loadModule(['js/capture/capture-source.js', 'js/capture/orbbec-source.js'], {
    globals: {
      console: quietConsole,
      Capacitor,
      Blob,
      Uint8Array,
      atob: value => Buffer.from(value, 'base64').toString('binary'),
    },
  });
}

// Variant with a real fake DOM so the live-preview path (mountPreview) can build
// and query its RGB/depth elements.
function loadOrbbecDom(plugin) {
  const dom = makeDom();
  const Capacitor = { isNativePlatform: () => true, Plugins: plugin ? { Orbbec: plugin } : {} };
  const ctx = loadModule(['js/capture/capture-source.js', 'js/capture/orbbec-source.js'], {
    globals: {
      console: quietConsole,
      document: dom.document,
      Capacitor,
      Blob,
      Uint8Array,
      createImageBitmap: undefined,
      atob: value => Buffer.from(value, 'base64').toString('binary'),
    },
  });
  return { ctx, dom };
}

test('OrbbecSource registers as optional and does not replace built-in camera default', async () => {
  const ctx = loadOrbbec({
    plugin: {
      async isAvailable() { return { available: true }; },
    },
  });

  assert.equal(ctx.OrbbecSource.id, 'orbbec');
  assert.equal(ctx.CaptureSources.get('orbbec'), ctx.OrbbecSource);
  assert.equal(ctx.CaptureSources.default().id, 'builtin-camera');
  assert.equal(await ctx.OrbbecSource.isAvailable(), true);
});

test('OrbbecSource is unavailable on web, missing plugin, or plugin errors', async () => {
  assert.equal(await loadOrbbec({ native: false }).OrbbecSource.isAvailable(), false);
  assert.equal(await loadOrbbec({ plugin: null }).OrbbecSource.isAvailable(), false);
  assert.equal(await loadOrbbec({
    plugin: {
      async isAvailable() { throw new Error('usb failure'); },
    },
  }).OrbbecSource.isAvailable(), false);
});

test('OrbbecSource capture opens native plugin and converts base64 frame to Blob', async () => {
  const calls = [];
  const ctx = loadOrbbec({
    plugin: {
      async isAvailable() { return { available: true }; },
      async requestPermission() { calls.push('requestPermission'); return { granted: true }; },
      async open() { calls.push('open'); },
      async capture() {
        calls.push('capture');
        return {
          base64: Buffer.from('jpeg-bytes').toString('base64'),
          width: 640,
          height: 480,
          format: 'jpeg',
        };
      },
    },
  });

  const frame = await ctx.OrbbecSource.capture();
  assert.deepEqual(calls, ['requestPermission', 'open', 'capture']);
  assert.equal(frame.width, 640);
  assert.equal(frame.height, 480);
  assert.equal(frame.blob.type, 'image/jpeg');
  assert.equal(await frame.blob.text(), 'jpeg-bytes');
});

test('OrbbecSource capture carries raw depth sidecar when native frame includes it', async () => {
  const ctx = loadOrbbec({
    plugin: {
      async requestPermission() { return { granted: true }; },
      async open() {},
      async capture() {
        return {
          base64: Buffer.from('jpeg-bytes').toString('base64'),
          width: 640,
          height: 480,
          format: 'jpeg',
          depthBase64: Buffer.from([1, 0, 2, 0]).toString('base64'),
          depthWidth: 640,
          depthHeight: 480,
          depthFormat: 'Y16',
          depthValueScale: 0.1,
          depthEncoding: 'uint16le',
          depthUnit: 'mm',
          depthAlignedTo: 'color',
          depthDisplayFloorMm: 250,
          depthDisplayCeilingMm: 7000,
        };
      },
    },
  });

  const frame = await ctx.OrbbecSource.capture();
  assert.equal(frame.depthBlob.type, 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await frame.depthBlob.arrayBuffer())], [1, 0, 2, 0]);
  assert.deepEqual(frame.depth, {
    width: 640,
    height: 480,
    format: 'Y16',
    encoding: 'uint16le',
    valueScale: 0.1,
    unit: 'mm',
    alignedTo: 'color',
    displayFloorMm: 250,
    displayCeilingMm: 7000,
  });
});

test('OrbbecSource capture rejects when USB permission is denied', async () => {
  await assert.rejects(
    () => loadOrbbec({
      plugin: {
        async requestPermission() { return { granted: false }; },
        async open() { throw new Error('should not open'); },
        async capture() { throw new Error('should not capture'); },
      },
    }).OrbbecSource.capture(),
    /Orbbec USB permission denied/
  );
});

test('OrbbecSource capture rejects clearly when plugin or frame payload is missing', async () => {
  await assert.rejects(
    () => loadOrbbec({ plugin: null }).OrbbecSource.capture(),
    /Orbbec plugin unavailable/
  );

  await assert.rejects(
    () => loadOrbbec({
      plugin: {
        async capture() { return {}; },
      },
    }).OrbbecSource.capture(),
    /Orbbec capture returned no frame/
  );
});

test('OrbbecSource.supportsLivePreview tracks the streaming plugin API', () => {
  assert.equal(
    loadOrbbec({ plugin: { startPreview() {}, addListener() {} } }).OrbbecSource.supportsLivePreview(),
    true
  );
  // Missing the streaming methods → no live preview (one-shot Capture only).
  assert.equal(loadOrbbec({ plugin: { isAvailable() {} } }).OrbbecSource.supportsLivePreview(), false);
  // Web runtime is never live for the USB camera.
  assert.equal(
    loadOrbbec({ native: false, plugin: { startPreview() {}, addListener() {} } }).OrbbecSource.supportsLivePreview(),
    false
  );
});

test('OrbbecSource.mountPreview subscribes to frames, starts the pump, renders RGB+depth, and stops cleanly', async () => {
  const calls = [];
  let frameCb = null;
  const removed = { listener: false, preview: false };
  const plugin = {
    async requestPermission() { calls.push('perm'); return { granted: true }; },
    async addListener(name, cb) { calls.push('addListener:' + name); frameCb = cb; return { remove: async () => { removed.listener = true; } }; },
    async startPreview() { calls.push('startPreview'); return { streaming: true }; },
    async stopPreview() { calls.push('stopPreview'); removed.preview = true; return { stopped: true }; },
  };
  const { ctx, dom } = loadOrbbecDom(plugin);
  const stage = dom.document.createElement('div');

  const stop = await ctx.OrbbecSource.mountPreview(stage);
  assert.deepEqual(calls, ['perm', 'addListener:orbbecFrame', 'startPreview']);
  assert.ok(stage.querySelector('.orbbec-live'), 'live wrapper mounted into the stage');

  // RGB-only frames temporarily hide the PiP; a later throttled depth frame restores it.
  frameCb({ rgb: 'AAAA', width: 1280, height: 720 });
  assert.equal(stage.querySelector('.orbbec-live__main').src, 'data:image/jpeg;base64,AAAA');
  assert.equal(stage.querySelector('.orbbec-live__pip').classList.contains('orbbec-live__pip--empty'), true);
  frameCb({ depth: 'BBBB', width: 1280, height: 720 });
  assert.equal(stage.querySelector('.orbbec-live__pipimg').src, 'data:image/jpeg;base64,BBBB');
  assert.equal(stage.querySelector('.orbbec-live__pip').classList.contains('orbbec-live__pip--empty'), false);

  await stop();
  assert.equal(removed.listener, true, 'frame listener removed on stop');
  assert.equal(removed.preview, true, 'native pump stopped on stop');
  assert.equal(stage.querySelector('.orbbec-live'), null, 'preview DOM removed on stop');
});

test('OrbbecSource.mountPreview cleans listener and DOM when native startPreview fails', async () => {
  let removed = false;
  const { ctx, dom } = loadOrbbecDom({
    async requestPermission() { return { granted: true }; },
    async addListener() { return { remove: async () => { removed = true; } }; },
    async startPreview() { throw new Error('device disconnected'); },
  });
  const stage = dom.document.createElement('div');

  await assert.rejects(() => ctx.OrbbecSource.mountPreview(stage), /device disconnected/);
  assert.equal(removed, true, 'frame listener should be removed after start failure');
  assert.equal(stage.querySelector('.orbbec-live'), null, 'preview DOM should be removed after start failure');
});

test('OrbbecSource.mountPreview rejects (so capture falls back) when USB permission is denied', async () => {
  const { ctx, dom } = loadOrbbecDom({
    async requestPermission() { return { granted: false }; },
    async addListener() { return { remove() {} }; },
    async startPreview() { throw new Error('should not start'); },
  });
  await assert.rejects(() => ctx.OrbbecSource.mountPreview(dom.document.createElement('div')),
    /Orbbec USB permission denied/);
});

test('OrbbecSource.grab returns a full-resolution frame from the running stream', async () => {
  const { ctx } = loadOrbbecDom({
    async capture() {
      return { base64: Buffer.from('jpeg-bytes').toString('base64'), width: 1280, height: 720, format: 'jpeg' };
    },
  });
  const shot = await ctx.OrbbecSource.grab();
  assert.equal(shot.width, 1280);
  assert.equal(shot.height, 720);
  assert.equal(await shot.blob.text(), 'jpeg-bytes');
});

test('OrbbecSource.refresh re-scans via plugin.refresh, falling back to isAvailable', async () => {
  assert.equal(
    await loadOrbbec({ plugin: { async refresh() { return { available: true, count: 1 }; } } }).OrbbecSource.refresh(),
    true
  );
  assert.equal(
    await loadOrbbec({ plugin: { async isAvailable() { return { available: false }; } } }).OrbbecSource.refresh(),
    false
  );
  assert.equal(await loadOrbbec({ native: false }).OrbbecSource.refresh(), false);
});
