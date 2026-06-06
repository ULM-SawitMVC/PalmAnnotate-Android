'use strict';

/**
 * BBoxEditor — interactive canvas for editing bounding boxes on a single image.
 *
 * Usage:
 *   const editor = BBoxEditor.create(canvasEl, imageUrl, bboxes, onUpdate);
 *   editor.destroy();
 *   editor.syncBboxes(newBboxes);
 *
 * Interactions:
 *   Drag empty area   → draw new bbox (default class B2)
 *   Click bbox        → select
 *   Drag selected     → move
 *   Drag handle       → resize (8 handles: 4 corner + 4 edge)
 *   Delete/Backspace  → delete selected
 *   Keys 1/2/3/4      → change selected class to B1-B4
 *   Escape            → deselect
 */

const BBoxEditor = (() => {
  // Handle size in canvas pixels. Tablet field use benefits from larger visible
  // corners/edges; hit tolerance for touch remains wider below.
  const HANDLE_R = 10;
  const MIN_BBOX_PX = 4; // minimum bbox size in image pixels

  // Newly drawn bboxes start UNASSIGNED ('U' / -1) — the expert assigns a class
  // explicitly (no default-B2 bias). Falls back to literals for standalone tests.
  const NEW_CLASS_ID = (typeof UNASSIGNED_CLASS_ID !== 'undefined') ? UNASSIGNED_CLASS_ID : -1;
  const NEW_CLASS_NAME = (typeof UNASSIGNED_CLASS_NAME !== 'undefined') ? UNASSIGNED_CLASS_NAME : 'U';

  let _idSeq = 0;
  function _newId() { return 'nb' + (_idSeq++); }

  // ── Magnifier (module-level — persists across side switches) ──────────────

  const MAG_SIZE      = 230;  // match .dedup-magnifier CSS width/height
  const MAG_ZOOM_MIN  = 1.5;
  const MAG_ZOOM_MAX  = 8.0;
  const MAG_ZOOM_STEP = 0.3;
  let _magEnabled = false;
  let _magZoom    = 3.8;
  let _magEl = null, _magCanvas = null, _magCtx = null;
  let _boxesVisible = true;

  function _ensureMagEl() {
    if (_magEl) return;
    _magEl = document.createElement('div');
    _magEl.className = 'dedup-magnifier'; // reuse same CSS class
    _magCanvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    _magCanvas.width  = MAG_SIZE * dpr;
    _magCanvas.height = MAG_SIZE * dpr;
    _magCanvas.style.width  = MAG_SIZE + 'px';
    _magCanvas.style.height = MAG_SIZE + 'px';
    _magEl.appendChild(_magCanvas);
    document.body.appendChild(_magEl);
    _magCtx = _magCanvas.getContext('2d');
  }

  function _hideMag() {
    if (_magEl) _magEl.style.display = 'none';
  }

  // `e` may be a real event or a synthetic { clientX, clientY } point.
  // `opts.touch` lifts the loupe further above the point so a finger does not
  // occlude it during a touch drag.
  function _showMagAt(canvas, img, tr, bboxes, selectedId, e, opts) {
    if (!img || !tr) { _hideMag(); return; }
    _ensureMagEl();
    opts = opts || {};

    const dpr    = window.devicePixelRatio || 1;
    const rect   = canvas.getBoundingClientRect();
    const cssX   = e.clientX - rect.left;
    const cssY   = e.clientY - rect.top;

    const { x: imgX, y: imgY } = tr.canvasToImage(cssX * dpr, cssY * dpr);

    const halfW = (MAG_SIZE / 2) / _magZoom;
    const halfH = (MAG_SIZE / 2) / _magZoom;
    const srcX  = imgX - halfW, srcY = imgY - halfH;

    const ctx = _magCtx;
    ctx.clearRect(0, 0, _magCanvas.width, _magCanvas.height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, _magCanvas.width, _magCanvas.height);
    ctx.clip();

    // Zoomed image region
    ctx.drawImage(img, srcX, srcY, halfW * 2, halfH * 2,
                  0, 0, _magCanvas.width, _magCanvas.height);

    // Bboxes in magnified coords
    const magScale = _magZoom * dpr;
    bboxes.forEach((b, idx) => {
      const isSelected = b.id === selectedId;
      const color = CanvasRenderer.getClassColor(b.className);

      const mx1 = (b.x1 - srcX) * magScale;
      const my1 = (b.y1 - srcY) * magScale;
      const mx2 = (b.x2 - srcX) * magScale;
      const my2 = (b.y2 - srcY) * magScale;
      const mw = mx2 - mx1, mh = my2 - my1;

      if (isSelected) {
        ctx.fillStyle = color + '30';
        ctx.fillRect(mx1, my1, mw, mh);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 3 * dpr : 1.5 * dpr;
      ctx.strokeRect(mx1, my1, mw, mh);

      if (mw > 10) {
        const fs = Math.max(10, 11 * dpr);
        ctx.font = `bold ${fs}px sans-serif`;
        const lbl = `#${idx + 1} ${b.className}`;
        ctx.fillStyle = color;
        ctx.fillRect(mx1, Math.max(0, my1 - fs - 2), ctx.measureText(lbl).width + 4, fs + 2);
        ctx.fillStyle = '#fff';
        ctx.fillText(lbl, mx1 + 2, Math.max(fs, my1 - 2));
      }
    });

    // Crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const cx = _magCanvas.width / 2, cy = _magCanvas.height / 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0);    ctx.lineTo(cx, _magCanvas.height);
    ctx.moveTo(0, cy);    ctx.lineTo(_magCanvas.width, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Zoom badge
    const zoomTxt = _magZoom.toFixed(1) + '×';
    const fs = Math.round(11 * dpr);
    ctx.font = `bold ${fs}px monospace`;
    const tw = ctx.measureText(zoomTxt).width;
    const bx = _magCanvas.width  - tw - Math.round(6 * dpr);
    const by = _magCanvas.height - Math.round(4 * dpr);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx - 2, by - fs - 2, tw + 6, fs + 4);
    ctx.fillStyle = '#facc15';
    ctx.fillText(zoomTxt, bx, by);

    ctx.restore();

    // Position: above the point, flip near edge. On touch, centre horizontally
    // over the finger and lift higher so the finger does not occlude the loupe.
    const off = opts.touch ? 70 : 18;
    let left = opts.touch ? (e.clientX - MAG_SIZE / 2) : (e.clientX + off);
    let top  = e.clientY - MAG_SIZE - off;
    if (left + MAG_SIZE > window.innerWidth - 4) left = window.innerWidth - MAG_SIZE - 4;
    if (left < 4) left = 4;
    // If there is no room above (common when the finger is near the top), the
    // touch loupe still prefers above; clamp to viewport rather than dropping
    // below the finger where it would be hidden.
    if (top < 4) top = opts.touch ? 4 : (e.clientY + off);

    _magEl.style.display = 'block';
    _magEl.style.left    = left + 'px';
    _magEl.style.top     = top  + 'px';
  }

  // ── Coordinate transforms ─────────────────────────────────────────────────

  // `viewport` ({ zoom, panX, panY }) is layered ON TOP of the auto-fit base.
  // zoom === 1 and panX/panY === 0 reproduce the original fit behaviour exactly.
  // panX/panY are expressed in CSS pixels of the canvas display area.
  function _makeTransforms(canvas, imgW, imgH, viewport) {
    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth;
    const displayH = canvas.clientHeight;

    const vp    = viewport || { zoom: 1, panX: 0, panY: 0 };
    const zoom  = vp.zoom || 1;
    const panX  = vp.panX || 0;
    const panY  = vp.panY || 0;

    // Fit image into canvas, maintain aspect ratio — then apply zoom on top.
    const fitScale = Math.min(displayW / imgW, displayH / imgH);
    const scale = fitScale * zoom;
    // Centre at zoom=1, then offset by pan. The extra term keeps the zoom
    // anchored to the canvas centre so panX/panY stay intuitive.
    const offX = (displayW - imgW * scale) / 2 + panX;
    const offY = (displayH - imgH * scale) / 2 + panY;

    return {
      scale,
      canvasToImage(cx, cy) {
        return {
          x: (cx / dpr - offX) / scale,
          y: (cy / dpr - offY) / scale,
        };
      },
      imageToCanvas(ix, iy) {
        return {
          x: (ix * scale + offX) * dpr,
          y: (iy * scale + offY) * dpr,
        };
      },
      scaleToCanvas(v) { return v * scale * dpr; },
    };
  }

  // ── Handle hit testing ────────────────────────────────────────────────────

  function _getHandles(b, tr) {
    const mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
    return [
      { id: 'nw', ix: b.x1, iy: b.y1 },
      { id: 'n',  ix: mx,   iy: b.y1 },
      { id: 'ne', ix: b.x2, iy: b.y1 },
      { id: 'e',  ix: b.x2, iy: my   },
      { id: 'se', ix: b.x2, iy: b.y2 },
      { id: 's',  ix: mx,   iy: b.y2 },
      { id: 'sw', ix: b.x1, iy: b.y2 },
      { id: 'w',  ix: b.x1, iy: my   },
    ].map(h => {
      const c = tr.imageToCanvas(h.ix, h.iy);
      return { ...h, cx: c.x, cy: c.y };
    });
  }

  // `radiusCss` is the hit tolerance in CSS pixels (default mouse value).
  // Touch passes a larger value (~22px) so handles are tappable; the VISUAL
  // handle size (HANDLE_R) is unchanged.
  function _hitHandle(handles, cx, cy, radiusCss) {
    const dpr = window.devicePixelRatio || 1;
    const r = (radiusCss != null ? radiusCss : HANDLE_R * 2) * dpr;
    const r2 = r * r;
    for (const h of handles) {
      const dx = cx - h.cx, dy = cy - h.cy;
      if (dx * dx + dy * dy <= r2) return h;
    }
    return null;
  }

  function _hitBbox(bboxes, ix, iy) {
    // Last drawn = topmost, iterate reversed
    for (let i = bboxes.length - 1; i >= 0; i--) {
      const b = bboxes[i];
      if (ix >= b.x1 && ix <= b.x2 && iy >= b.y1 && iy <= b.y2) return b;
    }
    return null;
  }

  // ── Cursor per handle direction ────────────────────────────────────────────

  const HANDLE_CURSORS = {
    nw: 'nw-resize', ne: 'ne-resize', se: 'se-resize', sw: 'sw-resize',
    n: 'n-resize',   s: 's-resize',
    e: 'e-resize',   w: 'w-resize',
  };

  // ── Drawing ────────────────────────────────────────────────────────────────

  function _render(state) {
    const { canvas, ctx, image, bboxes, selectedId, hoveredId, tr } = state;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // The transform only exists once the image has loaded (see _rebuildTransforms).
    // A _resize() can fire before img.onload (e.g. a layout pass on tab switch),
    // which would otherwise throw on tr.* below and abort the render pipeline with
    // an uncaught TypeError. Bail early; img.onload will re-render with a valid tr.
    if (!tr) return;

    // Draw image
    if (image) {
      const tl = tr.imageToCanvas(0, 0);
      const br = tr.imageToCanvas(image.naturalWidth, image.naturalHeight);
      ctx.drawImage(image, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    }

    if (!_boxesVisible) return;

    // Box outline thickness. The canvas backing store is scaled by dpr, so the
    // floor is dpr-aware (a bare "3" reads as ~1.5 CSS px on a 2x tablet — too
    // faint over busy field photos). ~3.5 CSS px keeps boxes obvious.
    const lineW = Math.max(3.5 * dpr, tr.scaleToCanvas(3.5));

    bboxes.forEach((b, idx) => {
      const tl = tr.imageToCanvas(b.x1, b.y1);
      const br = tr.imageToCanvas(b.x2, b.y2);
      const w  = br.x - tl.x, h = br.y - tl.y;
      const color = CanvasRenderer.getClassColor(b.className);
      const isSelected = b.id === selectedId;
      const isHovered  = b.id === hoveredId;

      // Box fill (semi-transparent on hover/select)
      if (isSelected || isHovered) {
        ctx.fillStyle = color + '22';
        ctx.fillRect(tl.x, tl.y, w, h);
      }

      // Box stroke
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? lineW * 2 : lineW;
      ctx.strokeRect(tl.x, tl.y, w, h);

      // Label: "#index className"
      const label = `#${idx + 1} ${b.className}`;
      const fontSize = Math.max(15, tr.scaleToCanvas(15));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const tw = ctx.measureText(label).width;
      const pad = 3;
      const lx = tl.x, ly = tl.y - fontSize - pad;
      ctx.fillStyle = color;
      ctx.fillRect(lx, Math.max(0, ly), tw + pad * 2, fontSize + pad);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + pad, Math.max(fontSize, ly + fontSize));

      // Resize handles for selected
      if (isSelected) {
        const handles = _getHandles(b, tr);
        for (const h of handles) {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(h.cx, h.cy, HANDLE_R, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    });

    // Draw-in-progress rectangle
    if (state.dragState && state.dragState.mode === 'draw') {
      const d = state.dragState;
      const tl = tr.imageToCanvas(Math.min(d.ix0, d.ix1), Math.min(d.iy0, d.iy1));
      const br = tr.imageToCanvas(Math.max(d.ix0, d.ix1), Math.max(d.iy0, d.iy1));
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.setLineDash([]);
    }
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  function create(canvas, imageUrl, initialBboxes, onUpdate, onClassChange) {
    let bboxes = (initialBboxes || []).map(b => ({ ...b }));
    let selectedId = null;
    let hoveredId  = null;
    let image = null;
    let tr = null;
    let dragState = null;
    let destroyed = false;

    const dpr = window.devicePixelRatio || 1;

    // ── Viewport (pinch-zoom + pan), layered on top of the auto-fit base ──────
    const ZOOM_MIN = 1, ZOOM_MAX = 8;
    const viewport = { zoom: 1, panX: 0, panY: 0 };

    // Active pointers (pointerId -> { x, y } in client coords) — used to tell
    // single-pointer (draw/move/resize) apart from two-pointer (pinch/pan).
    const pointers = new Map();
    let gesture = null; // { startDist, startZoom, startCx, startCy } for 2-finger
    let _lastTapTime = 0; // for double-tap-to-reset

    function _rebuildTransforms() {
      if (image) tr = _makeTransforms(canvas, image.naturalWidth, image.naturalHeight, viewport);
    }

    function _resize() {
      canvas.width  = canvas.clientWidth  * dpr;
      canvas.height = canvas.clientHeight * dpr;
      _rebuildTransforms();
      _render(state);
    }

    const ctx = canvas.getContext('2d');

    const state = {
      get canvas() { return canvas; },
      get ctx() { return ctx; },
      get image() { return image; },
      get bboxes() { return bboxes; },
      get selectedId() { return selectedId; },
      get hoveredId() { return hoveredId; },
      get tr() { return tr; },
      get dragState() { return dragState; },
    };

    // Load image
    const img = new Image();
    img.onload = () => {
      image = img;
      canvas.width  = canvas.clientWidth  * dpr;
      canvas.height = canvas.clientHeight * dpr;
      tr = _makeTransforms(canvas, img.naturalWidth, img.naturalHeight, viewport);
      _render(state);
    };
    img.src = imageUrl;

    // ── Event Handlers ───────────────────────────────────────────────────────

    function _canvasCoords(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        cx: (e.clientX - rect.left) * dpr,
        cy: (e.clientY - rect.top)  * dpr,
      };
    }

    function _clampToImage(ix, iy) {
      return {
        ix: Math.max(0, Math.min(image.naturalWidth,  ix)),
        iy: Math.max(0, Math.min(image.naturalHeight, iy)),
      };
    }

    // Cache last hover/drag point for wheel re-render of the loupe
    let _lastMagE = null;

    // Single-pointer DOWN — draw / select / move / resize.
    // `isTouch` widens the handle hit tolerance for fingers.
    function _onSingleDown(e, isTouch) {
      if (!image || !tr) return;
      const { cx, cy } = _canvasCoords(e);
      const imgPt = tr.canvasToImage(cx, cy);
      const { ix, iy } = _clampToImage(imgPt.x, imgPt.y);
      const handleR = isTouch ? 22 : undefined;

      // Check handle first (only if something selected)
      if (selectedId) {
        const sel = bboxes.find(b => b.id === selectedId);
        if (sel) {
          const handles = _getHandles(sel, tr);
          const hit = _hitHandle(handles, cx, cy, handleR);
          if (hit) {
            dragState = { mode: 'resize', handleId: hit.id, bboxId: selectedId, ix0: ix, iy0: iy, orig: { ...sel } };
            return;
          }
        }
      }

      // Check bbox hit
      const hit = _hitBbox(bboxes, ix, iy);
      if (hit) {
        selectedId = hit.id;
        dragState = { mode: 'move', bboxId: hit.id, ix0: ix, iy0: iy, orig: { ...hit } };
        _render(state);
        return;
      }

      // Start drawing new bbox
      selectedId = null;
      dragState = { mode: 'draw', ix0: ix, iy0: iy, ix1: ix, iy1: iy };
      _render(state);
    }

    // Single-pointer MOVE — update drag, hover, and (on touch) drag loupe.
    function _onSingleMove(e, isTouch) {
      if (!image || !tr) return;
      const { cx, cy } = _canvasCoords(e);
      const imgPt = tr.canvasToImage(cx, cy);
      const { ix, iy } = _clampToImage(imgPt.x, imgPt.y);
      const handleR = isTouch ? 22 : undefined;

      // Loupe: mouse follows hover (no drag); touch follows the active drag,
      // lifted above the finger.
      if (_magEnabled) {
        if (!isTouch && !dragState) {
          _lastMagE = e;
          _showMagAt(canvas, image, tr, bboxes, selectedId, e);
        } else if (isTouch && dragState) {
          _lastMagE = e;
          _showMagAt(canvas, image, tr, bboxes, selectedId, e, { touch: true });
        }
      }

      if (dragState) {
        if (dragState.mode === 'draw') {
          dragState.ix1 = ix;
          dragState.iy1 = iy;
        } else if (dragState.mode === 'move') {
          const dx = ix - dragState.ix0, dy = iy - dragState.iy0;
          const o = dragState.orig;
          const w = o.x2 - o.x1, h = o.y2 - o.y1;
          let nx1 = o.x1 + dx, ny1 = o.y1 + dy;
          nx1 = Math.max(0, Math.min(image.naturalWidth  - w, nx1));
          ny1 = Math.max(0, Math.min(image.naturalHeight - h, ny1));
          const idx = bboxes.findIndex(b => b.id === dragState.bboxId);
          if (idx !== -1) {
            bboxes[idx] = { ...bboxes[idx], x1: nx1, y1: ny1, x2: nx1 + w, y2: ny1 + h };
          }
        } else if (dragState.mode === 'resize') {
          const idx = bboxes.findIndex(b => b.id === dragState.bboxId);
          if (idx !== -1) {
            const o = dragState.orig;
            let { x1, y1, x2, y2 } = o;
            const h = dragState.handleId;
            if (h.includes('w')) x1 = Math.min(ix, x2 - MIN_BBOX_PX);
            if (h.includes('e')) x2 = Math.max(ix, x1 + MIN_BBOX_PX);
            if (h.includes('n')) y1 = Math.min(iy, y2 - MIN_BBOX_PX);
            if (h.includes('s')) y2 = Math.max(iy, y1 + MIN_BBOX_PX);
            x1 = Math.max(0, x1); y1 = Math.max(0, y1);
            x2 = Math.min(image.naturalWidth, x2);
            y2 = Math.min(image.naturalHeight, y2);
            bboxes[idx] = { ...bboxes[idx], x1, y1, x2, y2 };
          }
        }
        _render(state);
        return;
      }

      // Hover detection (mouse only — touch has no hover state)
      if (isTouch) return;
      const prevHover = hoveredId;
      if (selectedId) {
        const sel = bboxes.find(b => b.id === selectedId);
        if (sel) {
          const handles = _getHandles(sel, tr);
          const hit = _hitHandle(handles, cx, cy, handleR);
          if (hit) { canvas.style.cursor = HANDLE_CURSORS[hit.id]; hoveredId = null; }
          else {
            const hb = _hitBbox(bboxes, ix, iy);
            hoveredId = hb ? hb.id : null;
            canvas.style.cursor = hb ? 'move' : 'crosshair';
          }
        }
      } else {
        const hb = _hitBbox(bboxes, ix, iy);
        hoveredId = hb ? hb.id : null;
        canvas.style.cursor = hb ? 'pointer' : 'crosshair';
      }
      if (hoveredId !== prevHover) _render(state);
    }

    // Single-pointer UP — commit the in-progress draw/move/resize.
    function _onSingleUp() {
      if (!image || !tr || !dragState) return;

      if (dragState.mode === 'draw') {
        const x1 = Math.min(dragState.ix0, dragState.ix1);
        const y1 = Math.min(dragState.iy0, dragState.iy1);
        const x2 = Math.max(dragState.ix0, dragState.ix1);
        const y2 = Math.max(dragState.iy0, dragState.iy1);
        if (x2 - x1 >= MIN_BBOX_PX && y2 - y1 >= MIN_BBOX_PX) {
          const newBbox = {
            id: _newId(),
            classId: NEW_CLASS_ID,
            className: NEW_CLASS_NAME,
            x1, y1, x2, y2,
          };
          bboxes.push(newBbox);
          selectedId = newBbox.id;
          onUpdate && onUpdate([...bboxes]);
        }
      } else if (dragState.mode === 'move' || dragState.mode === 'resize') {
        onUpdate && onUpdate([...bboxes]);
      }

      dragState = null;
      _render(state);
    }

    // ── Pointer dispatch (mouse + touch + pen via one path) ───────────────────

    function _clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }

    function _resetViewport() {
      viewport.zoom = 1; viewport.panX = 0; viewport.panY = 0;
      _rebuildTransforms();
      _render(state);
    }

    function _twoPointerArray() {
      return Array.from(pointers.values());
    }

    // Begin a pinch/pan gesture from the two currently-tracked pointers.
    function _beginGesture() {
      const [p0, p1] = _twoPointerArray();
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      gesture = {
        startDist: Math.hypot(dx, dy) || 1,
        startZoom: viewport.zoom,
        startPanX: viewport.panX,
        startPanY: viewport.panY,
        startCx: (p0.x + p1.x) / 2,
        startCy: (p0.y + p1.y) / 2,
      };
      // Abort any single-pointer draw/move/resize that was mid-flight.
      dragState = null;
      _hideMag();
    }

    // Update zoom (about the gesture centroid) + pan from centroid delta.
    function _updateGesture() {
      if (!gesture || !image) return;
      const [p0, p1] = _twoPointerArray();
      if (!p0 || !p1) return;
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy) || 1;
      const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;

      const rect = canvas.getBoundingClientRect();
      // Centroid in canvas-local CSS coords, relative to canvas centre.
      const anchorX = gesture.startCx - rect.left - canvas.clientWidth  / 2;
      const anchorY = gesture.startCy - rect.top  - canvas.clientHeight / 2;

      const newZoom = _clampZoom(gesture.startZoom * (dist / gesture.startDist));
      const ratio = newZoom / gesture.startZoom;

      // Keep the anchor point visually fixed while scaling, then add the pan
      // produced by the centroid sliding across the screen.
      viewport.zoom = newZoom;
      viewport.panX = gesture.startPanX - anchorX * (ratio - 1) + (cx - gesture.startCx);
      viewport.panY = gesture.startPanY - anchorY * (ratio - 1) + (cy - gesture.startCy);

      _rebuildTransforms();
      _render(state);
    }

    function _pointerIsTouch(e) { return e.pointerType === 'touch'; }

    function onPointerDown(e) {
      if (!image || !tr) return;
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        _beginGesture();
        return;
      }
      if (pointers.size > 2) return; // ignore 3rd+ finger

      // Double-tap (touch) to reset zoom/pan.
      if (_pointerIsTouch(e)) {
        const now = Date.now();
        if (now - _lastTapTime < 300 && viewport.zoom !== 1) {
          _lastTapTime = 0;
          _resetViewport();
          return;
        }
        _lastTapTime = now;
      }

      _onSingleDown(e, _pointerIsTouch(e));
    }

    function onPointerMove(e) {
      if (!image || !tr) return;
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (gesture && pointers.size >= 2) {
        e.preventDefault();
        _updateGesture();
        return;
      }
      if (pointers.size >= 2) return; // mid two-finger, suppress drawing

      _onSingleMove(e, _pointerIsTouch(e));
    }

    function _endPointer(e) {
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

      if (gesture) {
        // Leaving 2-pointer mode: end the gesture. If one finger remains it can
        // start a fresh single-pointer interaction on its next move/down.
        if (pointers.size < 2) gesture = null;
        if (_pointerIsTouch(e)) _hideMag();
        return;
      }

      _onSingleUp();
      if (_pointerIsTouch(e)) _hideMag();
    }

    function onPointerUp(e)     { e.preventDefault(); _endPointer(e); }
    function onPointerCancel(e) { _endPointer(e); }

    // Shared with the keyboard '1-4' path and the public setSelectedClass().
    // No-op if nothing selected or classId out of range. classId is 0-indexed.
    function _applyClass(classId) {
      if (!selectedId) return;
      if (classId < 0 || classId > 3) return;
      const idx = bboxes.findIndex(b => b.id === selectedId);
      if (idx === -1) return;
      bboxes[idx] = { ...bboxes[idx], classId, className: CLASS_MAP[classId] };
      onUpdate && onUpdate([...bboxes]);
      // Let the host propagate this class change to any confirmed-cluster siblings
      // on other sides (which this editor does not render).
      onClassChange && onClassChange(bboxes[idx].id, classId);
      _render(state);
    }

    // Shared with the keyboard Delete/Backspace path and the public deleteSelected().
    function _deleteSelected() {
      if (!selectedId) return;
      bboxes = bboxes.filter(b => b.id !== selectedId);
      selectedId = null;
      dragState = null;
      onUpdate && onUpdate([...bboxes]);
      _render(state);
    }

    function onKeyDown(e) {
      if (!selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        _deleteSelected();
      } else if (e.key === 'Escape') {
        selectedId = null;
        dragState = null;
        _render(state);
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        // Key 1→classId 0 (B1), 2→1 (B2), 3→2 (B3), 4→3 (B4) — dataset is 0-indexed
        _applyClass(parseInt(e.key, 10) - 1);
      }
    }

    function onMouseLeave() { _hideMag(); _lastMagE = null; }

    // Suppress the WebView long-press / right-click menu so it cannot hijack
    // touch gestures over the canvas.
    function onContextMenu(e) { e.preventDefault(); }

    function onWheel(e) {
      if (!_magEnabled || !_magEl || _magEl.style.display === 'none') return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -MAG_ZOOM_STEP : MAG_ZOOM_STEP;
      _magZoom = Math.min(MAG_ZOOM_MAX, Math.max(MAG_ZOOM_MIN,
                          parseFloat((_magZoom + delta).toFixed(1))));
      if (_lastMagE && image && tr) {
        _showMagAt(canvas, image, tr, bboxes, selectedId, _lastMagE);
      }
    }

    const _ro = new ResizeObserver(_resize);
    _ro.observe(canvas);

    // Pointer Events unify mouse + touch + pen. touchAction:'none' stops the
    // WebView from scrolling/zooming the page when we handle gestures ourselves.
    const _prevTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown',   onPointerDown);
    canvas.addEventListener('pointermove',   onPointerMove);
    canvas.addEventListener('pointerup',     onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('mouseleave',    onMouseLeave);
    canvas.addEventListener('contextmenu',   onContextMenu);
    canvas.addEventListener('wheel',         onWheel, { passive: false });
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', onKeyDown);

    // ── Public API ────────────────────────────────────────────────────────────

    function syncBboxes(newBboxes) {
      bboxes = (newBboxes || []).map(b => ({ ...b }));
      selectedId = null;
      dragState = null;
      // New content → drop any pinch-zoom/pan so it auto-fits like before.
      pointers.clear();
      gesture = null;
      viewport.zoom = 1; viewport.panX = 0; viewport.panY = 0;
      _rebuildTransforms();
      _render(state);
    }

    function getSelectedId() { return selectedId; }

    // ── Touch substitutes for the 1-4 / Delete keyboard shortcuts ─────────────
    // classId is 0-indexed (0=B1, 1=B2, 2=B3, 3=B4) — matches keyboard logic.
    function setSelectedClass(classId) { _applyClass(classId); }
    function deleteSelected()          { _deleteSelected(); }
    function setBoxesVisible(v) { _boxesVisible = !!v; _render(state); }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      _ro.disconnect();
      canvas.removeEventListener('pointerdown',   onPointerDown);
      canvas.removeEventListener('pointermove',   onPointerMove);
      canvas.removeEventListener('pointerup',     onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('mouseleave',    onMouseLeave);
      canvas.removeEventListener('contextmenu',   onContextMenu);
      canvas.removeEventListener('wheel',         onWheel);
      canvas.removeEventListener('keydown',       onKeyDown);
      canvas.style.touchAction = _prevTouchAction;
      _hideMag();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    return { syncBboxes, getSelectedId, destroy, setSelectedClass, deleteSelected, setBoxesVisible };
  }

  // Static helpers so app.js can read/set overlay state without an editor instance.
  function getMagnifierEnabled() { return _magEnabled; }
  function setMagnifierGlobal(v) { _magEnabled = !!v; if (!_magEnabled) _hideMag(); }
  function getBoxesVisible() { return _boxesVisible; }
  function setBoxesVisibleGlobal(v) { _boxesVisible = !!v; }

  return { create, getMagnifierEnabled, setMagnifierGlobal, getBoxesVisible, setBoxesVisibleGlobal };
})();

window.BBoxEditor = BBoxEditor;
