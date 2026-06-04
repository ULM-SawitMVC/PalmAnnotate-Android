'use strict';

/**
 * DepthViewer — inspect the raw uint16 depth planes (.raw) and their JSON
 * sidecars captured alongside RGB by the Orbbec USB camera.
 *
 * Opened from the annotate screen's "More" menu for the CURRENT tree. For each
 * side it:
 *   - reads the raw uint16 little-endian depth bytes back from storage (native
 *     file uri via the Capacitor adapter / convertFileSrc fetch),
 *   - colorizes them into a heatmap on a <canvas> (jet colormap, auto-ranged to
 *     the frame's valid-depth min/max),
 *   - reports the depth in millimetres under the tapped pixel (value * valueScale),
 *   - shows the per-side depth JSON + the tree metadata JSON.
 *
 * Sides captured with the built-in camera (no depth) show a clear "no depth"
 * state. The module never throws into the caller — failures degrade to a notice.
 *
 * Public API:
 *   DepthViewer.open(tree, opts?) -> void     // tree = DatasetManager.getTree()
 *
 * Pure helpers (_depthColor / _toUint16 / _range / _paintCanvas) are exported on
 * the module for unit testing.
 */
const DepthViewer = (() => {

  function _el(tag, className, text) {
    const doc = (typeof document !== 'undefined') ? document : null;
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Standard "jet" colormap: t in [0,1] → [r,g,b] 0..255. Matches the spirit of
  // the native preview colorizer so the live PiP and this viewer read alike.
  function _jet(t) {
    t = _clamp(t, 0, 1);
    const r = _clamp(1.5 - Math.abs(4 * t - 3), 0, 1);
    const g = _clamp(1.5 - Math.abs(4 * t - 2), 0, 1);
    const b = _clamp(1.5 - Math.abs(4 * t - 1), 0, 1);
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  /** Colour for a depth in mm; 0/invalid → black. */
  function _depthColor(mm, minMm, maxMm) {
    if (!(mm > 0)) return [0, 0, 0];
    const span = (maxMm - minMm) || 1;
    return _jet((mm - minMm) / span);
  }

  /** Decode raw little-endian uint16 bytes into a Uint16Array. */
  function _toUint16(bytes) {
    if (!bytes) return new Uint16Array(0);
    const n = bytes.length >> 1;
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    return out;
  }

  /** Auto-range over valid (nonzero) depths, returned in millimetres. */
  function _range(u16, scale) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < u16.length; i++) {
      const v = u16[i];
      if (v === 0) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min)) return { minMm: 0, maxMm: 1, valid: 0 };
    let valid = 0;
    for (let i = 0; i < u16.length; i++) if (u16[i] !== 0) valid++;
    return { minMm: min * scale, maxMm: Math.max(max * scale, min * scale + 1), valid };
  }

  /** Paint a colorized depth heatmap into `canvas` at native w×h. */
  function _paintCanvas(canvas, u16, w, h, minMm, maxMm, scale) {
    if (!canvas || !w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData ? ctx.createImageData(w, h) : ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const n = Math.min(u16.length, w * h);
    for (let i = 0; i < n; i++) {
      const mm = u16[i] * scale;
      const c = _depthColor(mm, minMm, maxMm);
      const o = i * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    if (ctx.putImageData) ctx.putImageData(img, 0, 0);
  }

  // ── Storage readback ────────────────────────────────────────────────────────

  function _adapter(opts) {
    if (opts && opts.adapter) return opts.adapter;
    return (window.Storage && Storage.active && Storage.active()) || null;
  }

  function _capacitor() {
    return (typeof window !== 'undefined' && window.Capacitor) || null;
  }

  /**
   * Read a side's raw depth bytes. Prefers the adapter's binary readback (handles
   * both native file uris and dataset-relative paths); falls back to a
   * convertFileSrc fetch when only a uri is known.
   * @returns {Promise<Uint8Array|null>}
   */
  async function _readDepthBytes(adapter, tree, side, i) {
    const relPath = `depth/field/${tree.name}_${i + 1}.raw`;
    if (adapter && typeof adapter.readDatasetBinary === 'function') {
      const bytes = await adapter.readDatasetBinary(side && side.depthUri ? side.depthUri : relPath);
      if (bytes && bytes.length) return bytes;
      // Try the conventional path if the uri readback came up empty.
      if (side && side.depthUri) {
        const byPath = await adapter.readDatasetBinary(relPath);
        if (byPath && byPath.length) return byPath;
      }
    }
    // Fetch fallback (WebView): convert the native uri to a fetchable URL.
    const cap = _capacitor();
    const uri = side && side.depthUri;
    if (cap && uri && typeof cap.convertFileSrc === 'function' && typeof fetch === 'function') {
      try {
        const res = await fetch(cap.convertFileSrc(uri));
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) { /* fall through to null */ }
    }
    return null;
  }

  /** Resolve a side's depth metadata (in-memory sidecar, else read from disk). */
  async function _readDepthMeta(adapter, tree, side, i) {
    if (side && side.depth && (side.depth.width || side.depth.valueScale)) return side.depth;
    if (adapter && typeof adapter.readDatasetJsonAt === 'function') {
      const json = await adapter.readDatasetJsonAt(`depth/field/${tree.name}_${i + 1}.json`);
      if (json) return json;
    }
    return side ? side.depth || null : null;
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  function open(tree, opts = {}) {
    if (!tree || !Array.isArray(tree.sides) || !tree.sides.length) {
      if (window.console) console.info('[DepthViewer] no tree/sides to inspect');
      return null;
    }
    const adapter = _adapter(opts);

    const overlay = _el('div', 'capture-overlay depth-viewer');
    const panel = _el('div', 'depth-viewer__panel');

    const header = _el('div', 'depth-viewer__header');
    header.appendChild(_el('h2', 'depth-viewer__title', `Depth & raw — ${tree.name}`));
    const closeBtn = _el('button', 'capture-btn capture-btn--ghost depth-viewer__close', 'Close');
    closeBtn.type = 'button';
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Side selector strip.
    const tabs = _el('div', 'depth-viewer__tabs');
    const tabBtns = [];
    for (let i = 0; i < tree.sides.length; i++) {
      const b = _el('button', 'depth-viewer__tab', `Side ${i + 1}`);
      b.type = 'button';
      b.dataset.side = String(i);
      b.addEventListener('click', () => _selectSide(i));
      tabs.appendChild(b);
      tabBtns.push(b);
    }
    panel.appendChild(tabs);

    const body = _el('div', 'depth-viewer__body');

    const stage = _el('div', 'depth-viewer__stage');
    const canvas = _el('canvas', 'depth-viewer__canvas');
    const notice = _el('div', 'depth-viewer__notice');
    stage.appendChild(canvas);
    stage.appendChild(notice);
    body.appendChild(stage);

    const aside = _el('div', 'depth-viewer__aside');
    const legend = _el('div', 'depth-viewer__legend');
    const readout = _el('div', 'depth-viewer__readout', 'Tap the heatmap to read depth (mm)');
    const jsonPre = _el('pre', 'depth-viewer__json');
    aside.appendChild(legend);
    aside.appendChild(readout);
    aside.appendChild(_el('div', 'depth-viewer__jsonlabel', 'JSON'));
    aside.appendChild(jsonPre);
    body.appendChild(aside);

    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function _teardown() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    closeBtn.addEventListener('click', _teardown);

    // Per-side render state for the pixel readout.
    let cur = { u16: null, w: 0, h: 0, scale: 1, unit: 'mm' };

    canvas.addEventListener('click', (ev) => {
      if (!cur.u16 || !cur.w || !cur.h) return;
      const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: cur.w, height: cur.h };
      const offX = (ev.clientX != null ? ev.clientX : 0) - rect.left;
      const offY = (ev.clientY != null ? ev.clientY : 0) - rect.top;
      const px = _clamp(Math.floor(offX / (rect.width || cur.w) * cur.w), 0, cur.w - 1);
      const py = _clamp(Math.floor(offY / (rect.height || cur.h) * cur.h), 0, cur.h - 1);
      const raw = cur.u16[py * cur.w + px] || 0;
      const mm = raw * cur.scale;
      readout.textContent = raw > 0
        ? `px(${px}, ${py}) = ${Math.round(mm)} ${cur.unit} (raw ${raw})`
        : `px(${px}, ${py}) = no reading (0)`;
    });

    async function _selectSide(i) {
      for (const b of tabBtns) b.classList.toggle('depth-viewer__tab--active', Number(b.dataset.side) === i);
      const side = tree.sides[i];
      notice.classList.remove('depth-viewer__notice--show');
      notice.textContent = '';
      readout.textContent = 'Tap the heatmap to read depth (mm)';
      legend.textContent = '';
      jsonPre.textContent = '';
      cur = { u16: null, w: 0, h: 0, scale: 1, unit: 'mm' };

      const meta = await _readDepthMeta(adapter, tree, side, i);
      const treeJson = (tree.metadata && JSON.stringify(tree.metadata, null, 2)) || '{}';
      const depthJson = meta ? JSON.stringify(meta, null, 2) : null;
      jsonPre.textContent = (depthJson ? `// ${tree.name}_${i + 1}.json\n${depthJson}\n\n` : '') +
                            `// metadata/${tree.name}.json\n${treeJson}`;

      if (!meta || !meta.width || !meta.height) {
        notice.textContent = 'No depth captured for this side (built-in camera, or depth unavailable).';
        notice.classList.add('depth-viewer__notice--show');
        return;
      }

      notice.textContent = 'Loading depth…';
      notice.classList.add('depth-viewer__notice--show');
      const bytes = await _readDepthBytes(adapter, tree, side, i);
      if (!bytes || !bytes.length) {
        notice.textContent = 'Depth file could not be read back from storage.';
        return;
      }
      const w = meta.width, h = meta.height;
      const scale = Number(meta.valueScale || 1) || 1;
      const unit = meta.unit || 'mm';
      const u16 = _toUint16(bytes);
      const { minMm, maxMm, valid } = _range(u16, scale);
      _paintCanvas(canvas, u16, w, h, minMm, maxMm, scale);
      cur = { u16, w, h, scale, unit };
      notice.classList.remove('depth-viewer__notice--show');
      legend.textContent = `Range ${Math.round(minMm)}–${Math.round(maxMm)} ${unit} · ${valid.toLocaleString()} valid px · ${w}×${h}`;
    }

    _selectSide(0);
    return { close: _teardown, _selectSide };
  }

  return { open, _depthColor, _toUint16, _range, _paintCanvas, _jet };
})();

if (typeof window !== 'undefined') window.DepthViewer = DepthViewer;
