'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

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
