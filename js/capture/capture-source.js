'use strict';

/**
 * CaptureSource — pluggable photo-capture backends for the capture-first flow.
 *
 * A CaptureSource abstracts "where a single photo comes from" so the rest of the
 * capture flow never branches on platform or hardware. The built-in device
 * camera is the DEFAULT source; the Orbbec USB source registers itself via
 * CaptureSources.register(src) without touching CaptureFlow.
 *
 * ─── CaptureSource interface ───────────────────────────────────────────────
 *   id        : string                       // stable identifier
 *   name      : string                       // human label for pickers
 *   async isAvailable() -> boolean           // can this source run right now?
 *   async capture() -> { blob, width, height } | null  // null = user cancelled
 *
 * `width`/`height` are the captured image's natural pixel dimensions, so the
 * annotation pipeline (ActiveSession.loadTree) can size bboxes without a second
 * decode.
 *
 * Native vs web is detected the same way as Storage:
 *   window.Capacitor && window.Capacitor.isNativePlatform && isNativePlatform().
 */

const BuiltinCameraSource = (() => {

  const id   = 'builtin-camera';
  const name = 'Device Camera';

  function _isNativeRuntime() {
    return !!(window.Capacitor &&
              window.Capacitor.isNativePlatform &&
              window.Capacitor.isNativePlatform());
  }

  /**
   * The built-in camera is effectively always available: native goes through
   * the Capacitor Camera plugin, web falls back from getUserMedia to an
   * <input capture> element which every mobile browser supports.
   */
  async function isAvailable() {
    return true;
  }

  // ── Image measuring helper ──────────────────────────────────────────────────

  /**
   * Read natural width/height of a Blob. Prefers createImageBitmap (fast,
   * off-main-thread) and falls back to an <img> + object URL.
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
        // Some decoders reject odd formats — fall through to the <img> path.
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

  // ── Native capture (Capacitor Camera plugin) ────────────────────────────────

  /**
   * Take a photo with the native camera, then load the result into a Blob.
   * Uses resultType:'uri' (cheaper than base64) and converts the webPath /
   * file uri into something fetch() can read.
   * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
   */
  async function _captureNative() {
    const Camera = window.Capacitor &&
                   window.Capacitor.Plugins &&
                   window.Capacitor.Plugins.Camera;
    if (!Camera || typeof Camera.getPhoto !== 'function') {
      // No native plugin despite native runtime — fall back to the web path.
      return _captureWeb();
    }

    let photo;
    try {
      photo = await Camera.getPhoto({
        resultType: 'uri',
        source: 'CAMERA',
        quality: 85,
      });
    } catch (e) {
      // User cancelled the native camera UI, or it failed — treat as cancel.
      console.info('[BuiltinCameraSource] native getPhoto cancelled/failed:', e);
      return null;
    }

    // The plugin returns webPath (preferred for fetch) and/or a native path.
    const src = photo.webPath ||
                (photo.path && window.Capacitor.convertFileSrc(photo.path)) ||
                (photo.uri && window.Capacitor.convertFileSrc(photo.uri));
    if (!src) {
      console.warn('[BuiltinCameraSource] native photo had no readable path:', photo);
      return null;
    }

    const res  = await fetch(src);
    const blob = await res.blob();
    const dims = await _measure(blob);
    return { blob, width: dims.width, height: dims.height };
  }

  // ── Web capture (getUserMedia overlay → canvas) ─────────────────────────────

  /**
   * Open a full-screen camera overlay, stream the environment-facing camera,
   * and resolve with a captured frame when the operator taps the shutter.
   * Falls back to a hidden <input capture> element when getUserMedia is
   * unavailable (older browsers / insecure contexts).
   * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
   */
  async function _captureWeb() {
    const hasGUM = !!(navigator.mediaDevices &&
                      typeof navigator.mediaDevices.getUserMedia === 'function');
    if (!hasGUM) return _captureFileInput();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (e) {
      console.info('[BuiltinCameraSource] getUserMedia denied/unavailable, using file input:', e);
      return _captureFileInput();
    }

    return new Promise((resolve) => {
      // Build the live-preview overlay. Everything is namespaced under
      // .capture-cam-* so css/capture.css can style it without leaking.
      const overlay = document.createElement('div');
      overlay.className = 'capture-overlay capture-cam';

      const video = document.createElement('video');
      video.className = 'capture-cam__video';
      video.setAttribute('playsinline', '');
      video.setAttribute('autoplay', '');
      video.muted = true;
      video.srcObject = stream;

      const bar = document.createElement('div');
      bar.className = 'capture-cam__bar';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'capture-cam__cancel';
      cancelBtn.textContent = 'Cancel';

      const shutter = document.createElement('button');
      shutter.type = 'button';
      shutter.className = 'capture-cam__shutter';
      shutter.setAttribute('aria-label', 'Take photo');

      // Spacer keeps the shutter centered with the cancel button on the left.
      const spacer = document.createElement('div');
      spacer.className = 'capture-cam__spacer';

      bar.appendChild(cancelBtn);
      bar.appendChild(shutter);
      bar.appendChild(spacer);
      overlay.appendChild(video);
      overlay.appendChild(bar);
      document.body.appendChild(overlay);

      let settled = false;

      function cleanup() {
        for (const track of stream.getTracks()) track.stop();
        video.srcObject = null;
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      cancelBtn.addEventListener('click', () => finish(null));

      shutter.addEventListener('click', () => {
        if (settled) return;
        const w = video.videoWidth || 1280;
        const h = video.videoHeight || 720;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) { finish(null); return; }
          // Frame dimensions are exactly the canvas — no second decode needed.
          finish({ blob, width: w, height: h });
        }, 'image/jpeg', 0.9);
      });

      // Begin playback (some browsers need an explicit play() after attach).
      video.play().catch(() => { /* autoplay attr usually covers this */ });
    });
  }

  /**
   * Last-resort web capture via a hidden <input type=file capture=environment>.
   * The browser opens its own camera UI and hands back a File.
   * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
   */
  function _captureFileInput() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute('capture', 'environment');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);

      let settled = false;
      function cleanup() {
        if (input.parentNode) input.parentNode.removeChild(input);
      }
      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) { finish(null); return; }
        try {
          const dims = await _measure(file);
          finish({ blob: file, width: dims.width, height: dims.height });
        } catch (e) {
          console.warn('[BuiltinCameraSource] could not measure file-input photo:', e);
          finish(null);
        }
      });

      // If the picker is dismissed there is no reliable 'cancel' event; the
      // flow's own cancel controls cover that case. Trigger the picker now.
      input.click();
    });
  }

  /**
   * Capture one photo from the device camera (native or web).
   * @returns {Promise<{blob:Blob, width:number, height:number}|null>}
   */
  async function capture() {
    if (_isNativeRuntime()) return _captureNative();
    return _captureWeb();
  }

  return { id, name, isAvailable, capture };
})();

/**
 * CaptureSources — registry of available CaptureSource implementations.
 * BuiltinCameraSource self-registers and is the default. Phase 5 registers an
 * Orbbec source with CaptureSources.register(orbbecSource).
 */
const CaptureSources = (() => {
  const _sources = new Map(); // id → CaptureSource

  function register(src) {
    if (!src || !src.id) {
      console.warn('[CaptureSources] register ignored — source has no id:', src);
      return;
    }
    _sources.set(src.id, src);
  }

  function get(id) {
    return _sources.get(id) || null;
  }

  function list() {
    return Array.from(_sources.values());
  }

  /**
   * Default capture source. Prefers the built-in camera; falls back to whatever
   * was registered first if the built-in was ever removed.
   */
  function defaultSource() {
    return _sources.get(BuiltinCameraSource.id) || list()[0] || null;
  }

  register(BuiltinCameraSource);

  return { register, get, list, default: defaultSource };
})();

window.BuiltinCameraSource = BuiltinCameraSource;
window.CaptureSources = CaptureSources;
