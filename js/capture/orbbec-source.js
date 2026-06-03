'use strict';

/**
 * OrbbecSource — CaptureSource backed by the native Orbbec USB (RGB-D) camera.
 *
 * Bridges the CaptureSource interface (see js/capture/capture-source.js) to the
 * native Capacitor plugin window.Capacitor.Plugins.Orbbec (OrbbecPlugin.kt).
 * The native USB-host parts (enumerate / request permission) are real; the SDK
 * frame capture is a Phase 5 stub that rejects until the Orbbec Android SDK
 * .aar is integrated on-device. This source is registered when present but is
 * never the default — the built-in device camera stays the default source.
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
   * Capture one color frame from the Orbbec camera.
   *
   * Opens the pipeline (native open()) then grabs a frame (native capture()),
   * converting the returned base64 JPEG into a Blob with pixel dimensions.
   *
   * NOTE (Phase 5): the native capture() is currently a stub that rejects with
   * "Orbbec SDK not integrated yet" — that error is surfaced to the caller. The
   * capture flow treats a thrown error as a failed capture (distinct from the
   * null "user cancelled" return).
   *
   * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
   */
  async function capture() {
    const Orbbec = _plugin();
    if (!Orbbec || typeof Orbbec.capture !== 'function') {
      throw new Error('Orbbec plugin unavailable');
    }

    // Ensure the pipeline is open before grabbing a frame. open() is also a
    // Phase 5 stub today, so this rejects with the SDK-not-integrated message.
    if (typeof Orbbec.open === 'function') {
      await Orbbec.open();
    }

    const frame = await Orbbec.capture();
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

    return { blob, width, height };
  }

  return { id, name, isAvailable, capture };
})();

// Register with the CaptureSource registry when it is present so Orbbec appears
// in the source list. It is NOT made the default — the built-in device camera
// remains the default source.
if (window.CaptureSources && typeof window.CaptureSources.register === 'function') {
  window.CaptureSources.register(OrbbecSource);
}

window.OrbbecSource = OrbbecSource;
