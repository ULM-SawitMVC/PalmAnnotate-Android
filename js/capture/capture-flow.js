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
 * Orbbec USB source (Phase 5) drops in without changes here.
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
      form.appendChild(gpsField);

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
          gps,
        });
      });
    });
  }

  /**
   * Best-effort current position. Native uses the Capacitor Geolocation plugin;
   * web uses navigator.geolocation. Resolves null on any failure/denial so the
   * caller can skip GPS without aborting capture.
   * @returns {Promise<{lat:number, lng:number, accuracy?:number}|null>}
   */
  async function _getPosition() {
    const nativeGeo = window.Capacitor &&
                      window.Capacitor.Plugins &&
                      window.Capacitor.Plugins.Geolocation;
    if (nativeGeo && typeof nativeGeo.getCurrentPosition === 'function') {
      try {
        const pos = await nativeGeo.getCurrentPosition();
        const c = pos && pos.coords;
        if (!c) return null;
        return { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
      } catch (e) {
        return null;
      }
    }
    if (navigator.geolocation) {
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
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
   * @param {function} [opts.onProgress]  (step, total) => void
   * @param {function} [opts.onTreeReady] (datasetTree) => void
   * @returns {Promise<object|null>} the datasetTree, or null if cancelled.
   */
  async function start(opts = {}) {
    const sideCount = Math.max(2, opts.sideCount || 4);
    const onProgress  = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const onTreeReady = typeof opts.onTreeReady === 'function' ? opts.onTreeReady : null;

    const overlay = _mountOverlay();

    try {
      // (a) metadata
      const metadata = await _collectMetadata(overlay);
      if (!metadata) { _teardown(overlay); return null; }

      // (b) filesystem-safe tree name: ${variety}_${YYYYMMDD}_${seq}
      const treeName = `${_safe(metadata.variety)}_${_yyyymmdd(new Date())}_${_nextSeq()}`;

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
