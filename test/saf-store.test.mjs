'use strict';

// Coverage for SafStore — the optional Storage Access Framework "export folder"
// wrapper. We load the REAL SessionStore alongside SafStore (SafStore remembers
// the chosen folder in settings) and drive it through a mock native Saf plugin.
// The native SafPlugin.kt itself (DocumentFile I/O) is out of scope for node.

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    key(i) { return Array.from(map.keys())[i] || null; },
  };
}

// Mirrors the FileReader stub used in storage.test.mjs: readAsDataURL yields a
// base64 "ZmFrZQ==" payload so writeImage's blob→base64 path is exercised.
function makeFileReaderStub() {
  return class FakeFileReader {
    constructor() { this.onload = null; this.onerror = null; this.result = ''; }
    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,ZmFrZQ==';
      if (this.onload) this.onload();
    }
  };
}

function makeSaf(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    async pickFolder() {
      calls.push(['pickFolder', {}]);
      return { uri: 'content://tree/primary%3APalmExport', name: 'PalmExport' };
    },
    async hasFolder(args) { calls.push(['hasFolder', args]); return { has: true, name: 'PalmExport' }; },
    async writeFile(args) { calls.push(['writeFile', args]); return { ok: true }; },
    async deletePath(args) { calls.push(['deletePath', args]); return { ok: true, removed: /_1\.jpg$/.test(args.relPath) }; },
    async releaseFolder(args) { calls.push(['releaseFolder', args]); },
  };
  return Object.assign(base, overrides);
}

function loadSaf({ native = true, saf = makeSaf() } = {}) {
  const localStorage = makeLocalStorage();
  const Capacitor = native
    ? { isNativePlatform: () => true, Plugins: { Saf: saf } }
    : { isNativePlatform: () => false, Plugins: {} };
  const quiet = { ...console, warn() {}, info() {} };
  const ctx = loadModule(['js/persist/session-store.js', 'js/storage/saf-store.js'], {
    globals: { Capacitor, Blob, FileReader: makeFileReaderStub(), localStorage, console: quiet },
  });
  return { SafStore: ctx.SafStore, SessionStore: ctx.SessionStore, saf };
}

test('SafStore is unsupported on web and degrades to no-ops (never throws)', async () => {
  const { SafStore } = loadSaf({ native: false });
  assert.equal(SafStore.isSupported(), false);
  assert.equal(await SafStore.current(), null);
  assert.equal(await SafStore.pickFolder(), null);
  assert.deepEqual(await SafStore.writeJson('dataset/x.json', { a: 1 }), { ok: false, skipped: true });
  assert.deepEqual(await SafStore.writeImage('dataset/x.jpg', new Blob(['x'])), { ok: false, skipped: true });
  assert.deepEqual(await SafStore.deleteDatasetTree('TREE_0001', 4), { ok: false, skipped: true, removed: 0 });
});

test('pickFolder persists the chosen folder and current() re-verifies it', async () => {
  const { SafStore, SessionStore } = loadSaf();
  assert.equal(SafStore.isSupported(), true);

  const folder = await SafStore.pickFolder();
  assert.equal(folder.name, 'PalmExport');
  assert.equal(folder.uri, 'content://tree/primary%3APalmExport');

  // Remembered in settings so it survives an app restart.
  const s = await SessionStore.getSettings();
  assert.equal(s.safFolderUri, folder.uri);
  assert.equal(s.safFolderName, 'PalmExport');

  const cur = await SafStore.current();
  assert.equal(cur.uri, folder.uri);
});

test('current() returns null when the grant is gone, so writes are skipped', async () => {
  const saf = makeSaf({ async hasFolder() { return { has: false }; } });
  const { SafStore } = loadSaf({ saf });
  await SafStore.pickFolder();
  assert.equal(await SafStore.current(), null, 'revoked/missing grant → no folder');
  assert.deepEqual(await SafStore.writeJson('dataset/x.json', { a: 1 }), { ok: false, skipped: true });
});

test('writeImage / writeJson namespace under PalmAnnotate/ and carry the tree URI', async () => {
  const { SafStore, saf } = loadSaf();
  await SafStore.pickFolder();

  assert.equal((await SafStore.writeJson('dataset/metadata/DAMIMAS_A21B_0001.json', { tree: 'x' })).ok, true);
  assert.equal((await SafStore.writeImage('dataset/images/field/DAMIMAS_A21B_0001_1.jpg', new Blob(['x']))).ok, true);

  const writes = saf.calls.filter(c => c[0] === 'writeFile').map(c => c[1]);
  // JSON mirror
  assert.equal(writes[0].relPath, 'PalmAnnotate/dataset/metadata/DAMIMAS_A21B_0001.json');
  assert.equal(writes[0].encoding, 'utf8');
  assert.equal(writes[0].treeUri, 'content://tree/primary%3APalmExport');
  // Image mirror — base64 from the FileReader stub, under the same root.
  assert.equal(writes[1].relPath, 'PalmAnnotate/dataset/images/field/DAMIMAS_A21B_0001_1.jpg');
  assert.equal(writes[1].encoding, 'base64');
  assert.equal(writes[1].data, 'ZmFrZQ==');
});

test('deleteDatasetTree removes mirrored tree files under PalmAnnotate/', async () => {
  const { SafStore, saf } = loadSaf();
  await SafStore.pickFolder();

  const res = await SafStore.deleteDatasetTree('DAMIMAS_A21B_0001', 4);
  assert.equal(res.ok, true);
  assert.equal(res.removed, 1, 'provider-reported removed files are counted');

  const deletes = saf.calls.filter(c => c[0] === 'deletePath').map(c => c[1].relPath);
  assert.ok(deletes.includes('PalmAnnotate/dataset/images/field/DAMIMAS_A21B_0001_1.jpg'));
  assert.ok(deletes.includes('PalmAnnotate/dataset/images/field/DAMIMAS_A21B_0001_4.jpg'));
  assert.ok(deletes.includes('PalmAnnotate/dataset/metadata/DAMIMAS_A21B_0001.json'));
  assert.ok(deletes.includes('PalmAnnotate/Output JSON/DAMIMAS_A21B_0001.json'));
  assert.ok(!deletes.some(p => p.endsWith('_5.jpg')), 'respects sideCount');
});

test('clearFolder forgets the folder and releases the native grant', async () => {
  const { SafStore, SessionStore, saf } = loadSaf();
  await SafStore.pickFolder();

  await SafStore.clearFolder();
  const s = await SessionStore.getSettings();
  assert.equal(s.safFolderUri, '');
  assert.ok(saf.calls.some(c => c[0] === 'releaseFolder'), 'released the persistable grant');
  assert.equal(await SafStore.current(), null);
});
