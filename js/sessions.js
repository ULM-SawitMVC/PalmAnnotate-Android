'use strict';

/**
 * SessionsUI — the capture-first Home / Start-Session / Session-Detail shell
 * (Phase 1 of the flow rework).
 *
 * Vocabulary (field crews):
 *   - Pohon    : one tree = N side photos. The existing DatasetManager "tree".
 *   - Sesi     : one capture run, LOCKED to a single variety+blok; holds a list
 *                of pohon. Can be saved and resumed later via "+ Pohon".
 *   - Group    : a (variety, blok) identity. DAMIMAS·A21B ≠ DAMIMAS·A21A; two
 *                sessions on the same variety+blok roll up into one group.
 *
 * This module owns three sub-views rendered into one container and persists
 * everything through SessionStore (the sessions index survives app restarts).
 * It delegates two app-level actions back to the host via hooks:
 *   - capture(session)   -> Promise<datasetTree|null>  // photograph one pohon
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

  const VARIETY_PRESETS = ['DAMIMAS', 'Other'];

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
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
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
    hero.appendChild(_el('p', null, 'Dokumentasi tandan buah segar — kerja per sesi'));
    scroll.appendChild(hero);

    // Stat cards: Total Pohon + Total Group.
    const statsRow = _el('div', 'home__stats');
    statsRow.appendChild(_statCard(stats.totalPohon, 'Total Pohon'));
    statsRow.appendChild(_statCard(stats.totalGroups, 'Total Group', 'gold'));
    scroll.appendChild(statsRow);

    // Primary: start a new session.
    const primary = _el('button', 'home__primary');
    primary.type = 'button';
    primary.innerHTML = ICONS.plus + '<span>Sesi Baru</span>';
    primary.addEventListener('click', () => _renderStart());
    scroll.appendChild(primary);

    // Recent / resumable sessions.
    const recent = _el('section', 'home__recent');
    recent.appendChild(_el('h2', 'home__section-title', 'Sesi Terakhir'));
    if (!sessions.length) {
      recent.appendChild(_el('div', 'home__empty',
        'Belum ada sesi. Tekan "Sesi Baru" untuk mulai mendata pohon.'));
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
    main.appendChild(_el('span', 'list-row__meta', `${pohon} pohon · ${_fmtDate(session.updatedAt)}`));
    main.addEventListener('click', () => _renderDetail(session.id));
    li.appendChild(main);

    const del = _iconBtn('list-row__del', 'trash', 'Hapus sesi');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const store = _store();
      if (store) { try { await store.removeSession(session.id); } catch (_) {} }
      _renderHome();
    });
    li.appendChild(del);
    return li;
  }

  // ── Start-Session view ──────────────────────────────────────────────────────

  function _renderStart() {
    _view = 'start';
    _clear();
    if (!_container) return;

    const scroll = _el('div', 'home__scroll');

    const top = _el('header', 'sheet__top');
    const back = _iconBtn('sheet__icon-btn', 'back', 'Kembali');
    back.addEventListener('click', () => _renderHome());
    top.appendChild(back);
    top.appendChild(_el('h1', null, 'Mulai Sesi Pendataan'));
    scroll.appendChild(top);

    scroll.appendChild(_el('div', 'sheet__banner',
      'Varietas dan Blok dikunci untuk semua pohon dalam sesi ini.'));

    const card = _el('div', 'form-card');

    // Variety (+ Other free text).
    const vField = _el('div', 'field');
    vField.appendChild(_el('label', null, 'Varietas Pohon'));
    const vSelect = _el('select');
    for (const v of VARIETY_PRESETS) {
      const opt = _el('option', null, v);
      opt.value = v;
      vSelect.appendChild(opt);
    }
    vField.appendChild(vSelect);
    card.appendChild(vField);

    const otherField = _el('div', 'field hidden');
    otherField.appendChild(_el('label', null, 'Nama Varietas'));
    const otherInput = _el('input');
    otherInput.type = 'text';
    otherInput.placeholder = 'mis. TENERA';
    otherField.appendChild(otherInput);
    card.appendChild(otherField);

    vSelect.addEventListener('change', () => {
      otherField.classList.toggle('hidden', vSelect.value !== 'Other');
    });

    // Blok.
    const bField = _el('div', 'field');
    bField.appendChild(_el('label', null, 'Blok'));
    const bInput = _el('input');
    bInput.type = 'text';
    bInput.placeholder = 'mis. A21B';
    bField.appendChild(bInput);
    card.appendChild(bField);

    // Photos per tree.
    const pField = _el('div', 'field');
    pField.appendChild(_el('label', null, 'Jumlah Foto per Pohon'));
    const pInput = _el('input');
    pInput.type = 'number';
    pInput.min = '2';
    pInput.max = '12';
    pInput.value = '4';
    pField.appendChild(pInput);
    card.appendChild(pField);

    // Auto-ID toggle.
    const toggle = _el('div', 'toggle-card');
    const tText = _el('div', 'toggle-card__text');
    tText.appendChild(_el('strong', null, 'Mode ID Otomatis'));
    tText.appendChild(_el('span', null, 'ID pohon naik otomatis (0001, 0002, …)'));
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
    cta.innerHTML = ICONS.camera + '<span>Mulai Dokumentasi</span>';
    cta.addEventListener('click', async () => {
      const variety = vSelect.value === 'Other'
        ? (otherInput.value.trim() || '')
        : vSelect.value;
      const blok = bInput.value.trim();
      if (!variety) { _toast('Isi varietas pohon dulu', 'error'); return; }
      if (!blok) { _toast('Isi blok dulu', 'error'); return; }
      const sideCount = Math.max(2, Math.min(12, Math.floor(Number(pInput.value) || 4)));
      const store = _store();
      if (!store) { _toast('Penyimpanan sesi tidak tersedia', 'error'); return; }
      cta.disabled = true;
      let session = null;
      try {
        session = await store.createSession({ variety, blok, sideCount, autoId: swInput.checked });
      } catch (e) {
        console.warn('[SessionsUI] createSession failed:', e);
      }
      cta.disabled = false;
      if (!session) { _toast('Gagal membuat sesi', 'error'); return; }
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
    const back = _iconBtn('sheet__icon-btn', 'back', 'Kembali');
    back.addEventListener('click', () => _renderHome());
    top.appendChild(back);
    top.appendChild(_el('h1', null, 'Sesi Pendataan'));
    const refresh = _iconBtn('sheet__icon-btn', 'refresh', 'Segarkan');
    refresh.addEventListener('click', () => _renderDetail(id));
    top.appendChild(refresh);
    scroll.appendChild(top);

    // Locked variety·blok badge.
    const lock = _el('div', 'lock-badge');
    lock.appendChild(_el('span', 'lock-badge__icon', '🔒'));
    const lockText = _el('div', 'lock-badge__text');
    lockText.appendChild(_el('span', 'lock-badge__title',
      `${session.variety}${session.blok ? ' · ' + session.blok : ''}`));
    lockText.appendChild(_el('span', 'lock-badge__sub', 'Terkunci untuk sesi ini'));
    lock.appendChild(lockText);
    scroll.appendChild(lock);

    // Stats: pohon, foto, next id.
    const trees = Array.isArray(session.trees) ? session.trees : [];
    const fotoTotal = trees.reduce((n, t) => n + (Number(t.sideCount) || session.sideCount || 0), 0);
    const statsRow = _el('div', 'home__stats home__stats--three');
    statsRow.appendChild(_smallStat(trees.length, 'Pohon'));
    statsRow.appendChild(_smallStat(fotoTotal, 'Foto', 'emerald'));
    statsRow.appendChild(_smallStat(session.autoId ? _pad4(session.nextId) : '—', 'ID Berikutnya', 'gold'));
    scroll.appendChild(statsRow);

    // + Pohon.
    const addBtn = _el('button', 'sheet__cta');
    addBtn.type = 'button';
    addBtn.innerHTML = ICONS.plus + '<span>Tambah Pohon</span>';
    addBtn.addEventListener('click', () => _addPohon(id, addBtn));
    scroll.appendChild(addBtn);

    // Pohon list.
    const listSection = _el('section');
    listSection.appendChild(_el('h2', 'sheet__list-title', 'Daftar Pohon'));
    if (!trees.length) {
      listSection.appendChild(_el('div', 'sheet__empty',
        'Belum ada pohon. Tekan "Tambah Pohon" untuk memotret pohon pertama.'));
    } else {
      const list = _el('ul', 'pohon-list');
      for (const t of trees.slice().sort((a, b) => (a.treeId || 0) - (b.treeId || 0))) {
        list.appendChild(_pohonRow(t));
      }
      listSection.appendChild(list);
    }
    scroll.appendChild(listSection);

    // Download session.
    const dl = _el('button', 'link-btn');
    dl.type = 'button';
    dl.innerHTML = ICONS.download + '<span>Download Sesi</span>';
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

  function _pohonRow(tree) {
    const li = _el('li', 'list-row');
    const main = _el('button', 'list-row__main');
    main.type = 'button';
    main.appendChild(_el('span', 'list-row__badge', _pad4(tree.treeId)));
    main.appendChild(_el('span', 'list-row__title', tree.name));
    main.appendChild(_el('span', 'list-row__meta', `${Number(tree.sideCount) || '?'} sisi`));
    main.addEventListener('click', () => {
      if (_hooks.openPohon) _hooks.openPohon(tree.name);
    });
    li.appendChild(main);
    return li;
  }

  async function _addPohon(id, btn) {
    const store = _store();
    if (!store) { _toast('Penyimpanan sesi tidak tersedia', 'error'); return; }
    let session = null;
    try { session = await store.getSession(id); } catch (_) {}
    if (!session) { _renderHome(); return; }
    if (typeof _hooks.capture !== 'function') { _toast('Kamera tidak tersedia', 'error'); return; }

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
    _toast(`Pohon ${tree.name} tersimpan`, 'success');
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
        _toast('Tersimpan: sessions/' + fname, 'success');
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
        _toast('Diunduh: ' + fname, 'success');
      }
    } catch (e) {
      console.warn('[SessionsUI] download failed:', e);
      _toast('Gagal download sesi', 'error');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  function init(opts = {}) {
    _container = opts.container || null;
    _hooks = (opts.hooks && typeof opts.hooks === 'object') ? opts.hooks : {};
  }

  function showHome() { return _renderHome(); }

  function refresh() {
    if (_view === 'detail' && _detailId) return _renderDetail(_detailId);
    if (_view === 'start') { _renderStart(); return Promise.resolve(); }
    return _renderHome();
  }

  return { init, showHome, refresh };
})();

window.SessionsUI = SessionsUI;
