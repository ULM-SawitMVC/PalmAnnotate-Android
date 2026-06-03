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
function boot() {
  const dom = makeDom();
  const quiet = { ...console, info() {}, warn() {} };
  const ctx = loadModule(['js/persist/session-store.js', 'js/sessions.js'], {
    globals: { document: dom.document, localStorage: makeLocalStorage(), console: quiet },
  });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);

  const opened = [];
  const captureHook = async (session) => ({
    name: `DAMIMAS_A21B_${String(session.nextId).padStart(4, '0')}`,
    treeId: session.nextId,
    sideCount: session.sideCount,
    metadata: { variety: session.variety, blok: session.blok },
    sides: [],
  });

  ctx.SessionsUI.init({
    container,
    hooks: {
      capture: captureHook,
      openPohon: (name) => opened.push(name),
    },
  });

  return { dom, container, SessionsUI: ctx.SessionsUI, SessionStore: ctx.SessionStore, opened };
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

test('opening a session shows the locked badge; +Pohon captures and records', async () => {
  const { container, SessionsUI, SessionStore } = boot();

  const s = await SessionStore.createSession({ variety: 'DAMIMAS', blok: 'A21B', sideCount: 4 });
  await SessionStore.addTreeToSession(s.id, { name: 'DAMIMAS_A21B_0001', treeId: 1, sideCount: 4 });

  await SessionsUI.showHome();
  container.querySelector('.list-row__main').click(); // resume session → detail

  await waitFor(() => container.querySelector('.lock-badge__title'));
  assert.equal(container.querySelector('.lock-badge__title').textContent, 'DAMIMAS · A21B');
  assert.equal(container.querySelectorAll('.list-row').length, 1, 'one seeded pohon');

  // + Pohon → capture hook returns 0002 → recorded → detail re-renders.
  container.querySelector('.sheet__cta').click();
  await waitFor(() => container.querySelectorAll('.list-row').length === 2);

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

test('Start-Session form creates a session locked to the typed variety+blok', async () => {
  const { container, SessionsUI, SessionStore } = boot();

  await SessionsUI.showHome();
  container.querySelector('.home__primary').click(); // → Start form

  assert.ok(container.querySelector('.form-card'), 'start form rendered');
  container.querySelector('select').value = 'DAMIMAS';
  const inputs = container.querySelectorAll('input'); // [other, blok, photos, switch]
  inputs[1].value = 'A21B';
  inputs[2].value = '6';

  container.querySelector('.sheet__cta').click(); // Mulai Dokumentasi → detail
  await waitFor(() => container.querySelector('.lock-badge__title'));
  assert.equal(container.querySelector('.lock-badge__title').textContent, 'DAMIMAS · A21B');

  const sessions = await SessionStore.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sideCount, 6, 'photos-per-tree carried into the session');
});
