'use strict';

/**
 * CaptureFlow — the capture-first workflow (Phase 2).
 *
 * An operator photographs ONE tree from N views (default 4), tagging the set
 * with metadata (variety, operator, timestamp, optional GPS). The accepted
 * photos are persisted via Storage.active() and assembled into a normal
 * datasetTree, which then flows into the existing annotation pipeline exactly
 * like a folder-loaded tree.
 *
 * Public API:
 *   CaptureFlow.start(opts) -> Promise<datasetTree|null>
 *     opts:
 *       sideCount   : number   (default 4)
 *       onProgress  : (step, total) => void   // fired as each side is accepted
 *       onTreeReady : (datasetTree) => void    // fired once before resolve
 *
 * The returned datasetTree matches DatasetManager's shape:
 *   { name, split:'field', metadata:{variety,operator,timestamp,gps},
 *     sides:[ { imageFile, imageUri, labelFile:null, labelUri:null } ] }
 *
 * All UI is built/removed here (appended to document.body) and styled via
 * css/capture.css. Capture sources come from CaptureSources.default(), so the
 * Orbbec USB source drops in without changes here.
 */
const CaptureFlow = (() => {

  // Variety presets surfaced in the metadata form. "Other" reveals a free-text
  // field so field crews can record varieties not in the list.
  const VARIETY_PRESETS = ['DAMIMAS', 'Other'];

  // Per-session sequence counter. Seeded from the current epoch-millisecond
  // value (standard Date API) so names are unique across app launches without a
  // persistent store, then incremented per captured tree.
  let _seq = Date.now() % 1000;

  function _nextSeq() {
    const n = _seq % 1000;
    _seq += 1;
    return String(n).padStart(3, '0');
  }

  /**
   * YYYYMMDD for the current date using the standard Date API (local time).
   */
  function _yyyymmdd(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  /**
   * Make a string filesystem-safe: keep A-Z, 0-9 and underscores, collapse
   * everything else to '_', and uppercase for consistency with stem naming.
   */
  function _safe(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'TREE';
  }

  /**
   * Zero-pad a tree id to 4 digits (0001, 0042, …).
   */
  function _pad4(n) {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    return String(v).padStart(4, '0');
  }

  /**
   * Build the canonical session-mode stem: `${VARIETY}_${BLOK}_${0001}`, e.g.
   * DAMIMAS_A21B_0001. Blok is sanitized so "A 21B" → "A21B". Side numbers and
   * the per-tree GT json are appended downstream (DatasetManager parses this
   * exact stem on reload).
   */
  function _treeNameFor(variety, blok, treeId) {
    const v = _safe(variety);
    const b = String(blok || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const id = _pad4(treeId);
    return b ? `${v}_${b}_${id}` : `${v}_${id}`;
  }

  // ── Small DOM helpers ───────────────────────────────────────────────────────

  function _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Build the root overlay and append it. Returns the overlay element; callers
   * fill in the panel content and call _teardown(overlay) when done.
   */
  function _mountOverlay() {
    const overlay = _el('div', 'capture-overlay capture-flow');
    document.body.appendChild(overlay);
    return overlay;
  }

  function _teardown(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  /**
   * Build the optional "Get GPS" field used by both the freeform and
   * session-locked metadata forms. Returns the field element plus a getter for
   * the last resolved position (or null). Best-effort and never throws — see
   * _getPosition().
   */
  function _buildGpsField() {
    let gps = null;
    const gpsField = _el('div', 'capture-field');
    gpsField.appendChild(_el('span', 'capture-field__label', 'Location (optional)'));
    const gpsRow = _el('div', 'capture-gps');
    const gpsBtn = _el('button', 'capture-btn capture-btn--outline', 'Get GPS');
    gpsBtn.type = 'button';
    const gpsStatus = _el('span', 'capture-gps__status', 'Not set');
    gpsRow.appendChild(gpsBtn);
    gpsRow.appendChild(gpsStatus);
    gpsField.appendChild(gpsRow);

    gpsBtn.addEventListener('click', async () => {
      gpsBtn.disabled = true;
      gpsStatus.textContent = 'Locating…';
      try {
        gps = await _getPosition();
        gpsStatus.textContent = gps
          ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`
          : 'Unavailable';
      } catch (e) {
        console.info('[CaptureFlow] GPS lookup failed:', e);
        gps = null;
        gpsStatus.textContent = 'Unavailable';
      } finally {
        gpsBtn.disabled = false;
      }
    });

    return { field: gpsField, get: () => gps };
  }

  // ── Step 1: metadata form ───────────────────────────────────────────────────

  /**
   * Render the metadata form into `overlay` and resolve with a metadata object
   * when the operator continues, or null if they cancel.
   * @returns {Promise<{variety,operator,timestamp,gps}|null>}
   */
  function _collectMetadata(overlay) {
    return new Promise((resolve) => {
      overlay.innerHTML = '';
      const panel = _el('div', 'capture-panel capture-meta');

      panel.appendChild(_el('h2', 'capture-title', 'New Tree'));
      panel.appendChild(_el('p', 'capture-subtitle',
        'Tag this tree before you photograph its sides.'));

      const form = _el('div', 'capture-form');

      // Variety select (+ "Other" free text).
      const varietyField = _el('label', 'capture-field');
      varietyField.appendChild(_el('span', 'capture-field__label', 'Variety'));
      const varietySelect = _el('select', 'capture-input');
      for (const v of VARIETY_PRESETS) {
        const opt = _el('option', null, v);
        opt.value = v;
        varietySelect.appendChild(opt);
      }
      varietyField.appendChild(varietySelect);
      form.appendChild(varietyField);

      const otherField = _el('label', 'capture-field capture-field--other hidden');
      otherField.appendChild(_el('span', 'capture-field__label', 'Variety name'));
      const otherInput = _el('input', 'capture-input');
      otherInput.type = 'text';
      otherInput.placeholder = 'e.g. TENERA';
      otherField.appendChild(otherInput);
      form.appendChild(otherField);

      varietySelect.addEventListener('change', () => {
        const isOther = varietySelect.value === 'Other';
        otherField.classList.toggle('hidden', !isOther);
      });

      // Operator name.
      const opField = _el('label', 'capture-field');
      opField.appendChild(_el('span', 'capture-field__label', 'Operator'));
      const opInput = _el('input', 'capture-input');
      opInput.type = 'text';
      opInput.placeholder = 'Your name';
      opField.appendChild(opInput);
      form.appendChild(opField);

      // Capture timestamp — auto, ISO-8601, shown read-only.
      const timestamp = new Date().toISOString();
      const tsField = _el('label', 'capture-field');
      tsField.appendChild(_el('span', 'capture-field__label', 'Captured'));
      const tsInput = _el('input', 'capture-input capture-input--readonly');
      tsInput.type = 'text';
      tsInput.value = timestamp;
      tsInput.readOnly = true;
      tsField.appendChild(tsInput);
      form.appendChild(tsField);

      // GPS — best-effort, skippable.
      const gpsCtl = _buildGpsField();
      form.appendChild(gpsCtl.field);

      panel.appendChild(form);

      // Action bar.
      const actions = _el('div', 'capture-actions');
      const cancelBtn = _el('button', 'capture-btn capture-btn--ghost', 'Cancel');
      cancelBtn.type = 'button';
      const startBtn = _el('button', 'capture-btn capture-btn--primary', 'Start Capture');
      startBtn.type = 'button';
      actions.appendChild(cancelBtn);
      actions.appendChild(startBtn);
      panel.appendChild(actions);

      overlay.appendChild(panel);

      cancelBtn.addEventListener('click', () => resolve(null));
      startBtn.addEventListener('click', () => {
        const variety = varietySelect.value === 'Other'
          ? (otherInput.value.trim() || 'Other')
          : varietySelect.value;
        resolve({
          variety,
          operator: opInput.value.trim(),
          timestamp,
          gps: gpsCtl.get(),
        });
      });
    });
  }

  // ── Step 1 (session mode): locked metadata for one pohon ────────────────────

  /**
   * Render the per-pohon panel when capture is driven by a session locked to a
   * variety+blok. The variety/blok are shown as a read-only badge; only the
   * tree id is collected (read-only when the session is in auto-ID mode, an
   * editable number otherwise). Resolves with the metadata for this pohon, or
   * null on cancel.
   * @param {object} overlay
   * @param {{variety, blok, treeId, autoId, operator}} session
   * @returns {Promise<{variety,blok,treeId,operator,timestamp,gps}|null>}
   */
  function _collectLockedMetadata(overlay, session) {
    return new Promise((resolve) => {
      overlay.innerHTML = '';
      const panel = _el('div', 'capture-panel capture-meta');

      panel.appendChild(_el('h2', 'capture-title', 'New Tree'));

      // Locked variety·blok badge.
      const lock = _el('div', 'capture-lock');
      lock.appendChild(_el('span', 'capture-lock__icon', '🔒'));
      const lockText = _el('div', 'capture-lock__text');
      lockText.appendChild(_el('span', 'capture-lock__variety', session.variety || ''));
      lockText.appendChild(_el('span', 'capture-lock__blok',
        session.blok ? `Block ${session.blok}` : 'No block'));
      lock.appendChild(lockText);
      panel.appendChild(lock);

      const form = _el('div', 'capture-form');

      // Tree id — auto (read-only) or manual (editable number).
      const startId = Math.max(1, Math.floor(Number(session.treeId) || 1));
      const idField = _el('label', 'capture-field');
      idField.appendChild(_el('span', 'capture-field__label', 'Tree ID'));
      const idInput = _el('input', 'capture-input' + (session.autoId ? ' capture-input--readonly' : ''));
      idInput.type = session.autoId ? 'text' : 'number';
      idInput.value = session.autoId ? _pad4(startId) : String(startId);
      if (session.autoId) idInput.readOnly = true;
      else { idInput.min = '1'; idInput.step = '1'; }
      idField.appendChild(idInput);
      form.appendChild(idField);

      // GPS — best-effort, skippable (per pohon).
      const gpsCtl = _buildGpsField();
      form.appendChild(gpsCtl.field);

      panel.appendChild(form);

      const actions = _el('div', 'capture-actions');
      const cancelBtn = _el('button', 'capture-btn capture-btn--ghost', 'Cancel');
      cancelBtn.type = 'button';
      const startBtn = _el('button', 'capture-btn capture-btn--primary', 'Start Capture');
      startBtn.type = 'button';
      actions.appendChild(cancelBtn);
      actions.appendChild(startBtn);
      panel.appendChild(actions);

      overlay.appendChild(panel);

      cancelBtn.addEventListener('click', () => resolve(null));
      startBtn.addEventListener('click', () => {
        let treeId = startId;
        if (!session.autoId) {
          const parsed = Math.floor(Number(idInput.value));
          if (Number.isFinite(parsed) && parsed >= 1) treeId = parsed;
        }
        resolve({
          variety: session.variety,
          blok: session.blok,
          treeId,
          operator: session.operator || '',
          timestamp: new Date().toISOString(),
          gps: gpsCtl.get(),
        });
      });
    });
  }

  // Hard ceiling on how long we wait for a fix before giving up. A GPS cold
  // start outdoors can take a while; 15s balances "give it a real chance"
  // against "don't trap the operator on the metadata form".
  const GPS_TIMEOUT_MS = 15000;

  /**
   * Race a promise against a timeout, resolving `fallback` if it doesn't settle
   * in time. Used so a hung native geolocation call can never freeze capture.
   */
  function _withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
      Promise.resolve(promise).then(
        (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        () => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } }
      );
    });
  }

  /**
   * Best-effort current position. Native uses the Capacitor Geolocation plugin
   * when present; otherwise (and on web) it falls back to navigator.geolocation,
   * which the Capacitor WebView bridges to native location after the manifest
   * ACCESS_*_LOCATION permissions are granted. Resolves null on any
   * failure/denial/timeout so the caller can skip GPS without aborting capture.
   * @returns {Promise<{lat:number, lng:number, accuracy?:number}|null>}
   */
  async function _getPosition() {
    const nativeGeo = window.Capacitor &&
                      window.Capacitor.Plugins &&
                      window.Capacitor.Plugins.Geolocation;
    if (nativeGeo && typeof nativeGeo.getCurrentPosition === 'function') {
      try {
        // Ask for permission first when the plugin exposes it; a denial here
        // means getCurrentPosition would reject anyway, so bail to web fallback.
        if (typeof nativeGeo.requestPermissions === 'function') {
          try {
            const perm = await _withTimeout(nativeGeo.requestPermissions(), GPS_TIMEOUT_MS, null);
            const state = perm && (perm.location || perm.coarseLocation);
            if (state === 'denied') return null;
          } catch (e) { /* fall through to the position request */ }
        }
        const pos = await _withTimeout(
          nativeGeo.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: GPS_TIMEOUT_MS,
            maximumAge: 0,
          }),
          GPS_TIMEOUT_MS,
          null
        );
        const c = pos && pos.coords;
        if (!c || typeof c.latitude !== 'number' || typeof c.longitude !== 'number') {
          return null;
        }
        return { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
      } catch (e) {
        return null;
      }
    }
    if (navigator.geolocation && typeof navigator.geolocation.getCurrentPosition === 'function') {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        // Belt-and-braces timeout: some WebViews never invoke either callback
        // when the permission prompt is dismissed, so we guarantee resolution.
        const guard = setTimeout(() => finish(null), GPS_TIMEOUT_MS + 1000);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            clearTimeout(guard);
            const c = pos && pos.coords;
            finish(c && typeof c.latitude === 'number'
              ? { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy }
              : null);
          },
          () => { clearTimeout(guard); finish(null); },
          { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 }
        );
      });
    }
    return null;
  }

  // ── Step 2: per-side capture + review ───────────────────────────────────────

  /**
   * Render the "Side i / N" capture panel and drive one side to completion:
   * capture → preview with Retake/Use. Resolves with the accepted blob, or null
   * if the operator cancels the whole flow from this panel.
   * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
   */
  function _captureSide(overlay, sideNum, sideCount) {
    return new Promise((resolve) => {
      const source = CaptureSources.default();

      async function shoot() {
        overlay.innerHTML = '';
        const panel = _el('div', 'capture-panel capture-side');
        panel.appendChild(_buildProgress(sideNum, sideCount));
        panel.appendChild(_el('p', 'capture-subtitle',
          'Frame the side, then capture.'));

        const actions = _el('div', 'capture-actions');
        const cancelBtn = _el('button', 'capture-btn capture-btn--ghost', 'Cancel');
        cancelBtn.type = 'button';
        const shootBtn = _el('button', 'capture-btn capture-btn--primary', 'Capture');
        shootBtn.type = 'button';
        actions.appendChild(cancelBtn);
        actions.appendChild(shootBtn);
        panel.appendChild(actions);
        overlay.appendChild(panel);

        cancelBtn.addEventListener('click', () => resolve(null));
        shootBtn.addEventListener('click', async () => {
          shootBtn.disabled = true;
          let result = null;
          try {
            result = await source.capture();
          } catch (e) {
            console.warn('[CaptureFlow] capture() failed:', e);
            result = null;
          }
          shootBtn.disabled = false;
          // null = the source's own UI was cancelled; stay on this side.
          if (result) review(result);
        });
      }

      function review(result) {
        overlay.innerHTML = '';
        const panel = _el('div', 'capture-panel capture-review');
        panel.appendChild(_buildProgress(sideNum, sideCount));

        const preview = _el('div', 'capture-preview');
        const img = _el('img', 'capture-preview__img');
        const url = URL.createObjectURL(result.blob);
        img.src = url;
        // Revoke the preview URL once the browser has decoded it.
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        preview.appendChild(img);
        panel.appendChild(preview);

        const actions = _el('div', 'capture-actions capture-actions--review');
        const retakeBtn = _el('button', 'capture-btn capture-btn--outline', 'Retake');
        retakeBtn.type = 'button';
        const useBtn = _el('button', 'capture-btn capture-btn--primary', 'Use Photo');
        useBtn.type = 'button';
        actions.appendChild(retakeBtn);
        actions.appendChild(useBtn);
        panel.appendChild(actions);
        overlay.appendChild(panel);

        retakeBtn.addEventListener('click', () => shoot());
        useBtn.addEventListener('click', () => resolve(result));
      }

      shoot();
    });
  }

  /**
   * Build the "Side i / N" progress header with a row of step dots.
   */
  function _buildProgress(sideNum, sideCount) {
    const wrap = _el('div', 'capture-progress');
    wrap.appendChild(_el('h2', 'capture-title', `Side ${sideNum} / ${sideCount}`));
    const dots = _el('div', 'capture-progress__dots');
    for (let i = 1; i <= sideCount; i++) {
      const dot = _el('span', 'capture-dot');
      if (i < sideNum) dot.classList.add('capture-dot--done');
      else if (i === sideNum) dot.classList.add('capture-dot--active');
      dots.appendChild(dot);
    }
    wrap.appendChild(dots);
    return wrap;
  }

  /**
   * Render a brief "Saving…" panel while images/metadata are persisted.
   */
  function _showSaving(overlay) {
    overlay.innerHTML = '';
    const panel = _el('div', 'capture-panel capture-saving');
    panel.appendChild(_el('div', 'capture-spinner'));
    panel.appendChild(_el('h2', 'capture-title', 'Saving tree…'));
    overlay.appendChild(panel);
  }

  // ── Step 3: persist + build the datasetTree ─────────────────────────────────

  /**
   * Persist the accepted side blobs and metadata via the active storage
   * adapter, then assemble the datasetTree. Side filename convention:
   * `${treeName}_${i}.jpg`; images go under images/field/, metadata under
   * metadata/.
   * @returns {Promise<object>} datasetTree
   */
  async function _persistAndBuild(treeName, metadata, shots) {
    const adapter = Storage.active();
    // Optional public-folder mirror (best-effort; null unless the operator chose
    // an export folder via SAF). Captured copies land here so they're browsable
    // in any file manager, alongside the reliable app-storage copy.
    const saf = (window.SafStore && SafStore.isSupported && SafStore.isSupported()) ? SafStore : null;
    const sides = [];

    for (let i = 0; i < shots.length; i++) {
      const sideNum = i + 1;
      const filename = `${treeName}_${sideNum}.jpg`;
      const relPath  = `images/field/${filename}`;
      let persisted = {};
      try {
        persisted = await adapter.persistDatasetImage(relPath, shots[i].blob) || {};
      } catch (e) {
        console.warn('[CaptureFlow] persistDatasetImage failed for', relPath, e);
        persisted = {};
      }
      if (saf) {
        try { await saf.writeImage(`dataset/${relPath}`, shots[i].blob); } catch (_) {}
      }
      sides.push({
        imageFile: persisted.file || null,
        imageUri:  persisted.uri  || null,
        labelFile: null,
        labelUri:  null,
      });
    }

    try {
      await adapter.writeDatasetJson(`metadata/${treeName}.json`, metadata);
    } catch (e) {
      console.warn('[CaptureFlow] writeDatasetJson failed:', e);
    }
    if (saf) {
      try { await saf.writeJson(`dataset/metadata/${treeName}.json`, metadata); } catch (_) {}
    }

    return {
      name: treeName,
      split: 'field',
      metadata,
      sides,
    };
  }

  // ── Orchestration ───────────────────────────────────────────────────────────

  /**
   * Run the full capture-first flow.
   * @param {object} [opts]
   * @param {number}   [opts.sideCount=4]
   * @param {object}   [opts.session]     {variety, blok, treeId, autoId, operator}
   *                                       When present, capture is locked to that
   *                                       session: variety/blok come from it and
   *                                       the tree is named VARIETY_BLOK_0001.
   * @param {function} [opts.onProgress]  (step, total) => void
   * @param {function} [opts.onTreeReady] (datasetTree) => void
   * @returns {Promise<object|null>} the datasetTree, or null if cancelled.
   */
  async function start(opts = {}) {
    const session = (opts.session && typeof opts.session === 'object') ? opts.session : null;
    const sideCount = Math.max(2, opts.sideCount || (session && session.sideCount) || 4);
    const onProgress  = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const onTreeReady = typeof opts.onTreeReady === 'function' ? opts.onTreeReady : null;

    const overlay = _mountOverlay();

    try {
      // (a) metadata — locked per-pohon form in session mode, full form otherwise.
      const metadata = session
        ? await _collectLockedMetadata(overlay, session)
        : await _collectMetadata(overlay);
      if (!metadata) { _teardown(overlay); return null; }

      // (b) filesystem-safe tree name.
      //   session : ${VARIETY}_${BLOK}_${0001}
      //   freeform: ${variety}_${YYYYMMDD}_${seq}
      const treeName = session
        ? _treeNameFor(metadata.variety, metadata.blok, metadata.treeId)
        : `${_safe(metadata.variety)}_${_yyyymmdd(new Date())}_${_nextSeq()}`;

      // (c) capture each side, with retake/use review.
      const shots = [];
      for (let i = 1; i <= sideCount; i++) {
        const shot = await _captureSide(overlay, i, sideCount);
        if (!shot) { _teardown(overlay); return null; } // cancelled mid-flow
        shots.push(shot);
        if (onProgress) onProgress(i, sideCount);
      }

      // (d) persist + build tree
      _showSaving(overlay);
      const datasetTree = await _persistAndBuild(treeName, metadata, shots);
      // Session mode: surface the numeric tree id + side count so the caller can
      // record this pohon in the session index.
      if (session) {
        datasetTree.treeId = metadata.treeId;
        datasetTree.sideCount = sideCount;
      }

      // (e) hand off + resolve
      _teardown(overlay);
      if (onTreeReady) onTreeReady(datasetTree);
      return datasetTree;
    } catch (e) {
      console.error('[CaptureFlow] unexpected error:', e);
      _teardown(overlay);
      return null;
    }
  }

  return { start };
})();

window.CaptureFlow = CaptureFlow;
