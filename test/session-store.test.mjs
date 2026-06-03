'use strict';

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    key(index) { return Array.from(map.keys())[index] || null; },
    raw: map,
  };
}

function loadWebStore(localStorage = makeLocalStorage()) {
  const quietConsole = { ...console, warn() {} };
  const ctx = loadModule('js/persist/session-store.js', { globals: { localStorage, console: quietConsole } });
  return { SessionStore: ctx.SessionStore, localStorage };
}

function loadNativeStore() {
  const map = new Map();
  const Preferences = {
    async get({ key }) {
      return { value: map.has(key) ? map.get(key) : null };
    },
    async set({ key, value }) {
      map.set(key, value);
    },
    async remove({ key }) {
      map.delete(key);
    },
  };
  const Capacitor = {
    isNativePlatform: () => true,
    Plugins: { Preferences },
  };
  const quietConsole = { ...console, warn() {} };
  const ctx = loadModule('js/persist/session-store.js', { globals: { Capacitor, console: quietConsole } });
  return { SessionStore: ctx.SessionStore, map };
}

test('web SessionStore merges settings and keeps captured registry deduped by tree name', async () => {
  const { SessionStore } = loadWebStore();

  assert.deepEqual(await SessionStore.getSettings(), {});
  assert.deepEqual(await SessionStore.setSettings({ operator: 'Ana' }), { operator: 'Ana' });
  assert.deepEqual(await SessionStore.setSettings({ defaultVariety: 'DAMIMAS' }), {
    operator: 'Ana',
    defaultVariety: 'DAMIMAS',
  });

  await SessionStore.addCapturedTree({
    name: 'TREE_001',
    split: 'field',
    metadata: { operator: 'Ana' },
    sides: [{ imageUri: 'img-1', labelUri: 'txt-1', ignored: 'drop-me' }],
  });
  const registry = await SessionStore.addCapturedTree({
    name: 'TREE_001',
    split: 'train',
    metadata: { operator: 'Budi' },
    sides: [{ imageUri: 'img-new' }],
  });

  assert.equal(registry.length, 1);
  assert.equal(registry[0].split, 'train');
  assert.deepEqual(registry[0].sides, [{ imageUri: 'img-new', labelUri: null }]);
});

test('snapshots are per-tree, URL-safe, clearable, and included in clearAll()', async () => {
  const { SessionStore, localStorage } = loadWebStore();
  await SessionStore.addCapturedTree({ name: 'TREE 001/unsafe', sides: [] });

  assert.equal(await SessionStore.saveSnapshot('TREE 001/unsafe', { dirty: true }), true);
  assert.deepEqual(await SessionStore.loadSnapshot('TREE 001/unsafe'), { dirty: true });

  const snapshotKey = Array.from(localStorage.raw.keys()).find(k => k.startsWith('palmannotate.snapshot.'));
  assert.match(snapshotKey, /TREE%20001%2Funsafe/);

  assert.equal(await SessionStore.clearSnapshot('TREE 001/unsafe'), true);
  assert.equal(await SessionStore.loadSnapshot('TREE 001/unsafe'), null);

  await SessionStore.saveSnapshot('TREE 001/unsafe', { dirty: true });
  await SessionStore.setSettings({ operator: 'Ana' });
  assert.equal(await SessionStore.clearAll(), true);
  assert.equal(localStorage.length, 0);
});

test('native SessionStore uses Capacitor Preferences and survives malformed stored values', async () => {
  const { SessionStore, map } = loadNativeStore();
  map.set('palmannotate.settings', '{bad json');

  assert.deepEqual(await SessionStore.getSettings(), {});
  await SessionStore.setSettings({ operator: 'Native' });
  assert.deepEqual(JSON.parse(map.get('palmannotate.settings')), { operator: 'Native' });

  map.set('palmannotate.capturedRegistry', JSON.stringify({ not: 'array' }));
  assert.deepEqual(await SessionStore.getCapturedRegistry(), []);

  await SessionStore.saveSnapshot('NATIVE_TREE', { ok: true });
  assert.deepEqual(await SessionStore.loadSnapshot('NATIVE_TREE'), { ok: true });
  assert.equal(await SessionStore.clearAll(), true);
  assert.equal(map.has('palmannotate.settings'), false);
  assert.equal(map.has('palmannotate.capturedRegistry'), false);
  assert.equal(map.has('palmannotate.snapshot.NATIVE_TREE'), true,
    'native clearAll only knows snapshots referenced by registry; unregistered ad-hoc snapshots remain');
});
