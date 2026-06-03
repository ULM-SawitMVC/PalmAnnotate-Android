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
