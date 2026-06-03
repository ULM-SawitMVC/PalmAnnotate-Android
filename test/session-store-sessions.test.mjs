'use strict';

// Coverage for the SessionStore sessions/groups index that powers the home
// screen (Phase 1 of the capture-flow rework). Exercised on the web backend
// (localStorage); the native Preferences path shares the same JSON helpers
// already covered by session-store.test.mjs.

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

function loadStore(localStorage = makeLocalStorage()) {
  const quietConsole = { ...console, warn() {} };
  const ctx = loadModule('js/persist/session-store.js', { globals: { localStorage, console: quietConsole } });
  return { SessionStore: ctx.SessionStore, localStorage };
}

test('createSession locks variety+blok and seeds the auto-increment counter', async () => {
  const { SessionStore } = loadStore();
  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A 21B', sideCount: 4, autoId: true });

  assert.equal(s.variety, 'DAMIMAS');
  assert.equal(s.blok, 'A 21B');
  assert.equal(s.groupKey, SessionStore.groupKeyFor('DAMIMAS', 'A21B'));
  assert.equal(s.sideCount, 4);
  assert.equal(s.autoId, true);
  assert.equal(s.nextId, 1);
  assert.deepEqual(s.trees, []);

  const fetched = await SessionStore.getSession(s.id);
  assert.equal(fetched.id, s.id);
});

test('addTreeToSession appends pohon, dedupes by name, and advances nextId', async () => {
  const { SessionStore } = loadStore();
  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B' });

  await SessionStore.addTreeToSession(s.id, {
    name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4,
    sides: [{ imageUri: 'file://1', labelUri: null }],
  });
  let after = await SessionStore.addTreeToSession(s.id, {
    name: 'DAMIMAS_A21B_0002', treeId: 2, sideCount: 4, sides: [],
  });
  assert.equal(after.trees.length, 2);
  assert.equal(after.nextId, 3, 'nextId advances past the highest tree id');

  // Re-adding the same name replaces (no duplicate pohon).
  after = await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0002', treeId: 2 });
  assert.equal(after.trees.length, 2);

  // A manual id beyond the counter still pushes nextId past it.
  after = await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0050', treeId: 50 });
  assert.equal(after.nextId, 51);
});

test('removeTreeFromSession drops one pohon, updates counts, and recomputes nextId from survivors', async () => {
  const { SessionStore } = loadStore();
  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B' });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0002', treeId: 2, sideCount: 4 });

  const before = await SessionStore.getSession(s.id);
  assert.equal(before.trees.length, 2);
  assert.equal(before.nextId, 3);

  // Deleting a non-highest tree keeps the counter (0002 still occupies its id).
  const afterLow = await SessionStore.removeTreeFromSession(s.id, 'DAMIMAS_A21B_0001');
  assert.equal(afterLow.trees.length, 1);
  assert.equal(afterLow.trees[0].name, 'DAMIMAS_A21B_0002');
  assert.equal(afterLow.nextId, 3, 'highest remaining id is 2 → next is 3');

  // Deleting the last remaining tree resets the counter back to 0001.
  const afterAll = await SessionStore.removeTreeFromSession(s.id, 'DAMIMAS_A21B_0002');
  assert.equal(afterAll.trees.length, 0);
  assert.equal(afterAll.nextId, 1, 'no trees left → counter resets to 0001');

  // Reflected in the rolled-up stats and persisted across a read.
  const stats = await SessionStore.homeStats();
  assert.equal(stats.totalPohon, 0);

  // Removing an unknown name is a no-op (still returns the session, not null).
  const noop = await SessionStore.removeTreeFromSession(s.id, 'NOPE');
  assert.equal(noop.trees.length, 0);
  // Bad session id degrades to null (non-throwing contract).
  assert.equal(await SessionStore.removeTreeFromSession('nope', 'X'), null);
});

test('removeTreeFromSession rewinds nextId when the highest tree is deleted', async () => {
  const { SessionStore } = loadStore();
  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B' });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0002', treeId: 2, sideCount: 4 });
  assert.equal((await SessionStore.getSession(s.id)).nextId, 3);

  // Deleting the highest tree frees its id (its files are unlinked too), so the
  // next capture refills 0002.
  const after = await SessionStore.removeTreeFromSession(s.id, 'DAMIMAS_A21B_0002');
  assert.equal(after.trees.length, 1);
  assert.equal(after.nextId, 2, 'highest remaining id is 1 → next refills 2');
});

test('homeStats rolls sessions up into groups by variety+blok', async () => {
  const { SessionStore } = loadStore();

  const a1 = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21A' });
  await SessionStore.addTreeToSession(a1.id, { name: 'DAMIMAS_A21A_0001', treeId: 1 });
  await SessionStore.addTreeToSession(a1.id, { name: 'DAMIMAS_A21A_0002', treeId: 2 });

  // Second session on the SAME variety+blok must roll into one group.
  const a2 = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A 21 A' });
  await SessionStore.addTreeToSession(a2.id, { name: 'DAMIMAS_A21A_0003', treeId: 3 });

  const b = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B' });
  await SessionStore.addTreeToSession(b.id, { name: 'DAMIMAS_A21B_0001', treeId: 1 });

  const stats = await SessionStore.homeStats();
  assert.equal(stats.totalPohon, 4);
  assert.equal(stats.totalSessions, 3);
  assert.equal(stats.totalGroups, 2, 'A21A (two sessions) + A21B = 2 groups');

  const a21a = stats.groups.find(g => g.groupKey === SessionStore.groupKeyFor('DAMIMAS', 'A21A'));
  assert.equal(a21a.pohon, 3);
  assert.equal(a21a.sessions, 2);
});

test('removeSession drops it from the index and getSessions is newest-first', async () => {
  const { SessionStore } = loadStore();
  const s1 = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21A' });
  const s2 = await SessionStore.createSession({ variety: 'TENERA', blok: 'B07' });
  // s2 was created/updated last → should sort first.
  let list = await SessionStore.getSessions();
  assert.equal(list[0].id, s2.id);

  await SessionStore.removeSession(s1.id);
  list = await SessionStore.getSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, s2.id);
});

test('sessions index persists across a reload of the same backing store', async () => {
  const ls = makeLocalStorage();
  const first = loadStore(ls).SessionStore;
  const s = await first.createSession({ variety: 'DAMIMAS', blok: 'A21B' });
  await first.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1 });

  // Fresh module instance, same localStorage → simulates an app restart.
  const second = loadStore(ls).SessionStore;
  const stats = await second.homeStats();
  assert.equal(stats.totalPohon, 1);
  assert.equal(stats.totalGroups, 1);
});

test('non-throwing contract: bad ids and missing names degrade gracefully', async () => {
  const { SessionStore } = loadStore();
  assert.equal(await SessionStore.getSession('nope'), null);
  assert.equal(await SessionStore.updateSession('nope', { blok: 'X' }), null);
  assert.equal(await SessionStore.addTreeToSession('nope', { name: 'X' }), null);

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B' });
  const unchanged = await SessionStore.addTreeToSession(s.id, { /* no name */ });
  assert.equal(unchanged.trees.length, 0);
});

test('input cache remembers varieties/blocks most-recent-first, deduped, and survives reload', async () => {
  const ls = makeLocalStorage();
  const store = loadStore(ls).SessionStore;

  await store.createSession({ variety: 'DAMIMAS', blok: 'A21A' });
  await store.createSession({ variety: 'TENERA', blok: 'B07' });
  // Re-using a variety (different case) moves it to the front without duplicating.
  await store.createSession({ variety: 'damimas', blok: 'A21A' });

  let cache = await store.getInputCache();
  assert.deepEqual(cache.varieties, ['damimas', 'TENERA'], 'most-recent first, case-insensitive dedupe');
  assert.deepEqual(cache.bloks, ['A21A', 'B07']);

  // Blank values are never cached.
  await store.rememberInput('', '   ');
  cache = await store.getInputCache();
  assert.deepEqual(cache.varieties, ['damimas', 'TENERA']);
  assert.deepEqual(cache.bloks, ['A21A', 'B07']);

  // Survives an app restart (same backing store, fresh module instance).
  const reloaded = loadStore(ls).SessionStore;
  const after = await reloaded.getInputCache();
  assert.deepEqual(after.varieties, ['damimas', 'TENERA']);
  assert.deepEqual(after.bloks, ['A21A', 'B07']);
});
