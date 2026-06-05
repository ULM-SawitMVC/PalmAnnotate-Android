'use strict';

/**
 * OrbbecSource — CaptureSource backed by the native Orbbec USB (RGB-D) camera.
 *
 * Bridges the CaptureSource interface (see js/capture/capture-source.js) to the
 * native Capacitor plugin window.Capacitor.Plugins.Orbbec (OrbbecPlugin.kt).
 * The native plugin enumerates/request-permissions via Android USB-host APIs and
 * captures a color frame plus a raw uint16 depth sidecar through Orbbec's
 * Android SDK wrapper. RGB is still used for annotation; depth is persisted with
 * the same tree/side stem for future RGB-D / 4-channel YOLO training.
 *
 * ─── CaptureSource interface ───────────────────────────────────────────────
 *   id        : 'orbbec'
 *   name      : 'Orbbec USB camera'
 *   async isAvailable() -> boolean
 *   async capture() -> { blob, width, height } | null
 */

const OrbbecSource = (() => {

  const id   = 'orbbec';
  const name = 'Orbbec USB camera';

  function _isNativeRuntime() {
    return !!(window.Capacitor &&
              window.Capacitor.isNativePlatform &&
              window.Capacitor.isNativePlatform());
  }

  /** The native Orbbec plugin, or null on web / when not installed. */
  function _plugin() {
    return (window.Capacitor &&
            window.Capacitor.Plugins &&
            window.Capacitor.Plugins.Orbbec) || null;
  }

  /**
   * Available only on a native runtime where the Orbbec plugin is present and
   * reports at least one connected Orbbec USB device. Never throws — any error
   * (plugin missing a method, USB query failure) resolves to false so the
   * source list simply omits Orbbec rather than breaking the picker.
   */
  async function isAvailable() {
    if (!_isNativeRuntime()) return false;
    const Orbbec = _plugin();
    if (!Orbbec || typeof Orbbec.isAvailable !== 'function') return false;
    try {
      const res = await Orbbec.isAvailable();
      return !!(res && res.available === true);
    } catch (e) {
      console.info('[OrbbecSource] isAvailable() failed, treating as unavailable:', e);
      return false;
    }
  }

  // ── base64 → Blob helper ────────────────────────────────────────────────────

  /**
   * Decode a base64 JPEG payload (no data-uri prefix) into a Blob. Strips an
   * accidental "data:...;base64," prefix if one slips through.
   * @returns {Blob}
   */
  function _base64ToBlob(base64, mime) {
    const comma = base64.indexOf(',');
    const raw   = comma >= 0 && base64.slice(0, comma).indexOf('base64') >= 0
      ? base64.slice(comma + 1)
      : base64;
    const binary = atob(raw);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime || 'image/jpeg' });
  }

  /**
   * Read natural width/height of a Blob. Prefers createImageBitmap and falls
   * back to an <img> + object URL. Used only when the native payload omits
   * dimensions.
   * @returns {Promise<{width:number, height:number}>}
   */
  async function _measure(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        const dims = { width: bmp.width, height: bmp.height };
        if (bmp.close) bmp.close();
        return dims;
      } catch (e) {
        // Fall through to the <img> path for formats createImageBitmap rejects.
      }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const dims = { width: img.naturalWidth, height: img.naturalHeight };
        URL.revokeObjectURL(url);
        resolve(dims);
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  /**
   * Convert a native frame payload ({ base64, width, height, format,
   * depthBase64, … }) into the CaptureSource shot shape. The RGB JPEG is decoded
   * to a Blob (dimensions measured only when the native payload omits them) and
   * any synchronized uint16 depth plane is carried as a sidecar Blob + metadata.
   * @returns {Promise<{blob:Blob, width:number, height:number, depthBlob?:Blob, depth?:object}>}
   */
  async function _frameToResult(frame) {
    if (!frame || !frame.base64) {
      throw new Error('Orbbec capture returned no frame');
    }

    const mime = frame.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = _base64ToBlob(frame.base64, mime);

    let width  = frame.width;
    let height = frame.height;
    if (!width || !height) {
      const dims = await _measure(blob);
      width  = dims.width;
      height = dims.height;
    }

    const result = { blob, width, height, sourceId: id };
    if (frame.depthBase64) {
      const depthBlob = _base64ToBlob(frame.depthBase64, 'application/octet-stream');
      result.depthBlob = depthBlob;
      result.depth = {
        width: frame.depthWidth || null,
        height: frame.depthHeight || null,
        format: frame.depthFormat || 'Y16',
        encoding: frame.depthEncoding || 'uint16le',
        valueScale: Number(frame.depthValueScale || 1),
        unit: frame.depthUnit || 'mm',
        alignedTo: frame.depthAlignedTo || 'color',
        displayFloorMm: Number(frame.depthDisplayFloorMm || 250),
        displayCeilingMm: Number(frame.depthDisplayCeilingMm || 7000),
      };
    }

    return result;
  }

  /**
   * Capture one RGB frame and, when the native SDK provides it, its synchronized
   * uint16 depth frame from the Orbbec camera.
   *
   * Opens the pipeline (native open()) then grabs a frame (native capture()),
   * converting the returned base64 JPEG into a Blob with pixel dimensions.
   * The capture flow treats a thrown error as a failed capture (distinct from
   * the null "user cancelled" return).
   *
   * @returns {Promise<{blob:Blob, width:number, height:number, depthBlob?:Blob, depth?:object}|null>}
   */
  async function capture() {
    const Orbbec = _plugin();
    if (!Orbbec || typeof Orbbec.capture !== 'function') {
      throw new Error('Orbbec plugin unavailable');
    }

    if (typeof Orbbec.requestPermission === 'function') {
      const permission = await Orbbec.requestPermission();
      if (!permission || permission.granted !== true) {
        throw new Error('Orbbec USB permission denied');
      }
    }

    // Ensure the pipeline is open before grabbing a frame. Native capture() also
    // opens lazily, but the explicit open gives clearer device/permission errors.
    if (typeof Orbbec.open === 'function') {
      await Orbbec.open();
    }

    const frame = await Orbbec.capture();
    return _frameToResult(frame);
  }

  // ── Live preview (RGB stream + colorized depth field) ──────────────────────

  /**
   * Whether the Orbbec can stream a live in-page preview. Unlike the built-in
   * camera (a WebView <video> via getUserMedia), the Orbbec is a native USB RGB-D
   * device whose frames arrive over the Capacitor bridge — so it renders into a
   * plain container element (mountPreview) instead of a <video>. True only on a
   * native runtime whose plugin exposes the streaming API.
   * @returns {boolean}
   */
  function supportsLivePreview() {
    if (!_isNativeRuntime()) return false;
    const Orbbec = _plugin();
    return !!(Orbbec &&
              typeof Orbbec.startPreview === 'function' &&
              typeof Orbbec.addListener === 'function');
  }

  const FRAME_EVENT = 'orbbecFrame';

  /**
   * Mount a live RGB + colorized-depth preview into `stageEl`. The native plugin
   * pumps throttled, downscaled frames via notifyListeners('orbbecFrame', …); we
   * render the RGB into a full-bleed image and the colorized depth field into a
   * tappable picture-in-picture thumbnail (tap swaps which stream is large).
   *
   * Resolves with an async stop() that detaches the listener, stops the native
   * pump, and removes the DOM. Throws (so CaptureFlow falls back to one-shot
   * Capture) if permission is denied or the stream can't start.
   *
   * @param {HTMLElement} stageEl
   * @returns {Promise<function():Promise<void>>}
   */
  async function mountPreview(stageEl) {
    const Orbbec = _plugin();
    if (!Orbbec || typeof Orbbec.startPreview !== 'function') {
      throw new Error('Orbbec live preview unavailable');
    }

    if (typeof Orbbec.requestPermission === 'function') {
      const permission = await Orbbec.requestPermission();
      if (!permission || permission.granted !== true) {
        throw new Error('Orbbec USB permission denied');
      }
    }

    const doc = (stageEl && stageEl.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('No document to mount Orbbec preview into');

    const wrap = doc.createElement('div');
    wrap.className = 'orbbec-live';

    const mainImg = doc.createElement('img');
    mainImg.className = 'orbbec-live__main';
    mainImg.alt = '';

    const pip = doc.createElement('button');
    pip.type = 'button';
    pip.className = 'orbbec-live__pip';
    const pipImg = doc.createElement('img');
    pipImg.className = 'orbbec-live__pipimg';
    pipImg.alt = '';
    const pipLabel = doc.createElement('span');
    pipLabel.className = 'orbbec-live__piplabel';
    pip.appendChild(pipImg);
    pip.appendChild(pipLabel);

    const waiting = doc.createElement('div');
    waiting.className = 'orbbec-live__waiting';
    waiting.textContent = 'Connecting to Orbbec…';

    wrap.appendChild(mainImg);
    wrap.appendChild(pip);
    wrap.appendChild(waiting);
    stageEl.appendChild(wrap);

    // RGB is the main view by default; the depth field rides in the PiP. Tapping
    // the PiP swaps them so the operator can inspect the depth field full-bleed.
    let mainIsDepth = false;
    let lastRgb = null;
    let lastDepth = null;

    function _paint() {
      const main = mainIsDepth ? lastDepth : lastRgb;
      const inset = mainIsDepth ? lastRgb : lastDepth;
      if (main) mainImg.src = main;
      if (inset) pipImg.src = inset;
      pipLabel.textContent = mainIsDepth ? 'RGB' : 'Depth';
    }

    pip.addEventListener('click', () => {
      mainIsDepth = !mainIsDepth;
      wrap.classList.toggle('orbbec-live--depth-main', mainIsDepth);
      _paint();
    });

    let gotFirst = false;
    function _onFrame(ev) {
      if (!ev) return;
      if (ev.rgb) lastRgb = 'data:image/jpeg;base64,' + ev.rgb;
      if (ev.depth) lastDepth = 'data:image/jpeg;base64,' + ev.depth;
      if (!gotFirst && (lastRgb || lastDepth)) {
        gotFirst = true;
        waiting.classList.add('orbbec-live__waiting--hidden');
      }
      // No depth (depth disabled / underpowered): hide the PiP until a depth frame arrives.
      pip.classList.toggle('orbbec-live__pip--empty', !!lastRgb && !lastDepth);
      _paint();
    }

    let handle = null;
    try {
      handle = await Orbbec.addListener(FRAME_EVENT, _onFrame);
    } catch (e) {
      console.info('[OrbbecSource] addListener failed:', e);
    }

    try {
      await Orbbec.startPreview();
    } catch (e) {
      if (handle && typeof handle.remove === 'function') { try { await handle.remove(); } catch (_) {} }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      throw e;
    }

    let stopped = false;
    return async function stop() {
      if (stopped) return;
      stopped = true;
      if (handle && typeof handle.remove === 'function') { try { await handle.remove(); } catch (_) {} }
      try { if (typeof Orbbec.stopPreview === 'function') await Orbbec.stopPreview(); } catch (_) {}
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    };
  }

  /**
   * Grab one full-resolution RGB(+depth) frame while the live preview is running.
   * The native pump fulfils the request from its next frameset, so no separate
   * permission/open round-trip is needed (mountPreview already did it).
   * @returns {Promise<{blob:Blob, width:number, height:number, depthBlob?:Blob, depth?:object}>}
   */
  async function grab() {
    const Orbbec = _plugin();
    if (!Orbbec || typeof Orbbec.capture !== 'function') {
      throw new Error('Orbbec plugin unavailable');
    }
    const frame = await Orbbec.capture();
    return _frameToResult(frame);
  }

  /**
   * Re-scan the USB bus and drop any stale SDK context so a re-plugged Orbbec is
   * found again. Fixes the "first connect works, but unplug → replug never gets
   * detected" bug: the native refresh() tears down the dead context and reports
   * the live device set. Falls back to isAvailable() on older plugins. Never
   * throws — resolves false on any error.
   * @returns {Promise<boolean>}
   */
  async function refresh() {
    if (!_isNativeRuntime()) return false;
    const Orbbec = _plugin();
    if (!Orbbec) return false;
    try {
      if (typeof Orbbec.refresh === 'function') {
        const res = await Orbbec.refresh();
        return !!(res && res.available === true);
      }
      if (typeof Orbbec.isAvailable === 'function') {
        const res = await Orbbec.isAvailable();
        return !!(res && res.available === true);
      }
    } catch (e) {
      console.info('[OrbbecSource] refresh failed:', e);
    }
    return false;
  }

  return { id, name, isAvailable, capture, supportsLivePreview, mountPreview, grab, refresh };
})();

// Register with the CaptureSource registry when it is present so Orbbec appears
// in the source list. It is NOT made the default — the built-in device camera
// remains the default source.
if (window.CaptureSources && typeof window.CaptureSources.register === 'function') {
  window.CaptureSources.register(OrbbecSource);
}

window.OrbbecSource = OrbbecSource;
