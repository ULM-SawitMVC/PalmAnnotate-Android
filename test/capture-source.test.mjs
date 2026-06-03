'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, waitFor } from './dom-stub.mjs';

function loadCaptureSources(globals = {}) {
  return loadModule('js/capture/capture-source.js', { globals });
}

test('CaptureSources exposes the built-in camera source as default and accepts custom sources', async () => {
  const ctx = loadCaptureSources();

  assert.equal(ctx.BuiltinCameraSource.id, 'builtin-camera');
  assert.equal(ctx.CaptureSources.default().id, 'builtin-camera');
  assert.equal(await ctx.BuiltinCameraSource.isAvailable(), true);

  const fake = {
    id: 'fake-source',
    name: 'Fake Source',
    async isAvailable() { return true; },
    async capture() { return { blob: new Blob(['x']), width: 1, height: 1 }; },
  };
  ctx.CaptureSources.register(fake);

  assert.equal(ctx.CaptureSources.get('fake-source'), fake);
  assert.equal(ctx.CaptureSources.list().some(s => s.id === 'fake-source'), true);
  assert.equal(ctx.CaptureSources.default().id, 'builtin-camera');
});

test('native built-in capture falls back to web path when Capacitor Camera plugin is absent', async () => {
  let inputClicked = false;
  const input = {
    type: '',
    accept: '',
    style: {},
    files: [],
    setAttribute() {},
    addEventListener(event, handler) {
      if (event === 'change') this._change = handler;
    },
    remove() {},
    click() {
      inputClicked = true;
      setTimeout(() => {
        this.files = [];
        if (this._change) this._change();
      }, 0);
    },
  };
  const document = {
    createElement(tag) {
      if (String(tag).toLowerCase() === 'input') return input;
      return { style: {}, appendChild() {}, remove() {} };
    },
    body: { appendChild() {} },
  };
  const Capacitor = {
    isNativePlatform: () => true,
    Plugins: {},
  };

  const ctx = loadCaptureSources({ document, Capacitor });
  const result = await ctx.BuiltinCameraSource.capture();

  assert.equal(inputClicked, true);
  assert.equal(result, null);
});

test('native built-in capture uses Capacitor Camera URI and measures fetched photo', async () => {
  const calls = [];
  const blob = new Blob(['native-photo'], { type: 'image/jpeg' });
  const Capacitor = {
    isNativePlatform: () => true,
    convertFileSrc(path) {
      calls.push(['convertFileSrc', path]);
      return 'webview://' + path;
    },
    Plugins: {
      Camera: {
        async getPhoto(opts) {
          calls.push(['getPhoto', opts]);
          return { path: 'file:///camera/photo.jpg' };
        },
      },
    },
  };
  const ctx = loadCaptureSources({
    Capacitor,
    fetch: async url => {
      calls.push(['fetch', url]);
      return { blob: async () => blob };
    },
    createImageBitmap: async input => {
      calls.push(['createImageBitmap', input.type]);
      return { width: 4032, height: 3024, close() { calls.push(['bitmap.close']); } };
    },
  });

  const result = await ctx.BuiltinCameraSource.capture();

  assert.equal(result.blob, blob);
  assert.equal(result.width, 4032);
  assert.equal(result.height, 3024);
  assert.deepEqual(calls[0], ['getPhoto', { resultType: 'uri', source: 'CAMERA', quality: 85 }]);
  assert.deepEqual(calls[1], ['convertFileSrc', 'file:///camera/photo.jpg']);
  assert.deepEqual(calls[2], ['fetch', 'webview://file:///camera/photo.jpg']);
  assert.deepEqual(calls[3], ['createImageBitmap', 'image/jpeg']);
  assert.deepEqual(calls[4], ['bitmap.close']);
});

test('native built-in capture returns null when Camera plugin is cancelled', async () => {
  const quietConsole = { ...console, info() {} };
  const ctx = loadCaptureSources({
    console: quietConsole,
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        Camera: {
          async getPhoto() {
            throw new Error('cancelled');
          },
        },
      },
    },
  });

  assert.equal(await ctx.BuiltinCameraSource.capture(), null);
});

test('web getUserMedia capture uses shutter, stops stream, and returns canvas dimensions', async () => {
  const { document } = makeDom();
  const stops = [];
  const stream = {
    getTracks() {
      return [{ stop() { stops.push('video'); } }];
    },
  };
  const ctx = loadCaptureSources({
    document,
    navigator: {
      mediaDevices: {
        async getUserMedia(opts) {
          assert.deepEqual(opts, { video: { facingMode: 'environment' }, audio: false });
          return stream;
        },
      },
    },
  });

  const promise = ctx.BuiltinCameraSource.capture();
  const video = await waitFor(() => document.querySelector('.capture-cam__video'));
  video.videoWidth = 1280;
  video.videoHeight = 720;

  document.querySelector('.capture-cam__shutter').click();
  const result = await promise;

  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.blob.type, 'image/png');
  assert.deepEqual(stops, ['video']);
  assert.equal(document.querySelector('.capture-cam'), null);
});

test('web getUserMedia capture cancel stops stream and removes camera overlay', async () => {
  const { document } = makeDom();
  const stops = [];
  const stream = {
    getTracks() {
      return [{ stop() { stops.push('video'); } }];
    },
  };
  const ctx = loadCaptureSources({
    document,
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return stream;
        },
      },
    },
  });

  const promise = ctx.BuiltinCameraSource.capture();
  await waitFor(() => document.querySelector('.capture-cam__video'));

  document.querySelector('.capture-cam__cancel').click();
  const result = await promise;

  assert.equal(result, null);
  assert.deepEqual(stops, ['video']);
  assert.equal(document.querySelector('.capture-cam'), null);
});

test('web file-input fallback returns the selected photo dimensions and cleans the hidden input', async () => {
  const { document } = makeDom();
  const originalCreateElement = document.createElement.bind(document);
  const selectedPhoto = new Blob(['fallback-photo'], { type: 'image/jpeg' });
  const appended = [];
  let input = null;

  document.body.appendChild = function appendChild(node) {
    appended.push(node);
    node.parentNode = this;
    node.ownerDocument = document;
    this.children.push(node);
    return node;
  };
  document.body.removeChild = function removeChild(node) {
    const idx = this.children.indexOf(node);
    if (idx !== -1) this.children.splice(idx, 1);
    node.parentNode = null;
    return node;
  };
  document.createElement = function createElement(tag) {
    const el = originalCreateElement(tag);
    if (String(tag).toLowerCase() === 'input') {
      input = el;
      el.click = () => {
        setTimeout(() => {
          el.files = [selectedPhoto];
          el.dispatchEvent({ type: 'change', target: el });
        }, 0);
      };
    }
    return el;
  };

  const ctx = loadCaptureSources({
    document,
    navigator: {},
    createImageBitmap: async blob => {
      assert.equal(blob, selectedPhoto);
      return { width: 1600, height: 1200, close() {} };
    },
  });

  const result = await ctx.BuiltinCameraSource.capture();

  assert.equal(result.blob, selectedPhoto);
  assert.equal(result.width, 1600);
  assert.equal(result.height, 1200);
  assert.equal(input.type, 'file');
  assert.equal(input.accept, 'image/*');
  assert.equal(input.getAttribute('capture'), 'environment');
  assert.equal(input.style.position, 'fixed');
  assert.equal(input.style.left, '-9999px');
  assert.equal(input.parentNode, null);
  assert.equal(appended.length, 1);
});
