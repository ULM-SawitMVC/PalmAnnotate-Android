'use strict';

// Coverage for SessionsUI — the capture-first Home / Start / Detail shell
// (Phase 1). We load the REAL SessionStore alongside SessionsUI in one vm
// context (shared `window`), drive the views through the fake DOM, and assert
// the rendered stats/rows plus the create-session and +Pohon wiring.

import { test } from 'node:test';
import assert from 'node:assert';
import { loadModule } from './_harness.mjs';
import { makeDom, waitFor } from './dom-stub.mjs';

function makeLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    key(index) { return Array.from(map.keys())[index] || null; },
  };
}

// Boot SessionsUI + SessionStore into one shared context with a fresh DOM.
function boot(extra = {}) {
  const dom = makeDom();
  const quiet = { ...console, info() {}, warn() {} };
  const globals = Object.assign(
    { document: dom.document, localStorage: makeLocalStorage(), console: quiet },
    extra.globals || {}
  );
  const ctx = loadModule(['js/persist/session-store.js', 'js/sessions.js'], {
    globals,
  });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);

  const opened = [];
  const openedWith = []; // records { name, sessionId } so the routing arg is testable
  const captureHook = async (session) => ({
    name: `DAMIMAS_A21B_${String(session.nextId).padStart(4, '0')}`,
    treeId: session.nextId,
    sideCount: session.sideCount,
    metadata: { variety: session.variety, blok: session.blok },
    sides: [],
  });

  ctx.SessionsUI.init({
    container,
    hooks: Object.assign({
      capture: captureHook,
      openPohon: (name, sessionId) => { opened.push(name); openedWith.push({ name, sessionId }); },
    }, extra.hooks || {}),
  });

  return { dom, container, SessionsUI: ctx.SessionsUI, SessionStore: ctx.SessionStore, opened, openedWith };
}

const num = (el) => Number(el.textContent);

test('home renders rolled-up stats and a resumable session row', async () => {
  const { container, SessionsUI, SessionStore } = boot();

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });

  await SessionsUI.showHome();

  const stats = container.querySelectorAll('.stat-card__num');
  assert.equal(num(stats[0]), 1, 'Total Pohon');
  assert.equal(num(stats[1]), 1, 'Total Group');

  const rowTitle = container.querySelector('.list-row__title');
  assert.equal(rowTitle.textContent, 'DAMIMAS · A21B');
});

test('opening a session shows the locked badge; +Pohon captures, records, and opens annotation', async () => {
  const { container, SessionsUI, SessionStore, openedWith } = boot();

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });

  await SessionsUI.showHome();
  container.querySelector('.list-row__main').click(); // resume session → detail

  await waitFor(() => container.querySelector('.lock-badge__title'));
  assert.equal(container.querySelector('.lock-badge__title').textContent, 'DAMIMAS · A21B');
  assert.equal(container.querySelectorAll('.list-row').length, 1, 'one seeded pohon');

  // + Pohon → capture hook returns 0002 → recorded → opens STRAIGHT into the
  // annotation editor (no detour back to the tree list, matching "Next tree").
  container.querySelector('.sheet__cta').click();
  await waitFor(() => openedWith.some(o => o.name === 'DAMIMAS_A21B_0002'));
  const opened0002 = openedWith.find(o => o.name === 'DAMIMAS_A21B_0002');
  assert.equal(opened0002.sessionId, s.id, 'opens the new tree for the owning session');

  // The session index now has two pohon and nextId advanced to 3.
  const fresh = await SessionStore.getSession(s.id);
  assert.equal(fresh.trees.length, 2);
  assert.equal(fresh.nextId, 3);

  // Home reflects the new count.
  await SessionsUI.showHome();
  assert.equal(num(container.querySelector('.stat-card__num')), 2, 'Total Pohon updated');
});

test('tapping a pohon row invokes the openPohon hook with its tree name', async () => {
  const { container, SessionsUI, SessionStore, opened } = boot();

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });

  await SessionsUI.showHome();
  container.querySelector('.list-row__main').click();
  await waitFor(() => container.querySelector('.list-row'));

  container.querySelector('.list-row__main').click();
  assert.deepEqual(opened, ['DAMIMAS_A21B_0001']);
});

test('opening a tree passes its session id so the editor can return to that session', async () => {
  const { container, SessionsUI, SessionStore, openedWith } = boot();

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });

  // showDetail is the public entry the host uses for the editor's Home button.
  await SessionsUI.showDetail(s.id);
  await waitFor(() => container.querySelector('.list-row'));

  container.querySelector('.list-row__main').click();
  assert.equal(openedWith.length, 1);
  assert.equal(openedWith[0].name, 'DAMIMAS_A21B_0001');
  assert.equal(openedWith[0].sessionId, s.id, 'session id handed to the host for back-navigation');
});

test('deleting a tree asks for confirmation first, then removes it', async () => {
  const { dom, container, SessionsUI, SessionStore } = boot();

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });

  await SessionsUI.showDetail(s.id);
  await waitFor(() => container.querySelector('.list-row__del'));

  // Trash on the tree row → a confirm dialog appears; nothing deleted yet.
  container.querySelector('.list-row__del').click();
  await waitFor(() => dom.document.body.querySelector('.pa-modal'));
  let fresh = await SessionStore.getSession(s.id);
  assert.equal(fresh.trees.length, 1, 'tree survives until the user confirms');

  // Confirm → tree removed and the detail re-renders to the empty state.
  dom.document.body.querySelector('.pa-modal__btn--danger').click();
  await waitFor(() => container.querySelector('.sheet__empty'));
  fresh = await SessionStore.getSession(s.id);
  assert.equal(fresh.trees.length, 0, 'confirmed delete drops the pohon from the session');
});

test('deleting a session removes all of its tree files and stale registries', async () => {
  const deleted = [];
  const removedFromMemory = [];
  const clearedHandles = [];
  const { dom, container, SessionsUI, SessionStore } = boot({
    globals: {
      Storage: {
        isNative: () => true,
        active: () => ({
          async deleteDatasetTree(name, sideCount) { deleted.push({ name, sideCount }); return { ok: true, removed: 1 }; },
        }),
      },
      DatasetManager: { removeByName(name) { removedFromMemory.push(name); return 1; } },
      ProjectConfig: { clearSavedHandle(name) { clearedHandles.push(name); } },
    },
  });

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0002', treeId: 2, sideCount: 8 });
  await SessionStore.addCapturedTree({ name: 'DAMIMAS_A21B_0001', sides: [] });
  await SessionStore.addCapturedTree({ name: 'DAMIMAS_A21B_0002', sides: [] });
  await SessionStore.saveSnapshot('DAMIMAS_A21B_0001', { dirty: true });

  await SessionsUI.showHome();
  container.querySelector('.list-row__del').click();
  await waitFor(() => dom.document.body.querySelector('.pa-modal'));
  dom.document.body.querySelector('.pa-modal__btn--danger').click();
  await waitFor(() => deleted.length === 2);
  assert.equal((await SessionStore.getSessions()).length, 0);

  assert.deepEqual(deleted, [
    { name: 'DAMIMAS_A21B_0001', sideCount: 4 },
    { name: 'DAMIMAS_A21B_0002', sideCount: 8 },
  ]);
  assert.deepEqual(removedFromMemory, ['DAMIMAS_A21B_0001', 'DAMIMAS_A21B_0002']);
  assert.deepEqual(clearedHandles, ['DAMIMAS_A21B_0001', 'DAMIMAS_A21B_0002']);
  assert.deepEqual(await SessionStore.getCapturedRegistry(), []);
  assert.equal(await SessionStore.loadSnapshot('DAMIMAS_A21B_0001'), null);
});

test('Start-Session form creates a session locked to the typed variety+block', async () => {
  const { container, SessionsUI, SessionStore } = boot();

  await SessionsUI.showHome();
  container.querySelector('.home__primary').click(); // → Start form
  await waitFor(() => container.querySelector('.form-card')); // async (loads suggestions)

  // Variety + block are now free text; sides is a fixed 4/8 segmented control.
  const inputs = container.querySelectorAll('input'); // [variety, block, auto-id switch]
  inputs[0].value = 'DAMIMAS';
  inputs[1].value = 'A21B';
  container.querySelector('[data-sides="8"]').click(); // choose 8 photos per tree

  container.querySelector('.sheet__cta').click(); // Start Documentation → detail
  await waitFor(() => container.querySelector('.lock-badge__title'));
  assert.equal(container.querySelector('.lock-badge__title').textContent, 'DAMIMAS · A21B');

  const sessions = await SessionStore.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sideCount, 8, 'chosen photos-per-tree carried into the session');
});

test('typed variety + block are remembered for the next session', async () => {
  const { SessionStore } = boot();
  await SessionStore.createSession({ variety: 'TENERA', blok: 'B07', sideCount: 4 });
  const cache = await SessionStore.getInputCache();
  assert.deepEqual(cache.varieties, ['TENERA']);
  assert.deepEqual(cache.bloks, ['B07']);
});

test('Start form suggests remembered variety + block (plus the DAMIMAS seed)', async () => {
  const { container, SessionsUI, SessionStore } = boot();
  await SessionStore.createSession({ variety: 'TENERA', blok: 'B07', sideCount: 4 });

  await SessionsUI.showHome();
  container.querySelector('.home__primary').click(); // → Start form
  await waitFor(() => container.querySelector('.form-card'));

  const options = Array.from(container.querySelectorAll('option')).map(o => o.value);
  assert.ok(options.includes('TENERA'), 'remembered variety suggested');
  assert.ok(options.includes('B07'), 'remembered block suggested');
  assert.ok(options.includes('DAMIMAS'), 'DAMIMAS seed always suggested');
});
