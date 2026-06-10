'use strict';

/**
 * CaptureFlow — the capture-first workflow (Phase 2, reworked).
 *
 * An operator photographs ONE tree from N views (default 4), tagging the set
 * with metadata (variety, operator, timestamp, optional GPS). The accepted
 * photos are persisted via Storage.active() and assembled into a normal
 * datasetTree, which then flows into the existing annotation pipeline exactly
 * like a folder-loaded tree.
 *
 * The reworked flow is friction-free:
 *   - Session mode jumps STRAIGHT to a single embedded live-camera surface
 *     (no pre-photo metadata screen): auto-ID is already known and GPS is
 *     grabbed silently in the background; manual-ID sessions get a small inline
 *     ID field on the camera surface.
 *   - Each side is captured WITHOUT a per-side review popup — tap the shutter
 *     and the surface advances to the next side, the camera stream staying live.
 *   - After the last side, ONE swipe-review carousel shows every shot with a
 *     per-shot Retake plus Save / Cancel.
 *   - Freeform capture (no session) keeps a minimal variety/operator form, then
 *     uses the exact same embedded camera + review.
 *
 * The camera streams INSIDE the app via CaptureSource.openPreview()/grab()
 * (WebView getUserMedia). Sources without a live preview (e.g. Orbbec) fall back
 * to a one-shot Capture button calling source.capture(); the rest of the flow is
 * identical.
 *
 * Public API:
 *   CaptureFlow.start(opts) -> Promise<datasetTree|null>
 *     opts:
 *       sideCount   : number   (default 4)
 *       session     : {variety, blok, treeId, autoId, operator, sideCount}
 *       onProgress  : (step, total) => void   // fired as each side is accepted
 *       onTreeReady : (datasetTree) => void    // fired once before resolve
 *
 * The returned datasetTree matches DatasetManager's shape:
 *   { name, split:'field', metadata:{variety,operator,timestamp,gps},
 *     sides:[ { imageFile, imageUri, labelFile:null, labelUri:null } ] }
 *
 * All UI is built/removed here (appended to document.body) and styled via
 * css/capture.css.
 */
const CaptureFlow = (() => {

  // Variety presets surfaced in the metadata form. "Other" reveals a free-text
  // field so field crews can record varieties not in the list.
  const VARIETY_PRESETS = ['DAMIMAS', 'Other'];

  // Per-session sequence counter. Seeded from the current epoch-millisecond
  // value (standard Date API) so names are unique across app launches without a
  // persistent store, then incremented per captured tree.
  let _seq = Date.now() % 1000;
  let _selectedSourceId = null;

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

  /** Return registered capture sources whose isAvailable() check passes. */
  async function _availableSources() {
    const registry = window.CaptureSources;
    const sources = registry && typeof registry.list === 'function'
      ? registry.list()
      : [];
    const available = [];
    for (const src of sources) {
      if (!src || typeof src.capture !== 'function') continue;
      try {
        if (!src.isAvailable || await src.isAvailable()) available.push(src);
      } catch (_) {
        // A broken optional source must not block the built-in camera.
      }
    }
    if (!available.length && registry && typeof registry.default === 'function') {
      const fallback = registry.default();
      if (fallback) available.push(fallback);
    }
    return available;
  }

  function _chooseSource(available) {
    if (!available || !available.length) return null;
    const remembered = _selectedSourceId && available.find(s => s.id === _selectedSourceId);
    if (remembered) return remembered;
    const builtin = available.find(s => s.id === 'builtin-camera');
    return builtin || available[0];
  }

  /** Whether a source can stream an in-page live preview. */
  function _isLiveSource(src) {
    return !!(src &&
              typeof src.supportsLivePreview === 'function' && src.supportsLivePreview() &&
              typeof src.openPreview === 'function' &&
              typeof src.grab === 'function');
  }

  /** True on a native Capacitor runtime (where USB sources can appear/disappear). */
  function _isNativeRuntime() {
    return !!(window.Storage && Storage.isNative && Storage.isNative());
  }

  /** Ask every source that supports it to re-scan hardware (e.g. a replugged USB camera). */
  async function _refreshSources() {
    const registry = window.CaptureSources;
    const sources = registry && typeof registry.list === 'function' ? registry.list() : [];
    for (const src of sources) {
      if (src && typeof src.refresh === 'function') {
        try { await src.refresh(); } catch (_) { /* a broken source must not block refresh */ }
      }
    }
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
   * Build the optional "Get GPS" field used by the freeform metadata form.
   * Returns the field element plus a getter for the last resolved position (or
   * null). Best-effort and never throws — see _getPosition().
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

  // ── Freeform metadata form (no session) ─────────────────────────────────────

  /**
   * Render the metadata form into `overlay` and resolve with a metadata object
   * when the operator continues, or null if they cancel. Only used for freeform
   * capture; session mode jumps straight to the camera.
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

  // Hard ceiling on how long we wait for a fix before giving up. A GPS cold
  // start outdoors can take a while; 15s balances "give it a real chance"
  // against "don't trap the operator".
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

  /**
   * Build the "Side i / N" progress header with a row of step dots. Dots are
   * marked done from the `shots` array (an accepted shot per side) so the header
   * reflects real progress, with the current side highlighted.
   */
  function _buildProgress(sideNum, sideCount, shots) {
    const wrap = _el('div', 'capture-progress');
    wrap.appendChild(_el('h2', 'capture-title', `View ${sideNum} / ${sideCount}`));
    wrap.appendChild(_el('p', 'capture-subtitle capture-subtitle--compact', 'Same tree, next view — not a new tree.'));
    const dots = _el('div', 'capture-progress__dots capture-progress__dots--views');
    for (let i = 1; i <= sideCount; i++) {
      const dot = _el('span', 'capture-dot');
      dot.textContent = `V${i}`;
      if (shots && shots[i - 1]) dot.classList.add('capture-dot--done');
      else if (i === sideNum) dot.classList.add('capture-dot--active');
      dots.appendChild(dot);
    }
    wrap.appendChild(dots);
    return wrap;
  }

  // ── Step 2: embedded capture surface (popup-free) ───────────────────────────

  /**
   * Drive a set of side `targets` (e.g. [0,1,2,3] for the first pass, or [2] for
   * a single retake) on ONE persistent capture surface. The live camera stream
   * stays mounted across sides; tapping the shutter grabs a frame and advances
   * to the next target immediately — no per-side confirm. Accepted shots are
   * written into `shots[sideIndex]`.
   *
   * Resolves true when every target is captured, or false if the operator
   * cancels. Sources without a live preview fall back to a Capture button that
   * calls source.capture() per side.
   *
   * @returns {Promise<boolean>}
   */
  function _capturePass(overlay, shots, targets, sideCount, opts, ctl) {
    return new Promise((resolve) => {
      let settled = false;
      let busy = false;
      let ti = 0;                 // index into targets
      let source = null;
      let available = [];
      let live = false;
      // 'video'   → built-in camera streams into a <video> (getUserMedia)
      // 'element' → source renders its own preview DOM (Orbbec RGB + depth field)
      // 'oneshot' → no live preview; a Capture button calls source.capture()
      let previewMode = 'oneshot';
      let stopPreview = null;
      let video = null;
      let progressHost = null;
      let deviceChangeHandle = null;  // native USB attach/detach subscription
      let buildSeq = 0;

      async function _stopCurrentPreview() {
        const stop = stopPreview;
        stopPreview = null;
        if (!stop) return;
        try { await stop(); } catch (_) {}
      }

      async function finish(val) {
        if (settled) return;
        settled = true;
        buildSeq++;
        if (deviceChangeHandle && typeof deviceChangeHandle.remove === 'function') {
          try { await deviceChangeHandle.remove(); } catch (_) {}
          deviceChangeHandle = null;
        }
        await _stopCurrentPreview();
        resolve(val);
      }

      // Auto re-scan sources when a USB camera is (un)plugged mid-capture, so a
      // (re)attached Orbbec reappears without leaving the surface. The native
      // plugin emits orbbecDeviceChange from a USB hotplug BroadcastReceiver
      // registered at plugin load (no SDK context needed), so this covers the
      // cold first-plug case too; "Find camera" remains as a manual fallback.
      async function _subscribeDeviceChange() {
        const Orbbec = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Orbbec;
        if (!Orbbec || typeof Orbbec.addListener !== 'function') return;
        try {
          deviceChangeHandle = await Orbbec.addListener('orbbecDeviceChange', async () => {
            if (settled || busy) return;
            await _stopCurrentPreview();
            if (!settled) _buildSurface();
          });
        } catch (_) { /* listener optional */ }
      }

      function _renderProgress() {
        if (!progressHost) return;
        progressHost.innerHTML = '';
        const sideNum = (targets[ti] != null ? targets[ti] : targets[targets.length - 1]) + 1;
        progressHost.appendChild(_buildProgress(sideNum, sideCount, shots));
      }

      async function _capture() {
        if (busy || settled) return;
        busy = true;
        let shot = null;
        try {
          if (previewMode === 'video' && video) shot = await source.grab(video);
          else if (previewMode === 'element') shot = await source.grab();
          else if (source) shot = await source.capture();
        } catch (e) {
          console.warn('[CaptureFlow] capture failed:', e);
          shot = null;
        }
        busy = false;
        // null = the source's own UI was cancelled / encode failed; stay here.
        if (!shot) return;
        const sideIndex = targets[ti];
        if (ctl) shot.sideIndex = sideIndex;
        shots[sideIndex] = shot;
        ti++;
        if (opts.onProgress) opts.onProgress(shots.filter(Boolean).length, sideCount);
        if (ti >= targets.length) { finish(true); return; }
        _renderProgress();
      }

      /** Build the source switch (Device Camera ⇄ Orbbec USB) for the control row. */
      function _buildSourceSwitch() {
        const row = _el('label', 'capture-source capture-source--inline capture-live__source');
        row.appendChild(_el('span', 'capture-source__label', 'Camera'));
        const select = _el('select', 'capture-source__select');
        for (const src of available) {
          const opt = _el('option', null, src.name || src.id);
          opt.value = src.id;
          if (src.id === (source && source.id)) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener('change', async () => {
          _selectedSourceId = select.value;
          // Re-open the surface with the newly chosen source. Awaiting the old
          // preview stop prevents a native Orbbec pump from racing the next
          // source's open/start path after USB-C detach/PD renegotiation.
          await _stopCurrentPreview();
          if (!settled) _buildSurface();
        });
        row.appendChild(select);
        return row;
      }

      async function _buildSurface() {
        const seq = ++buildSeq;
        overlay.innerHTML = '';
        available = await _availableSources();
        if (settled || seq !== buildSeq) return;
        source = _chooseSource(available);

        // Element-preview sources (Orbbec) render their own RGB + depth-field DOM
        // into the stage; video-preview sources (built-in camera) stream into a
        // <video> via getUserMedia. Everything else is a one-shot Capture button.
        const elementPreview = !!(source &&
          typeof source.supportsLivePreview === 'function' && source.supportsLivePreview() &&
          typeof source.mountPreview === 'function' && typeof source.grab === 'function');
        const videoPreview = !elementPreview && _isLiveSource(source);
        previewMode = elementPreview ? 'element' : (videoPreview ? 'video' : 'oneshot');
        live = previewMode !== 'oneshot';

        const panel = _el('div', 'capture-panel capture-live');

        // Top: side indicator + dots, plus the optional manual-ID field. The
        // camera/source switch now lives down in the control row (beside the
        // shutter) so it no longer crowds the progress header.
        const top = _el('div', 'capture-live__top');
        progressHost = _el('div', 'capture-live__progress');
        top.appendChild(progressHost);

        // Manual-ID sessions: a small inline numeric ID field (auto-ID hides it).
        if (ctl && ctl.manualIdEnabled) {
          const idRow = _el('label', 'capture-source capture-source--inline');
          idRow.appendChild(_el('span', 'capture-source__label', 'Tree ID'));
          const idInput = _el('input', 'capture-source__select capture-idinput');
          idInput.type = 'number';
          idInput.min = '1';
          idInput.step = '1';
          idInput.value = String(ctl.manualId || 1);
          const syncId = () => {
            const parsed = Math.floor(Number(idInput.value));
            if (Number.isFinite(parsed) && parsed >= 1) ctl.manualId = parsed;
          };
          idInput.addEventListener('change', syncId);
          idInput.addEventListener('input', syncId);
          // Keep a reference so the final tree id can be read at save time even
          // if no change/input event fired (e.g. programmatic value set).
          ctl.idEl = idInput;
          idRow.appendChild(idInput);
          top.appendChild(idRow);
        }

        panel.appendChild(top);

        // Stage: built-in camera streams into a <video>; Orbbec renders its own
        // preview DOM here (mountPreview); one-shot sources show a placeholder.
        const stage = _el('div', 'capture-live__stage');
        if (videoPreview) {
          video = _el('video', 'capture-live__video');
          stage.appendChild(video);
        } else {
          video = null;
          if (!elementPreview) {
            stage.appendChild(_el('div', 'capture-live__placeholder',
              source ? `Tap Capture (${source.name || source.id})` : 'No camera available'));
          }
        }
        panel.appendChild(stage);

        // Controls — Cancel + (optional) source switch + the big Capture shutter.
        // CSS positions the cluster on the right (tablet/landscape) or bottom
        // (phone/portrait).
        const controls = _el('div', 'capture-live__controls');
        const cancelBtn = _el('button', 'capture-btn capture-btn--ghost capture-live__cancel', 'Cancel');
        cancelBtn.type = 'button';
        const shootBtn = _el('button', 'capture-btn capture-btn--primary capture-live__shoot', 'Capture');
        shootBtn.type = 'button';
        shootBtn.disabled = !source;
        controls.appendChild(cancelBtn);
        if (available.length > 1) controls.appendChild(_buildSourceSwitch());
        // "Find camera" — re-scan hardware so a (re)plugged USB camera (Orbbec)
        // is detected without leaving the capture surface. Native only.
        if (_isNativeRuntime()) {
          const refreshBtn = _el('button', 'capture-btn capture-btn--outline capture-live__refresh', 'Find camera');
          refreshBtn.type = 'button';
          refreshBtn.addEventListener('click', async () => {
            if (busy || settled) return;
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Scanning…';
            await _stopCurrentPreview();
            try { await _refreshSources(); } catch (_) {}
            if (!settled) _buildSurface();
          });
          controls.appendChild(refreshBtn);
        }
        controls.appendChild(shootBtn);
        panel.appendChild(controls);

        overlay.appendChild(panel);

        cancelBtn.addEventListener('click', () => finish(false));
        shootBtn.addEventListener('click', () => _capture());

        _renderProgress();

        // Open the live preview (reused across all targets). On failure, fall
        // back to a one-shot Capture button by rebuilding the surface.
        if (videoPreview && video) {
          try {
            const stop = await source.openPreview(video);
            // If the operator cancelled (or switched source) while getUserMedia
            // was resolving, finish() already ran with stopPreview still null —
            // stop this now-orphaned stream so the camera doesn't stay live.
            if (settled || seq !== buildSeq) { try { await stop(); } catch (_) {} }
            else { stopPreview = stop; }
          } catch (e) {
            console.info('[CaptureFlow] live preview unavailable, using one-shot capture:', e);
            previewMode = 'oneshot';
            live = false;
            stopPreview = null;
            if (!settled && seq === buildSeq) _buildSurface();
          }
        } else if (elementPreview) {
          try {
            const stop = await source.mountPreview(stage);
            if (settled || seq !== buildSeq) { try { await stop(); } catch (_) {} }
            else { stopPreview = stop; }
          } catch (e) {
            console.info('[CaptureFlow] Orbbec live preview unavailable, using one-shot capture:', e);
            previewMode = 'oneshot';
            live = false;
            stopPreview = null;
            if (!settled && seq === buildSeq) _buildSurface();
          }
        }
      }

      _subscribeDeviceChange();
      _buildSurface();
    });
  }

  // ── Step 3: review every shot (swipe carousel + per-shot retake) ─────────────

  /**
   * Show all captured shots in a single swipeable strip. Each shot has a Retake
   * control; the operator decides once at the end. Resolves with:
   *   { action: 'save' }            — persist the tree
   *   { action: 'cancel' }          — abort the whole capture
   *   { action: 'retake', index }   — re-shoot one side, then return here
   */
  function _renderCaptureQa(shots, sideCount, metadata, opts) {
    opts = opts || {};
    const report = window.QualityCheck && QualityCheck.analyzeCaptureShots
      ? QualityCheck.analyzeCaptureShots(shots, sideCount, metadata)
      : { status: 'ok', issues: [], metrics: {} };
    // Only the actionable (non-info) issues are shown below, so the badge must
    // count THOSE — otherwise a hidden info note made the badge read "2 issue(s)"
    // while only one line was ever explained (the confusing GPS case).
    const shown = (report.issues || []).filter(i => i.level !== 'info').slice(0, 5);
    const wrap = _el('details', `capture-qa capture-qa--${report.status}`);
    wrap.open = report.status !== 'ok';
    const summary = _el('summary', 'capture-qa__summary');
    summary.appendChild(_el('span', 'capture-qa__title', 'Pre-save check'));
    summary.appendChild(_el('span', 'capture-qa__badge', shown.length ? `${shown.length} issue(s)` : 'OK'));
    wrap.appendChild(summary);

    const metrics = report.metrics || {};
    const metricRow = _el('div', 'capture-qa__metrics');
    metricRow.appendChild(_el('span', 'capture-qa__metric', `${metrics.capturedSides || 0}/${metrics.expectedSides || sideCount} RGB`));
    metricRow.appendChild(_el('span', 'capture-qa__metric', `${metrics.depthSides || 0} depth`));
    metricRow.appendChild(_el('span', 'capture-qa__metric', metadata && metadata.gps ? 'GPS set' : 'GPS missing'));
    wrap.appendChild(metricRow);

    const list = _el('div', 'capture-qa__issues');
    if (!shown.length) list.appendChild(_el('p', 'capture-qa__issue capture-qa__issue--ok', 'Metadata, RGB views, and depth pair status look ready.'));
    for (const it of shown) list.appendChild(_el('p', `capture-qa__issue capture-qa__issue--${it.level}`, it.message));

    // GPS is grabbed silently in the background during a session capture, so the
    // review screen had no way to set it if the background fix failed/was slow —
    // it just nagged "GPS missing" with no recourse. Give the operator a button.
    if (metadata && !metadata.gps && typeof opts.onGps === 'function') {
      const gpsBtn = _el('button', 'capture-btn capture-btn--outline capture-qa__gps', 'Get GPS');
      gpsBtn.type = 'button';
      gpsBtn.addEventListener('click', () => opts.onGps(gpsBtn));
      list.appendChild(gpsBtn);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function _reviewAll(overlay, shots, sideCount, metadata) {
    return new Promise((resolve) => {
      overlay.innerHTML = '';
      const urls = [];
      // Immersive, full-bleed review: the photo dominates the screen; chrome
      // floats in a slim top strip and a pinned bottom action bar so nothing
      // (e.g. Retake) gets clipped the way the old centered card did.
      const panel = _el('div', 'capture-panel capture-reviewall capture-reviewall--immersive');

      // ── Top strip: "Side x / N" + compact pre-save check ──────────────────
      const topbar = _el('div', 'capture-reviewall__topbar');
      const pageLabel = _el('span', 'capture-reviewall__pagelabel', `Side 1 / ${sideCount}`);
      topbar.appendChild(pageLabel);

      // The pre-save check is rebuilt in place when GPS is fetched, so the
      // "GPS missing" warning + button flip to "GPS set" without leaving review.
      let qaEl = null;
      function _refreshQa() {
        const next = _renderCaptureQa(shots, sideCount, metadata, { onGps: _handleGps });
        if (qaEl && qaEl.parentNode) qaEl.parentNode.replaceChild(next, qaEl);
        else topbar.appendChild(next);
        qaEl = next;
      }
      async function _handleGps(btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Locating…'; }
        let gps = null;
        try { gps = await _getPosition(); } catch (_) { gps = null; }
        if (gps) { metadata.gps = gps; _refreshQa(); }
        else if (btn) { btn.disabled = false; btn.textContent = 'GPS unavailable — retry'; }
      }
      _refreshQa();
      panel.appendChild(topbar);

      // ── Image strip (swipe carousel, fills remaining height) ──────────────
      const strip = _el('div', 'capture-reviewall__strip');
      for (let i = 0; i < sideCount; i++) {
        const shot = shots[i];
        const slide = _el('div', 'capture-reviewall__slide');
        const img = _el('img', 'capture-reviewall__img');
        if (shot && shot.blob) {
          const url = URL.createObjectURL(shot.blob);
          urls.push(url);
          img.src = url;
        }
        slide.appendChild(img);
        const retake = _el('button', 'capture-btn capture-btn--outline capture-reviewall__retake', 'Retake');
        retake.type = 'button';
        retake.addEventListener('click', () => done({ action: 'retake', index: i }));
        slide.appendChild(retake);
        strip.appendChild(slide);
      }
      panel.appendChild(strip);

      // ── Page dots (one per side; tap to jump) ─────────────────────────────
      const dots = _el('div', 'capture-reviewall__dots');
      const dotEls = [];
      for (let i = 0; i < sideCount; i++) {
        const dot = _el('button', 'capture-reviewall__dot' + (i === 0 ? ' is-active' : ''));
        dot.type = 'button';
        dot.setAttribute('aria-label', `Go to side ${i + 1}`);
        dot.addEventListener('click', () => _scrollToSlide(i));
        dots.appendChild(dot);
        dotEls.push(dot);
      }
      panel.appendChild(dots);

      // ── Bottom action bar ─────────────────────────────────────────────────
      const actions = _el('div', 'capture-actions capture-actions--review');
      const cancelBtn = _el('button', 'capture-btn capture-btn--ghost', 'Cancel');
      cancelBtn.type = 'button';
      const saveBtn = _el('button', 'capture-btn capture-btn--primary', 'Save');
      saveBtn.type = 'button';
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      panel.appendChild(actions);

      overlay.appendChild(panel);

      // Keep the page label + active dot in sync with the swiped slide. Fully
      // guarded so the headless dom-stub (no real layout/scroll) never throws.
      let active = 0;
      function _setActive(i) {
        const clamped = Math.max(0, Math.min(sideCount - 1, i));
        if (clamped === active) return;
        active = clamped;
        pageLabel.textContent = `Side ${clamped + 1} / ${sideCount}`;
        dotEls.forEach((d, j) => d.classList.toggle('is-active', j === clamped));
      }
      function _scrollToSlide(i) {
        const w = strip.clientWidth || 0;
        try {
          if (typeof strip.scrollTo === 'function') strip.scrollTo({ left: i * w, behavior: 'smooth' });
          else strip.scrollLeft = i * w;
        } catch (_) { try { strip.scrollLeft = i * w; } catch (__) {} }
        _setActive(i);
      }
      if (typeof strip.addEventListener === 'function') {
        strip.addEventListener('scroll', () => {
          const w = strip.clientWidth || 1;
          _setActive(Math.round((strip.scrollLeft || 0) / w));
        });
      }

      let settled = false;
      function done(val) {
        if (settled) return;
        settled = true;
        for (const u of urls) { try { URL.revokeObjectURL(u); } catch (_) {} }
        resolve(val);
      }
      cancelBtn.addEventListener('click', () => done({ action: 'cancel' }));
      saveBtn.addEventListener('click', () => done({ action: 'save' }));
    });
  }

  /**
   * Capture every side, then loop on the review carousel until the operator
   * saves or cancels. Returns the accepted shots (length === sideCount) or null
   * if the capture was cancelled before saving.
   * @returns {Promise<Array|null>}
   */
  async function _captureAllSides(overlay, sideCount, opts, ctl, metadata) {
    const shots = new Array(sideCount).fill(null);

    // First pass over every side.
    const range = [];
    for (let i = 0; i < sideCount; i++) range.push(i);
    const ok = await _capturePass(overlay, shots, range, sideCount, opts, ctl);
    if (!ok) return null;

    // Review / retake loop.
    for (;;) {
      const decision = await _reviewAll(overlay, shots, sideCount, metadata);
      if (decision.action === 'save') return shots;
      if (decision.action === 'cancel') return null;
      if (decision.action === 'retake') {
        // Re-shoot just this side; cancelling the retake returns to review
        // (it must not throw away the other shots).
        await _capturePass(overlay, shots, [decision.index], sideCount, opts, ctl);
      }
    }
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

  // ── Step 4: persist + build the datasetTree ─────────────────────────────────

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
    const cacheBust = `${metadata.timestamp || new Date().toISOString()}_${Date.now()}`;

    // If the operator reuses the same variety/block/tree id, clear stale images,
    // labels and prior output first. This avoids old files winning later loads
    // when a new capture partially fails or the provider refuses overwrite.
    if (adapter && typeof adapter.deleteDatasetTree === 'function') {
      try { await adapter.deleteDatasetTree(treeName, shots.length); } catch (_) {}
    }
    if (saf && typeof saf.deleteDatasetTree === 'function') {
      try { await saf.deleteDatasetTree(treeName, shots.length); } catch (_) {}
    }

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
      if (window.Storage && Storage.isNative && Storage.isNative() && !persisted.uri) {
        throw new Error('Captured photo could not be saved to app storage: ' + filename);
      }
      if (saf) {
        try { await saf.writeImage(`dataset/${relPath}`, shots[i].blob); } catch (_) {}
      }

      let depthFile = null;
      let depthUri = null;
      let depthPath = null;
      let depthMeta = null;
      if (shots[i].depthBlob) {
        const depthFilename = `${treeName}_${sideNum}.raw`;
        const depthRelPath = `depth/field/${depthFilename}`;
        depthMeta = Object.assign({
          file: depthFilename,
          side: sideNum,
          tree: treeName,
          rgbFile: filename,
        }, shots[i].depth || {});
        try {
          const depthPersisted = adapter.persistDatasetFile
            ? await adapter.persistDatasetFile(depthRelPath, shots[i].depthBlob, `depth/field/${depthFilename}`)
            : {};
          depthUri = depthPersisted && depthPersisted.uri || null;
          depthPath = depthPersisted && depthPersisted.path || null;
          depthFile = { name: depthFilename };
          await adapter.writeDatasetJson(`depth/field/${treeName}_${sideNum}.json`, depthMeta);
        } catch (e) {
          console.warn('[CaptureFlow] persist depth failed for', depthRelPath, e);
          depthFile = null;
          depthUri = null;
          depthPath = null;
          depthMeta = null;
        }
        if (saf && depthMeta) {
          try { await saf.writeBlob(`dataset/${depthRelPath}`, shots[i].depthBlob); } catch (_) {}
          try { await saf.writeJson(`dataset/depth/field/${treeName}_${sideNum}.json`, depthMeta); } catch (_) {}
        }
      }

      sides.push({
        imageFile: persisted.file || { name: filename },
        imageUri:  persisted.uri  || null,
        cacheBust: cacheBust + '_' + sideNum,
        labelFile: null,
        labelUri:  null,
        depthFile,
        depthUri,
        depthPath,
        depth: depthMeta,
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

  /**
   * On native, make sure the Android CAMERA runtime permission is GRANTED before
   * any getUserMedia call. This sidesteps a Capacitor WebView bug: when its
   * onPermissionRequest has to request the runtime permission mid-stream, the
   * result handler can call grant()/deny() twice and crash the Activity
   * ("IllegalStateException: Either grant() or deny() has been already called"),
   * which kicks the operator out of the app — then the reopened app prompts a
   * second time before the camera finally streams.
   *
   * Requesting up-front through the Camera plugin's own (correct) permission flow
   * means that by the time getUserMedia runs the permission is already held, so
   * onPermissionRequest grants immediately without the buggy round-trip — one
   * clean prompt, no crash, camera works on the first try.
   *
   * Best-effort: never throws. A denial just lets capture fall back to the
   * one-shot picker (getUserMedia will fail and _captureWeb uses the file input).
   */
  async function _ensureCameraPermission() {
    try {
      const native = window.Storage && Storage.isNative && Storage.isNative();
      if (!native) return;
      const Camera = window.Capacitor &&
                     window.Capacitor.Plugins &&
                     window.Capacitor.Plugins.Camera;
      if (!Camera) return;
      let status = null;
      if (typeof Camera.checkPermissions === 'function') {
        try { status = await Camera.checkPermissions(); } catch (_) { status = null; }
      }
      if (status && status.camera === 'granted') return;
      if (typeof Camera.requestPermissions === 'function') {
        await Camera.requestPermissions({ permissions: ['camera'] });
      }
    } catch (e) {
      console.info('[CaptureFlow] camera permission pre-request skipped:', e);
    }
  }

  // ── Orchestration ───────────────────────────────────────────────────────────

  /**
   * Run the full capture-first flow.
   * @param {object} [opts]
   * @param {number}   [opts.sideCount=4]
   * @param {object}   [opts.session]     {variety, blok, treeId, autoId, operator}
   *                                       When present, capture is locked to that
   *                                       session: variety/blok come from it, the
   *                                       metadata screen is skipped, and the tree
   *                                       is named VARIETY_BLOK_0001.
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
      // (a) metadata. Freeform shows the form; session mode skips it and grabs
      //     GPS silently in the background while the operator shoots.
      let metadata;
      let gpsPromise = null;
      const ctl = { manualId: 1, manualIdEnabled: false };

      if (session) {
        ctl.manualIdEnabled = !session.autoId;
        ctl.manualId = Math.max(1, Math.floor(Number(session.treeId) || 1));
        metadata = {
          variety: session.variety,
          blok: session.blok,
          treeId: ctl.manualId,
          operator: session.operator || '',
          timestamp: new Date().toISOString(),
          gps: null,
        };
        gpsPromise = _getPosition().catch(() => null);
      } else {
        metadata = await _collectMetadata(overlay);
        if (!metadata) { _teardown(overlay); return null; }
      }

      // (b) capture every side (embedded, popup-free) + final review.
      //     Pre-grant the camera runtime permission first so the WebView's
      //     onPermissionRequest never has to request it mid-stream — that
      //     mid-stream path can double-call grant()/deny() and crash the
      //     Activity on the first capture. Placed AFTER the freeform metadata
      //     form so that form still builds synchronously; no-op on web.
      await _ensureCameraPermission();
      const shots = await _captureAllSides(overlay, sideCount, { onProgress }, ctl, metadata);
      if (!shots) { _teardown(overlay); return null; } // cancelled

      // (c) finalise tree name / id (manual ID may have been edited inline).
      let treeName;
      if (session) {
        // Manual ID may have been typed inline; read the latest value.
        if (ctl.idEl) {
          const parsed = Math.floor(Number(ctl.idEl.value));
          if (Number.isFinite(parsed) && parsed >= 1) ctl.manualId = parsed;
        }
        metadata.treeId = ctl.manualId;
        treeName = _treeNameFor(metadata.variety, metadata.blok, metadata.treeId);
        if (gpsPromise) { try { metadata.gps = await gpsPromise; } catch (_) {} }
      } else {
        treeName = `${_safe(metadata.variety)}_${_yyyymmdd(new Date())}_${_nextSeq()}`;
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
