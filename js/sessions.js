'use strict';

/**
 * SessionsUI — the capture-first Home / Start-Session / Session-Detail shell
 * (Phase 1 of the flow rework).
 *
 * Vocabulary (field crews):
 *   - Tree     : one tree = N side photos. The existing DatasetManager "tree".
 *   - Session  : one capture run, LOCKED to a single variety+block; holds a list
 *                of trees. Can be saved and resumed later via "Add Tree".
 *   - Group    : a (variety, block) identity. DAMIMAS·A21B ≠ DAMIMAS·A21A; two
 *                sessions on the same variety+block roll up into one group.
 *
 * This module owns three sub-views rendered into one container and persists
 * everything through SessionStore (the sessions index survives app restarts).
 * It delegates two app-level actions back to the host via hooks:
 *   - capture(session)   -> Promise<datasetTree|null>  // photograph one tree
 *   - openPohon(treeName)                               // open in the annotator
 * plus loadFolder() / loadSessionJson() for the secondary entry points and
 * toast(msg,type) for feedback.
 *
 * Public API:
 *   SessionsUI.init({ container, hooks })
 *   SessionsUI.showHome()           // render the Home view (async)
 *   SessionsUI.refresh()            // re-render whatever view is showing
 */
const SessionsUI = (() => {

  // Always-offered variety suggestions, merged with the operator's own history.
  const SEED_VARIETIES = ['DAMIMAS'];
  // The only allowed photos-per-tree counts.
  const SIDE_CHOICES = [4, 8];

  let _container = null;
  let _hooks = {};
  let _view = 'home';          // 'home' | 'start' | 'detail'
  let _detailId = null;

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  function _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Small inline icon (set via innerHTML so the SVG renders in the browser).
  // Every icon carries an intrinsic width/height so it can never balloon to the
  // replaced-element default size; CSS still wins where it sets a smaller size.
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  };

  function _iconBtn(className, iconKey, label) {
    const b = _el('button', className);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = ICONS[iconKey] || '';
    return b;
  }

  function _clear() {
    if (_container) _container.innerHTML = '';
  }

  function _toast(msg, type) {
    if (typeof _hooks.toast === 'function') _hooks.toast(msg, type || 'info');
  }

  // A themed confirm dialog (Capacitor WebViews suppress window.confirm, and it
  // looks out of place). Resolves true on confirm, false on cancel/backdrop.
  // @param {{title, message?, confirmLabel?, cancelLabel?, danger?}} opts
  function _confirm(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const backdrop = _el('div', 'pa-modal');
      const card = _el('div', 'pa-modal__card');
      card.appendChild(_el('h3', 'pa-modal__title', o.title || 'Are you sure?'));
      if (o.message) card.appendChild(_el('p', 'pa-modal__msg', o.message));
      const row = _el('div', 'pa-modal__actions');
      const cancel = _el('button', 'pa-modal__btn pa-modal__btn--ghost', o.cancelLabel || 'Cancel');
      cancel.type = 'button';
      const ok = _el('button',
        'pa-modal__btn ' + (o.danger ? 'pa-modal__btn--danger' : 'pa-modal__btn--primary'),
        o.confirmLabel || 'Delete');
      ok.type = 'button';
      row.appendChild(cancel);
      row.appendChild(ok);
      card.appendChild(row);
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);

      let settled = false;
      function close(val) {
        if (settled) return;
        settled = true;
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        resolve(val);
      }
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      // Tapping the dimmed backdrop (but not the card) cancels.
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    });
  }

  // Compact, locale-independent date: "3 Jun 13:10".
  const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function _fmtDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${d.getDate()} ${_MONTHS[d.getMonth()]} ${hh}:${mm}`;
    } catch (_) { return ''; }
  }

  function _pad4(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    return String(v).padStart(4, '0');
  }

  // Case-insensitive de-dupe, preserving order and dropping blanks.
  function _uniqCI(arr) {
    const seen = new Set();
    const out = [];
    for (const x of (Array.isArray(arr) ? arr : [])) {
      const v = String(x == null ? '' : x).trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  }

  // A <datalist> of suggestion <option>s for an <input list="…">.
  function _datalist(id, options) {
    const dl = _el('datalist');
    dl.id = id;
    for (const o of options) {
      const opt = _el('option');
      opt.value = o;
      dl.appendChild(opt);
    }
    return dl;
  }

  function _store() { return window.SessionStore || null; }

  // ── Home view ───────────────────────────────────────────────────────────────

  async function _renderHome() {
    _view = 'home';
    _detailId = null;
    _clear();
    if (!_container) return;

    const store = _store();
    let stats = { totalPohon: 0, totalGroups: 0, totalSessions: 0 };
    let sessions = [];
    if (store) {
      try { stats = await store.homeStats(); } catch (_) {}
      try { sessions = await store.getSessions(); } catch (_) {}
    }

    const scroll = _el('div', 'home__scroll');

    const hero = _el('section', 'home__hero');
    hero.appendChild(_el('h1', null, 'PalmAnnotate'));
    hero.appendChild(_el('p', null, 'Fresh fruit bunch documentation — work session by session'));
    scroll.appendChild(hero);

    // Stat cards: Total Trees + Total Groups.
    const statsRow = _el('div', 'home__stats');
    statsRow.appendChild(_statCard(stats.totalPohon, 'Total Trees'));
    statsRow.appendChild(_statCard(stats.totalGroups, 'Total Groups', 'gold'));
    scroll.appendChild(statsRow);

    // Primary: start a new session.
    const primary = _el('button', 'home__primary');
    primary.type = 'button';
    primary.innerHTML = ICONS.plus + '<span>New Session</span>';
    primary.addEventListener('click', () => _renderStart());
    scroll.appendChild(primary);

    // Recent / resumable sessions.
    const recent = _el('section', 'home__recent');
    recent.appendChild(_el('h2', 'home__section-title', 'Recent Sessions'));
    if (!sessions.length) {
      recent.appendChild(_el('div', 'home__empty',
        'No sessions yet. Tap "New Session" to start documenting trees.'));
    } else {
      const list = _el('ul', 'session-list');
      for (const s of sessions) list.appendChild(_sessionRow(s));
      recent.appendChild(list);
    }
    scroll.appendChild(recent);

    // Secondary: existing dataset entry points.
    const secondary = _el('div', 'home__secondary');
    const loadFolderBtn = _el('button', 'link-btn');
    loadFolderBtn.type = 'button';
    loadFolderBtn.innerHTML = ICONS.folder + '<span>Load Folder</span>';
    loadFolderBtn.addEventListener('click', () => { if (_hooks.loadFolder) _hooks.loadFolder(); });
    const loadSessionBtn = _el('button', 'link-btn');
    loadSessionBtn.type = 'button';
    loadSessionBtn.innerHTML = ICONS.layers + '<span>Load JSON</span>';
    loadSessionBtn.addEventListener('click', () => { if (_hooks.loadSessionJson) _hooks.loadSessionJson(); });
    secondary.appendChild(loadFolderBtn);
    secondary.appendChild(loadSessionBtn);
    scroll.appendChild(secondary);

    // Export folder (native SAF only): pick a public, browsable folder that each
    // captured tree's photos are mirrored into so they're reachable in any file
    // manager. Hidden on web (no SAF) and when the plugin isn't present.
    if (window.SafStore && SafStore.isSupported && SafStore.isSupported()) {
      let cur = null;
      try { cur = await SafStore.current(); } catch (_) {}
      const safBtn = _el('button', 'link-btn saf-row');
      safBtn.type = 'button';
      safBtn.innerHTML = ICONS.folder;
      const safLabel = _el('span');
      safLabel.textContent = `Export folder: ${cur ? cur.name : 'Not set'}`;
      safBtn.appendChild(safLabel);
      safBtn.addEventListener('click', async () => {
        const picked = await SafStore.pickFolder();
        _toast(picked ? `Export folder: ${picked.name}` : 'No folder selected',
          picked ? 'success' : 'info');
        _renderHome();
      });
      scroll.appendChild(safBtn);
    }

    _container.appendChild(scroll);
  }

  function _statCard(num, label, tone) {
    const card = _el('div', 'stat-card' + (tone ? ` stat-card--${tone}` : ''));
    card.appendChild(_el('span', 'stat-card__num', String(num)));
    card.appendChild(_el('span', 'stat-card__label', label));
    return card;
  }

  function _sessionRow(session) {
    const li = _el('li', 'list-row');
    const main = _el('button', 'list-row__main');
    main.type = 'button';
    const title = `${session.variety || '—'}${session.blok ? ' · ' + session.blok : ''}`;
    main.appendChild(_el('span', 'list-row__title', title));
    const pohon = Array.isArray(session.trees) ? session.trees.length : 0;
    main.appendChild(_el('span', 'list-row__meta',
      `${pohon} ${pohon === 1 ? 'tree' : 'trees'} · ${_fmtDate(session.updatedAt)}`));
    main.addEventListener('click', () => _renderDetail(session.id));
    li.appendChild(main);

    const del = _iconBtn('list-row__del', 'trash', 'Delete session');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await _confirm({
        title: 'Delete session?',
        message: `"${title}" and its tree list will be removed from this device. `
               + `Photos already saved to storage are kept.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const store = _store();
      if (store) { try { await store.removeSession(session.id); } catch (_) {} }
      _renderHome();
    });
    li.appendChild(del);
    return li;
  }

  // ── Start-Session view ──────────────────────────────────────────────────────

  async function _renderStart() {
    _view = 'start';
    _clear();
    if (!_container) return;

    // Remembered variety/block suggestions for faster repeat setup.
    const store = _store();
    let cache = { varieties: [], bloks: [] };
    if (store) { try { cache = await store.getInputCache(); } catch (_) {} }

    const scroll = _el('div', 'home__scroll');

    const top = _el('header', 'sheet__top');
    const back = _iconBtn('sheet__icon-btn', 'back', 'Back');
    back.addEventListener('click', () => _renderHome());
    top.appendChild(back);
    top.appendChild(_el('h1', null, 'Start Session'));
    scroll.appendChild(top);

    scroll.appendChild(_el('div', 'sheet__banner',
      'Variety and Block are locked for every tree in this session.'));

    const card = _el('div', 'form-card');

    // Variety — free text with remembered suggestions.
    const vField = _el('div', 'field');
    vField.appendChild(_el('label', null, 'Tree Variety'));
    const vInput = _el('input');
    vInput.type = 'text';
    vInput.placeholder = 'e.g. DAMIMAS';
    vInput.setAttribute('list', 'pa-varieties');
    vInput.setAttribute('autocomplete', 'off');
    vInput.setAttribute('autocapitalize', 'characters');
    vField.appendChild(vInput);
    vField.appendChild(_datalist('pa-varieties', _uniqCI(cache.varieties.concat(SEED_VARIETIES))));
    card.appendChild(vField);

    // Block — free text with remembered suggestions.
    const bField = _el('div', 'field');
    bField.appendChild(_el('label', null, 'Block'));
    const bInput = _el('input');
    bInput.type = 'text';
    bInput.placeholder = 'e.g. A21B';
    bInput.setAttribute('list', 'pa-bloks');
    bInput.setAttribute('autocomplete', 'off');
    bInput.setAttribute('autocapitalize', 'characters');
    bField.appendChild(bInput);
    bField.appendChild(_datalist('pa-bloks', _uniqCI(cache.bloks)));
    card.appendChild(bField);

    // Photos per tree — fixed choice of 4 or 8 sides.
    const pField = _el('div', 'field');
    pField.appendChild(_el('label', null, 'Photos per Tree'));
    const seg = _el('div', 'seg');
    let sideSel = SIDE_CHOICES[0];
    const segBtns = [];
    for (const v of SIDE_CHOICES) {
      const b = _el('button', 'seg__btn' + (v === sideSel ? ' is-active' : ''), String(v));
      b.type = 'button';
      b.setAttribute('data-sides', String(v));
      b.addEventListener('click', () => {
        sideSel = v;
        for (const x of segBtns) x.classList.toggle('is-active', x === b);
      });
      segBtns.push(b);
      seg.appendChild(b);
    }
    pField.appendChild(seg);
    card.appendChild(pField);

    // Auto-ID toggle.
    const toggle = _el('div', 'toggle-card');
    const tText = _el('div', 'toggle-card__text');
    tText.appendChild(_el('strong', null, 'Auto ID Mode'));
    tText.appendChild(_el('span', null, 'Tree ID increments automatically (0001, 0002, …)'));
    toggle.appendChild(tText);
    const sw = _el('label', 'switch');
    const swInput = _el('input');
    swInput.type = 'checkbox';
    swInput.checked = true;
    sw.appendChild(swInput);
    sw.appendChild(_el('span', 'switch__slider'));
    toggle.appendChild(sw);
    card.appendChild(toggle);

    scroll.appendChild(card);

    const cta = _el('button', 'sheet__cta');
    cta.type = 'button';
    cta.innerHTML = ICONS.camera + '<span>Start Documentation</span>';
    cta.addEventListener('click', async () => {
      const variety = vInput.value.trim();
      const blok = bInput.value.trim();
      if (!variety) { _toast('Enter the tree variety first', 'error'); return; }
      if (!blok) { _toast('Enter the block first', 'error'); return; }
      const sideCount = sideSel === 8 ? 8 : 4;
      const store2 = _store();
      if (!store2) { _toast('Session storage is unavailable', 'error'); return; }
      cta.disabled = true;
      let session = null;
      try {
        session = await store2.createSession({ variety, blok, sideCount, autoId: swInput.checked });
      } catch (e) {
        console.warn('[SessionsUI] createSession failed:', e);
      }
      cta.disabled = false;
      if (!session) { _toast('Failed to create session', 'error'); return; }
      _renderDetail(session.id);
    });
    scroll.appendChild(cta);

    _container.appendChild(scroll);
  }

  // ── Session-Detail view ─────────────────────────────────────────────────────

  async function _renderDetail(id) {
    _view = 'detail';
    _detailId = id;
    _clear();
    if (!_container) return;

    const store = _store();
    let session = null;
    if (store) { try { session = await store.getSession(id); } catch (_) {} }
    if (!session) { _renderHome(); return; }

    const scroll = _el('div', 'home__scroll');

    const top = _el('header', 'sheet__top');
    const back = _iconBtn('sheet__icon-btn', 'back', 'Back');
    back.addEventListener('click', () => _renderHome());
    top.appendChild(back);
    top.appendChild(_el('h1', null, 'Session'));
    const refresh = _iconBtn('sheet__icon-btn', 'refresh', 'Refresh');
    refresh.addEventListener('click', () => _renderDetail(id));
    top.appendChild(refresh);
    scroll.appendChild(top);

    // Locked variety·block badge.
    const lock = _el('div', 'lock-badge');
    lock.appendChild(_el('span', 'lock-badge__icon', '🔒'));
    const lockText = _el('div', 'lock-badge__text');
    lockText.appendChild(_el('span', 'lock-badge__title',
      `${session.variety}${session.blok ? ' · ' + session.blok : ''}`));
    lockText.appendChild(_el('span', 'lock-badge__sub', 'Locked for this session'));
    lock.appendChild(lockText);
    scroll.appendChild(lock);

    // Stats: trees, photos, next id.
    const trees = Array.isArray(session.trees) ? session.trees : [];
    const fotoTotal = trees.reduce((n, t) => n + (Number(t.sideCount) || session.sideCount || 0), 0);
    const statsRow = _el('div', 'home__stats home__stats--three');
    statsRow.appendChild(_smallStat(trees.length, 'Trees'));
    statsRow.appendChild(_smallStat(fotoTotal, 'Photos', 'emerald'));
    statsRow.appendChild(_smallStat(session.autoId ? _pad4(session.nextId) : '—', 'Next ID', 'gold'));
    scroll.appendChild(statsRow);

    // Add tree.
    const addBtn = _el('button', 'sheet__cta');
    addBtn.type = 'button';
    addBtn.innerHTML = ICONS.plus + '<span>Add Tree</span>';
    addBtn.addEventListener('click', () => _addPohon(id, addBtn));
    scroll.appendChild(addBtn);

    // Tree list.
    const listSection = _el('section');
    listSection.appendChild(_el('h2', 'sheet__list-title', 'Trees'));
    if (!trees.length) {
      listSection.appendChild(_el('div', 'sheet__empty',
        'No trees yet. Tap "Add Tree" to capture the first one.'));
    } else {
      const list = _el('ul', 'pohon-list');
      for (const t of trees.slice().sort((a, b) => (a.treeId || 0) - (b.treeId || 0))) {
        list.appendChild(_pohonRow(t, id));
      }
      listSection.appendChild(list);
    }
    scroll.appendChild(listSection);

    // Download session.
    const dl = _el('button', 'link-btn');
    dl.type = 'button';
    dl.innerHTML = ICONS.download + '<span>Download Session</span>';
    dl.addEventListener('click', () => _downloadSession(session));
    scroll.appendChild(dl);

    _container.appendChild(scroll);
  }

  function _smallStat(num, label, tone) {
    const card = _el('div', 'stat-card stat-card--sm' + (tone ? ` stat-card--${tone}` : ''));
    card.appendChild(_el('span', 'stat-card__num', String(num)));
    card.appendChild(_el('span', 'stat-card__label', label));
    return card;
  }

  function _pohonRow(tree, sessionId) {
    const li = _el('li', 'list-row');
    const main = _el('button', 'list-row__main');
    main.type = 'button';
    main.appendChild(_el('span', 'list-row__badge', _pad4(tree.treeId)));
    main.appendChild(_el('span', 'list-row__title', tree.name));
    main.appendChild(_el('span', 'list-row__meta', `${Number(tree.sideCount) || '?'} sides`));
    main.addEventListener('click', () => {
      // Pass the owning session id so the editor's Home button can return here
      // (to this session's tree list) instead of jumping to the session chooser.
      if (_hooks.openPohon) _hooks.openPohon(tree.name, sessionId);
    });
    li.appendChild(main);

    const del = _iconBtn('list-row__del', 'trash', 'Delete tree');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sides = Number(tree.sideCount);
      const ok = await _confirm({
        title: 'Delete tree?',
        message: `${tree.name}${sides ? ` and its ${sides} photos` : ''} will be removed.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await _deleteTree(sessionId, tree);
      _renderDetail(sessionId);
    });
    li.appendChild(del);
    return li;
  }

  // Remove a tree from a session: drop it from the session index + captured
  // registry, then best-effort unlink its on-disk photos (native only).
  async function _deleteTree(sessionId, tree) {
    const store = _store();
    if (store) {
      try { await store.removeTreeFromSession(sessionId, tree.name); } catch (_) {}
      try { if (store.removeCapturedTree) await store.removeCapturedTree(tree.name); } catch (_) {}
    }
    try {
      const native = window.Storage && Storage.isNative && Storage.isNative();
      const adapter = native && Storage.active && Storage.active();
      if (adapter && typeof adapter.deleteDatasetTree === 'function') {
        await adapter.deleteDatasetTree(tree.name, tree.sideCount);
      }
    } catch (e) {
      console.warn('[SessionsUI] deleteDatasetTree failed:', e);
    }
  }

  async function _addPohon(id, btn) {
    const store = _store();
    if (!store) { _toast('Session storage is unavailable', 'error'); return; }
    let session = null;
    try { session = await store.getSession(id); } catch (_) {}
    if (!session) { _renderHome(); return; }
    if (typeof _hooks.capture !== 'function') { _toast('Camera is unavailable', 'error'); return; }

    if (btn) btn.disabled = true;
    let tree = null;
    try {
      tree = await _hooks.capture(session);
    } catch (e) {
      console.warn('[SessionsUI] capture failed:', e);
    }
    if (btn) btn.disabled = false;

    if (!tree) return; // cancelled
    try {
      await store.addTreeToSession(id, {
        name: tree.name,
        treeId: tree.treeId,
        sideCount: tree.sideCount,
        metadata: tree.metadata,
        sides: tree.sides,
      });
    } catch (e) {
      console.warn('[SessionsUI] addTreeToSession failed:', e);
    }
    _toast(`Tree ${tree.name} saved`, 'success');
    _renderDetail(id);
  }

  async function _downloadSession(session) {
    const payload = {
      id: session.id,
      variety: session.variety,
      blok: session.blok,
      groupKey: session.groupKey,
      sideCount: session.sideCount,
      autoId: session.autoId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      pohon: (session.trees || []).map(t => ({
        name: t.name, treeId: t.treeId, sideCount: t.sideCount,
      })),
    };
    const base = (window.SessionStore && SessionStore.groupKeyFor)
      ? SessionStore.groupKeyFor(session.variety, session.blok)
      : 'session';
    const fname = `${base || 'session'}_${session.id}.json`;
    try {
      const native = window.Storage && Storage.isNative && Storage.isNative();
      if (native) {
        await Storage.active().writeDatasetJson('sessions/' + fname, payload);
        // Also drop a copy into the chosen public folder, if any (best-effort).
        if (window.SafStore && SafStore.isSupported && SafStore.isSupported()) {
          try { await SafStore.writeJson('sessions/' + fname, payload); } catch (_) {}
        }
        _toast('Saved: sessions/' + fname, 'success');
      } else {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = _el('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        _toast('Downloaded: ' + fname, 'success');
      }
    } catch (e) {
      console.warn('[SessionsUI] download failed:', e);
      _toast('Failed to download session', 'error');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  function init(opts = {}) {
    _container = opts.container || null;
    _hooks = (opts.hooks && typeof opts.hooks === 'object') ? opts.hooks : {};
  }

  function showHome() { return _renderHome(); }

  // Render a specific session's detail view directly. Used by the host so the
  // editor's Home button can return to the session a tree was opened from.
  function showDetail(id) { return _renderDetail(id); }

  function refresh() {
    if (_view === 'detail' && _detailId) return _renderDetail(_detailId);
    if (_view === 'start') return _renderStart();
    return _renderHome();
  }

  return { init, showHome, showDetail, refresh };
})();

window.SessionsUI = SessionsUI;
