'use strict';

/**
 * CarouselUI — touch-first, one-side-at-a-time annotation surface.
 *
 * This is the finger-first equivalent of the desktop two-canvas DedupUI: the
 * expert/operator swipes left/right around a tree (carousel) to assign a class
 * to each bunch AND cross-link the same bunch across adjacent sides.
 *
 * It shows ONE side at a time, full-bleed (image + boxes). A horizontal swipe
 * rotates to the prev/next side, wrapping around the tree using sideIndex±1 mod
 * n (the same ordering ADJACENT_PAIRS walks). The gesture conflict between the
 * horizontal swipe and the in-canvas pan/draw is resolved by two explicit modes:
 *
 *   REVIEW (default) — swipe changes side; TAP a box selects it; a bottom class
 *     bar sets the selected box's class; the canvas never pans/draws so swipe is
 *     unambiguous. Lightweight rendering via CanvasRenderer.
 *
 *   EDIT — a BBoxEditor is mounted on the current side's canvas for precise
 *     draw/move/resize/pinch-zoom. The editor owns ALL gestures, so swipe is
 *     disabled; prev/next-side buttons remain for navigation.
 *
 * Cross-linking ("Link"): arm link mode with the selected box as source, swipe
 * to an ADJACENT side, tap a target box → ActiveSession.addManualLink (oriented
 * to the adjacent pair). Linked boxes share a colored accent ring + a link-id
 * badge computed from confirmedLinks / getClusterMembers.
 *
 * Public API (see window.CarouselUI at the bottom):
 *   init(containerEl)   build DOM for the CURRENT session; safe to call repeatedly
 *   show()              (re)render / resume; call when the tab becomes visible
 *   refresh()           re-read ActiveSession and redraw boxes/links
 *   goToSide(i)
 *   destroy()           tear down editor + listeners
 *
 * No-ops gracefully when ActiveSession.get() is null.
 */

const CarouselUI = (() => {
  // Horizontal travel (px) required to commit a swipe to prev/next side.
  const SWIPE_THRESHOLD = 60;
  // Above this vertical/horizontal ratio the gesture is treated as a vertical
  // scroll/tap and never becomes a swipe.
  const SWIPE_DOMINANCE = 1.2;
  // Tap tolerance — pointer travel under this (px) is a tap, not a drag.
  const TAP_SLOP = 10;

  const MODE_REVIEW = 'review';
  const MODE_EDIT   = 'edit';

  // Link-badge palette (cyclic) — mirrors DedupUI's link coloring intent.
  const LINK_COLORS = [
    '#22c55e', '#3b82f6', '#f59e0b', '#ec4899',
    '#06b6d4', '#a855f7', '#ef4444', '#84cc16',
  ];

  // ── Instance state ──────────────────────────────────────────────────────────
  let _root = null;        // container element passed to init()
  let _stage = null;       // viewport that clips the sliding track
  let _track = null;       // translateX-animated slide container
  let _canvas = null;      // single review/edit canvas (current side)
  let _classBar = null;    // B1-B4 chips + delete + link actions
  let _dotsEl = null;      // bottom segment indicator
  let _thumbsEl = null;    // thumbnail strip
  let _hintEl = null;      // transient hint banner
  let _linksListEl = null; // confirmed-links list (current side)
  let _modeReviewBtn = null, _modeEditBtn = null;
  let _selInfoEl = null;   // selected-bbox readout

  // Host hooks for the single-screen annotate shell (Home / browse / More in the
  // topbar; Detect again / Next tree / Save & exit in the bottom action row).
  // Empty when init() is called without opts (web/desktop, unit tests) — the
  // hook-driven chrome simply isn't rendered then.
  let _hooks = {};
  let _treeLabelEl = null;  // compact tree-name label in the topbar
  let _actionRowEl = null;  // bottom action row (Detect / Next tree / Save & exit)

  let _mode = MODE_REVIEW;
  let _sideIndex = 0;
  let _selectedId = null;  // selected bbox id (REVIEW mode)
  let _boxesVisible = true;
  let _editor = null;      // BBoxEditor instance (EDIT mode)

  // Link-mode arming: source endpoint waiting for a target on an adjacent side.
  // { sideIndex, bboxId } | null
  let _linkSource = null;

  // Stable color per linkId for badge/ring rendering.
  const _linkColorMap = new Map();
  let _colorSeq = 0;

  // Cached image elements per side (lazy) for fast review re-render.
  const _imgCache = new Map(); // sideIndex -> HTMLImageElement | null

  // Proactively release decoded image memory when leaving a tree. The cache only
  // ever holds the CURRENT tree's sides (<=8), but at field scale (250 trees /
  // 1000 photos) navigating tree-to-tree must not leave decoded bitmaps pinned —
  // detach handlers + drop src so the WebView can free them immediately instead
  // of waiting for GC, then clear the map.
  function _releaseImgCache() {
    for (const img of _imgCache.values()) {
      if (img) { img.onload = null; img.onerror = null; try { img.src = ''; } catch (_) {} }
    }
    _imgCache.clear();
  }

  // Current REVIEW transform (image→canvas) for hit-testing taps.
  let _reviewTr = null;

  // Pointer/swipe tracking on the stage.
  let _ptr = null; // { id, x0, y0, lastX, dx, dy, decided, isSwipe }
  let _hintTimer = null;
  let _destroyed = false;

  // ── Small helpers ───────────────────────────────────────────────────────────

  function _session() {
    return (window.ActiveSession && ActiveSession.get && ActiveSession.get()) || null;
  }

  function _sideCount() {
    const s = _session();
    return s ? s.sides.length : 0;
  }

  function _adjacentPairs() {
    return window.ADJACENT_PAIRS || [];
  }

  function _sideLabel(i) {
    const labels = window.TREE_SIDE_LABELS || [];
    return labels[i] || ('Side ' + (i + 1));
  }

  // Resolve a side's image URL platform-agnostically: prefer side.imageUrl
  // (web blob), else derive from the dataset tree via DatasetManager.
  function _imageUrlForSide(side) {
    if (!side) return null;
    if (side.imageUrl) return side.imageUrl;
    if (window.DatasetManager) {
      const dTree = DatasetManager.getTree && DatasetManager.getTree();
      const dSide = dTree && dTree.sides ? dTree.sides[side.sideIndex] : null;
      if (dSide && DatasetManager.imageUrlForSide) return DatasetManager.imageUrlForSide(dSide);
    }
    return null;
  }

  function _isAdjacent(a, b) {
    return _adjacentPairs().some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  function _colorForLink(linkId) {
    if (!_linkColorMap.has(linkId)) {
      _linkColorMap.set(linkId, LINK_COLORS[(_colorSeq++) % LINK_COLORS.length]);
    }
    return _linkColorMap.get(linkId);
  }

  // Map of bboxId → { color, num } for the current side, from confirmed links.
  // `num` is a stable 1-based index across the whole session's confirmed links
  // so the same cluster shows the same number on every side.
  function _linkDecorForSide(sideIndex) {
    const s = _session();
    const map = new Map();
    if (!s) return map;
    s.confirmedLinks.forEach((link, i) => {
      const color = _colorForLink(link.linkId);
      const num = i + 1;
      if (link.sideA === sideIndex) map.set(link.bboxIdA, { color, num, linkId: link.linkId });
      if (link.sideB === sideIndex) map.set(link.bboxIdB, { color, num, linkId: link.linkId });
    });
    return map;
  }

  // ── Hint banner ─────────────────────────────────────────────────────────────

  function _showHint(text, ms) {
    if (!_hintEl) return;
    _hintEl.textContent = text;
    _hintEl.classList.add('crsl-hint--show');
    if (_hintTimer) clearTimeout(_hintTimer);
    _hintTimer = setTimeout(() => {
      if (_hintEl) _hintEl.classList.remove('crsl-hint--show');
    }, ms || 2200);
  }

  // ── DOM construction ────────────────────────────────────────────────────────

  function _buildDom(container) {
    container.innerHTML = '';
    container.classList.add('carousel-root');

    // Top bar: mode segmented control + side label.
    const top = document.createElement('div');
    top.className = 'carousel-topbar';

    const seg = document.createElement('div');
    seg.className = 'crsl-seg';
    _modeReviewBtn = document.createElement('button');
    _modeReviewBtn.className = 'crsl-seg__btn crsl-seg__btn--active';
    _modeReviewBtn.type = 'button';
    _modeReviewBtn.textContent = 'Review';
    _modeReviewBtn.addEventListener('click', () => _setMode(MODE_REVIEW));
    _modeEditBtn = document.createElement('button');
    _modeEditBtn.className = 'crsl-seg__btn';
    _modeEditBtn.type = 'button';
    _modeEditBtn.textContent = 'Edit';
    _modeEditBtn.addEventListener('click', () => _setMode(MODE_EDIT));
    seg.append(_modeReviewBtn, _modeEditBtn);

    _selInfoEl = document.createElement('div');
    _selInfoEl.className = 'crsl-sidelabel';

    // Compact tree-nav (Home + browse prev/next + tree label) and a "More"
    // toggle — only when the host wires hooks. This lets the carousel stand on
    // its own as the single annotate screen on native without the desktop header.
    const nav = _buildTopNav();
    const moreBtn = _hooks.onMore
      ? _crslBtn('crsl-topbtn crsl-topbtn--more', 'More', () => _hooks.onMore())
      : null;
    if (nav) top.appendChild(nav);
    top.appendChild(seg);
    top.appendChild(_selInfoEl);
    if (moreBtn) top.appendChild(moreBtn);

    // Stage: clips the sliding track; hosts the swipe gesture surface.
    _stage = document.createElement('div');
    _stage.className = 'carousel-stage';

    _track = document.createElement('div');
    _track.className = 'carousel-track';

    const slide = document.createElement('div');
    slide.className = 'carousel-slide';
    _canvas = document.createElement('canvas');
    _canvas.className = 'carousel-canvas';
    slide.appendChild(_canvas);
    _track.appendChild(slide);
    _stage.appendChild(_track);

    // Edge tap zones (jump prev/next without a full swipe).
    const edgeL = document.createElement('button');
    edgeL.className = 'crsl-edge crsl-edge--left';
    edgeL.type = 'button';
    edgeL.setAttribute('aria-label', 'Previous side');
    edgeL.innerHTML = '<span>‹</span>';
    edgeL.addEventListener('click', () => _go(-1));
    const edgeR = document.createElement('button');
    edgeR.className = 'crsl-edge crsl-edge--right';
    edgeR.type = 'button';
    edgeR.setAttribute('aria-label', 'Next side');
    edgeR.innerHTML = '<span>›</span>';
    edgeR.addEventListener('click', () => _go(1));
    _stage.append(edgeL, edgeR);

    // Transient hint banner.
    _hintEl = document.createElement('div');
    _hintEl.className = 'crsl-hint';
    _stage.appendChild(_hintEl);

    // Bottom: dots indicator, thumbnail strip, class bar, links list.
    const bottom = document.createElement('div');
    bottom.className = 'carousel-bottom';

    _dotsEl = document.createElement('div');
    _dotsEl.className = 'crsl-dots';

    _thumbsEl = document.createElement('div');
    _thumbsEl.className = 'crsl-thumbs';

    _classBar = document.createElement('div');
    _classBar.className = 'crsl-classbar';
    _buildClassBar();

    _linksListEl = document.createElement('div');
    _linksListEl.className = 'crsl-links';

    bottom.append(_dotsEl, _thumbsEl, _classBar, _linksListEl);

    // Bottom action row: Detect again / Save & exit / Next tree (host hooks).
    _actionRowEl = _buildActionRow();
    if (_actionRowEl) bottom.appendChild(_actionRowEl);

    container.append(top, _stage, bottom);

    // Swipe gestures live on the stage (REVIEW mode only; EDIT defers to editor).
    _stage.addEventListener('pointerdown', _onStageDown);
    _stage.addEventListener('pointermove', _onStageMove);
    _stage.addEventListener('pointerup', _onStageUp);
    _stage.addEventListener('pointercancel', _onStageCancel);
  }

  // ── Host-hook chrome (compact topbar nav + bottom action row) ───────────────

  function _crslBtn(className, label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function _resolveTreeLabel() {
    const t = _hooks.treeLabel;
    if (typeof t === 'function') { try { return t() || ''; } catch (_) { return ''; } }
    return t || '';
  }

  function _buildTopNav() {
    if (!(_hooks.onHome || _hooks.onBrowsePrev || _hooks.onBrowseNext || _hooks.treeLabel)) {
      return null;
    }
    const nav = document.createElement('div');
    nav.className = 'crsl-topnav';
    if (_hooks.onHome) {
      nav.appendChild(_crslBtn('crsl-topbtn crsl-topbtn--home', '⌂', () => _hooks.onHome()));
    }
    if (_hooks.onBrowsePrev) {
      nav.appendChild(_crslBtn('crsl-topbtn', '‹', () => _hooks.onBrowsePrev()));
    }
    _treeLabelEl = document.createElement('span');
    _treeLabelEl.className = 'crsl-treelabel';
    _treeLabelEl.textContent = _resolveTreeLabel();
    nav.appendChild(_treeLabelEl);
    if (_hooks.onBrowseNext) {
      nav.appendChild(_crslBtn('crsl-topbtn', '›', () => _hooks.onBrowseNext()));
    }
    return nav;
  }

  function _buildActionRow() {
    if (!(_hooks.onDetect || _hooks.onNextTree || _hooks.onSaveExit)) return null;
    const row = document.createElement('div');
    row.className = 'crsl-actionrow';
    if (_hooks.onDetect) {
      row.appendChild(_crslBtn('crsl-action crsl-action--detect', 'Detect again', () => _hooks.onDetect()));
    }
    const spacer = document.createElement('span');
    spacer.className = 'crsl-classbar__spacer';
    row.appendChild(spacer);
    if (_hooks.onSaveExit) {
      row.appendChild(_crslBtn('crsl-action crsl-action--save', 'Save & exit', () => _hooks.onSaveExit()));
    }
    if (_hooks.onNextTree) {
      row.appendChild(_crslBtn('crsl-action crsl-action--next', 'Next tree', () => _hooks.onNextTree()));
    }
    return row;
  }

  function _buildClassBar() {
    _classBar.innerHTML = '';

    // B1-B4 class chips, colored to match CanvasRenderer.
    const map = (typeof CLASS_MAP !== 'undefined') ? CLASS_MAP : { 0: 'B1', 1: 'B2', 2: 'B3', 3: 'B4' };
    for (let classId = 0; classId <= 3; classId++) {
      const name = map[classId] || ('C' + classId);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'crsl-chip';
      chip.dataset.class = String(classId);
      chip.textContent = name;
      const color = CanvasRenderer.getClassColor(name);
      chip.style.setProperty('--chip-color', color);
      chip.addEventListener('click', () => _applyClass(classId));
      _classBar.appendChild(chip);
    }

    const spacer = document.createElement('span');
    spacer.className = 'crsl-classbar__spacer';
    _classBar.appendChild(spacer);

    // Overlay toggle — lets the operator inspect the RGB image without boxes.
    const boxesBtn = document.createElement('button');
    boxesBtn.type = 'button';
    boxesBtn.className = 'crsl-action crsl-action--boxes crsl-action--active';
    boxesBtn.dataset.role = 'boxes';
    boxesBtn.textContent = 'Boxes';
    boxesBtn.addEventListener('click', () => {
      _boxesVisible = !_boxesVisible;
      if (_editor && _editor.setBoxesVisible) _editor.setBoxesVisible(_boxesVisible);
      _renderSide();
      _renderClassBar();
    });
    _classBar.appendChild(boxesBtn);

    // Link action — arms link mode with the selected box as source.
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'crsl-action crsl-action--link';
    linkBtn.dataset.role = 'link';
    linkBtn.textContent = 'Link';
    linkBtn.addEventListener('click', _armOrCancelLink);
    _classBar.appendChild(linkBtn);

    // Delete action — removes the selected box.
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'crsl-action crsl-action--del';
    delBtn.dataset.role = 'delete';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', _deleteSelected);
    _classBar.appendChild(delBtn);
  }

  // ── Mode switching ──────────────────────────────────────────────────────────

  function _setMode(mode) {
    if (mode === _mode) return;
    _mode = mode;
    _modeReviewBtn.classList.toggle('crsl-seg__btn--active', mode === MODE_REVIEW);
    _modeEditBtn.classList.toggle('crsl-seg__btn--active', mode === MODE_EDIT);
    _root.classList.toggle('carousel-root--edit', mode === MODE_EDIT);

    // Leaving link-arming when switching modes avoids a dangling source.
    _linkSource = null;

    if (mode === MODE_EDIT) {
      _destroyEditor();
      _mountEditor();
    } else {
      _destroyEditor();
      _renderSide();
    }
    _renderClassBar();
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  // Step the carousel by `dir` (+1 next, -1 prev), wrapping around the tree.
  function _go(dir) {
    const n = _sideCount();
    if (n === 0) return;
    const next = ((_sideIndex + dir) % n + n) % n;
    _animateTo(next, dir);
  }

  function _animateTo(targetIndex, dir) {
    const n = _sideCount();
    if (n === 0 || targetIndex === _sideIndex) { goToSide(targetIndex); return; }

    // Slide the track out, swap content at the midpoint, slide in from the
    // opposite edge. Deterministic (no momentum) translateX with snap.
    const outClass = dir > 0 ? 'carousel-track--out-left' : 'carousel-track--out-right';
    _track.classList.add(outClass);
    setTimeout(() => {
      goToSide(targetIndex);
      _track.classList.remove(outClass);
      const inClass = dir > 0 ? 'carousel-track--in-right' : 'carousel-track--in-left';
      _track.classList.add(inClass);
      // Next frame: remove the start offset so it transitions to rest.
      requestAnimationFrame(() => {
        _track.classList.remove(inClass);
      });
    }, 140);
  }

  // ── Image loading / caching ─────────────────────────────────────────────────

  function _getImage(sideIndex, onReady) {
    if (_imgCache.has(sideIndex)) {
      const cached = _imgCache.get(sideIndex);
      if (cached) onReady(cached);
      return;
    }
    const s = _session();
    const side = s && s.sides[sideIndex];
    const url = _imageUrlForSide(side);
    if (!url) { _imgCache.set(sideIndex, null); return; }
    const img = new Image();
    img.onload = () => { _imgCache.set(sideIndex, img); if (!_destroyed) onReady(img); };
    img.onerror = () => { _imgCache.set(sideIndex, null); };
    img.src = url;
  }

  // ── REVIEW rendering (lightweight image + boxes via CanvasRenderer) ──────────

  function _makeReviewTransform(canvas, imgW, imgH) {
    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth || 1;
    const displayH = canvas.clientHeight || 1;
    const scale = Math.min(displayW / imgW, displayH / imgH);
    const offX = (displayW - imgW * scale) / 2;
    const offY = (displayH - imgH * scale) / 2;
    return {
      scale, offX, offY, dpr,
      imageToCanvas(ix, iy) { return { x: (ix * scale + offX) * dpr, y: (iy * scale + offY) * dpr }; },
      canvasToImage(cx, cy) { return { x: (cx / dpr - offX) / scale, y: (cy / dpr - offY) / scale }; },
      scaleToCanvas(v) { return v * scale * dpr; },
    };
  }

  function _renderSide() {
    if (_mode === MODE_EDIT) return; // editor owns the canvas
    const s = _session();
    if (!s) { _clearCanvas(); return; }
    const side = s.sides[_sideIndex];
    if (!side) { _clearCanvas(); return; }

    _getImage(_sideIndex, (img) => {
      if (_mode === MODE_EDIT) return;
      _drawReview(img, side);
    });
    // If image already cached, draw immediately handled inside _getImage.
    if (_imgCache.get(_sideIndex) === null) _clearCanvas('Image unavailable');
  }

  function _clearCanvas(message) {
    const dpr = window.devicePixelRatio || 1;
    _canvas.width = (_canvas.clientWidth || 1) * dpr;
    _canvas.height = (_canvas.clientHeight || 1) * dpr;
    const ctx = _canvas.getContext('2d');
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    if (message) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = `${14 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(message, _canvas.width / 2, _canvas.height / 2);
      ctx.textAlign = 'left';
    }
    _reviewTr = null;
  }

  function _drawReview(img, side) {
    const dpr = window.devicePixelRatio || 1;
    _canvas.width = (_canvas.clientWidth || 1) * dpr;
    _canvas.height = (_canvas.clientHeight || 1) * dpr;
    const ctx = _canvas.getContext('2d');
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    const tr = _makeReviewTransform(_canvas, img.naturalWidth, img.naturalHeight);
    _reviewTr = tr;

    const tl = tr.imageToCanvas(0, 0);
    const br = tr.imageToCanvas(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    if (!_boxesVisible) return;

    const decor = _linkDecorForSide(side.sideIndex);
    // dpr-aware floor: a bare "3" is ~1.5 CSS px on a 2x tablet, too faint over
    // busy field photos. ~3.5 CSS px keeps boxes obvious. (matches bbox-editor.)
    const lineW = Math.max(3.5 * dpr, tr.scaleToCanvas(3.5));

    side.bboxes.forEach((b, idx) => {
      const btl = tr.imageToCanvas(b.x1, b.y1);
      const bbr = tr.imageToCanvas(b.x2, b.y2);
      const bw = bbr.x - btl.x, bh = bbr.y - btl.y;
      const classColor = CanvasRenderer.getClassColor(b.className);
      const isSelected = b.id === _selectedId;
      const isLinkSource = _linkSource && _linkSource.sideIndex === side.sideIndex && _linkSource.bboxId === b.id;
      const link = decor.get(b.id);

      // Box fill on select / source.
      if (isSelected || isLinkSource) {
        ctx.fillStyle = classColor + '33';
        ctx.fillRect(btl.x, btl.y, bw, bh);
      }

      // Class-colored stroke.
      ctx.strokeStyle = classColor;
      ctx.lineWidth = isSelected ? lineW * 2.4 : lineW;
      ctx.strokeRect(btl.x, btl.y, bw, bh);

      // Linked boxes share a colored accent ring + badge.
      if (link) {
        ctx.strokeStyle = link.color;
        ctx.lineWidth = Math.max(2, lineW * 1.6);
        ctx.setLineDash([7 * dpr, 4 * dpr]);
        ctx.strokeRect(btl.x - 3, btl.y - 3, bw + 6, bh + 6);
        ctx.setLineDash([]);
        // Link badge (top-right corner) — tappable to remove the link.
        const r = Math.max(11, 11 * dpr);
        const bx = bbr.x - r, by = btl.y + r;
        ctx.fillStyle = link.color;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(10, 11 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(link.num), bx, by);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }

      // Link-source glow ring (white).
      if (isLinkSource) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2, lineW * 2);
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.strokeRect(btl.x - 6, btl.y - 6, bw + 12, bh + 12);
        ctx.setLineDash([]);
      }

      // Label: "#index className".
      const label = `#${idx + 1} ${b.className}`;
      const fontSize = Math.max(15, tr.scaleToCanvas(15));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const tw = ctx.measureText(label).width;
      const pad = 3;
      ctx.fillStyle = classColor;
      ctx.fillRect(btl.x, Math.max(0, btl.y - fontSize - pad), tw + pad * 2, fontSize + pad);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, btl.x + pad, Math.max(fontSize, btl.y - 2));
    });
  }

  // Hit-test a tap (client coords) against the current side's boxes.
  // Returns the bbox object or null. Checks link badges first (for removal).
  function _hitTestReview(clientX, clientY) {
    if (!_boxesVisible || !_reviewTr) return { type: 'none' };
    const s = _session();
    const side = s && s.sides[_sideIndex];
    if (!side) return { type: 'none' };
    const rect = _canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = (clientX - rect.left) * dpr;
    const cy = (clientY - rect.top) * dpr;
    const tr = _reviewTr;
    const decor = _linkDecorForSide(side.sideIndex);

    // Link badges first (topmost). Tapping a badge removes that link.
    for (let i = side.bboxes.length - 1; i >= 0; i--) {
      const b = side.bboxes[i];
      const link = decor.get(b.id);
      if (!link) continue;
      const bbr = tr.imageToCanvas(b.x2, b.y2);
      const btl = tr.imageToCanvas(b.x1, b.y1);
      const r = Math.max(11, 11 * dpr);
      const bx = bbr.x - r, by = btl.y + r;
      const ddx = cx - bx, ddy = cy - by;
      if (ddx * ddx + ddy * ddy <= (r + 4 * dpr) * (r + 4 * dpr)) {
        return { type: 'badge', bbox: b, linkId: link.linkId };
      }
    }

    // Box body (last drawn = topmost).
    const pt = tr.canvasToImage(cx, cy);
    for (let i = side.bboxes.length - 1; i >= 0; i--) {
      const b = side.bboxes[i];
      if (pt.x >= b.x1 && pt.x <= b.x2 && pt.y >= b.y1 && pt.y <= b.y2) {
        return { type: 'box', bbox: b };
      }
    }
    return { type: 'none' };
  }

  // ── REVIEW tap handling (select / link target / badge removal) ──────────────

  function _onReviewTap(clientX, clientY) {
    const hit = _hitTestReview(clientX, clientY);

    if (hit.type === 'badge') {
      // Tap a link badge → remove that confirmed link.
      ActiveSession.removeConfirmedLink(hit.linkId);
      _showHint('Link removed');
      refresh();
      return;
    }

    if (hit.type === 'box') {
      if (_linkSource) {
        _completeLink(hit.bbox);
        return;
      }
      _selectedId = hit.bbox.id;
    } else {
      // Tap empty space clears selection (and any armed link source).
      _selectedId = null;
      if (_linkSource) { _linkSource = null; _showHint('Link cancelled'); }
    }
    _renderSide();
    _renderClassBar();
  }

  // ── Class / delete / link actions ───────────────────────────────────────────

  function _applyClass(classId) {
    if (_mode === MODE_EDIT) {
      if (_editor) _editor.setSelectedClass(classId);
      return;
    }
    if (!_selectedId) { _showHint('Tap a box first'); return; }
    // propagate=true so linked siblings on adjacent sides stay class-consistent.
    ActiveSession.setBboxClass(_sideIndex, _selectedId, classId, { propagate: true });
    refresh();
  }

  function _deleteSelected() {
    if (_mode === MODE_EDIT) {
      if (_editor) _editor.deleteSelected();
      return;
    }
    if (!_selectedId) { _showHint('Tap a box first'); return; }
    ActiveSession.removeBbox(_sideIndex, _selectedId);
    _selectedId = null;
    if (_linkSource && _linkSource.sideIndex === _sideIndex) _linkSource = null;
    refresh();
  }

  function _armOrCancelLink() {
    if (_mode === MODE_EDIT) {
      _showHint('Switch to Review to link');
      return;
    }
    if (_linkSource) {
      _linkSource = null;
      _showHint('Link cancelled');
      _renderSide();
      _renderClassBar();
      return;
    }
    if (!_selectedId) { _showHint('Tap a box to link first'); return; }
    _linkSource = { sideIndex: _sideIndex, bboxId: _selectedId };
    _showHint('Swipe to an adjacent side, then tap the matching bunch');
    _renderSide();
    _renderClassBar();
  }

  function _completeLink(targetBbox) {
    const src = _linkSource;
    if (!src) return;
    if (src.sideIndex === _sideIndex) {
      _showHint('Target must be on a different side');
      return;
    }
    if (!_isAdjacent(src.sideIndex, _sideIndex)) {
      _showHint(`${_sideLabel(src.sideIndex)} and ${_sideLabel(_sideIndex)} are not adjacent`);
      return;
    }
    // addManualLink orients to the adjacent pair internally; pass (source, target).
    const link = ActiveSession.addManualLink(src.sideIndex, src.bboxId, _sideIndex, targetBbox.id);
    _linkSource = null;
    if (link) {
      _selectedId = targetBbox.id;
      _showHint('Linked');
    } else {
      _showHint('Could not link these boxes');
    }
    refresh();
  }

  // ── EDIT mode (mount a BBoxEditor on the current side) ──────────────────────

  function _mountEditor() {
    const s = _session();
    if (!s) return;
    const side = s.sides[_sideIndex];
    if (!side) return;
    const url = _imageUrlForSide(side);
    if (!url) { _showHint('Image unavailable'); return; }

    _editor = BBoxEditor.create(
      _canvas,
      url,
      side.bboxes,
      (updatedBboxes) => {
        // Editor owns the bbox array; sync back to session + mark dirty.
        const st = _session();
        if (!st) return;
        st.sides[_sideIndex].bboxes = updatedBboxes;
        st.dirty = true;
        _renderDots();
        _renderThumbs();
        _renderLinksList();
      },
      (bboxId /*, classId */) => {
        // Propagate the editor's class change to the confirmed cluster.
        ActiveSession.propagateClassFromBox(_sideIndex, bboxId);
      }
    );
    if (_editor.setBoxesVisible) _editor.setBoxesVisible(_boxesVisible);
  }

  function _destroyEditor() {
    if (_editor) { _editor.destroy(); _editor = null; }
  }

  // ── Bottom UI rendering ─────────────────────────────────────────────────────

  function _renderClassBar() {
    const editing = _mode === MODE_EDIT;
    let selected;
    if (editing) {
      selected = _editor ? _editor.getSelectedId() : null;
    } else {
      selected = _selectedId;
    }
    const hasSel = !!selected;

    // Mark the active class chip when a box is selected (REVIEW only — the
    // editor does not expose the selected box's class).
    const chips = _classBar.querySelectorAll('.crsl-chip');
    let selClassId = -1;
    if (!editing && hasSel) {
      const s = _session();
      const side = s && s.sides[_sideIndex];
      const bbox = side && side.bboxes.find(b => b.id === selected);
      if (bbox) selClassId = bbox.classId;
    }
    chips.forEach(chip => {
      const cid = parseInt(chip.dataset.class, 10);
      chip.classList.toggle('crsl-chip--active', cid === selClassId);
      chip.disabled = editing ? false : !hasSel;
    });

    const boxesBtn = _classBar.querySelector('[data-role="boxes"]');
    const linkBtn = _classBar.querySelector('[data-role="link"]');
    const delBtn = _classBar.querySelector('[data-role="delete"]');
    if (boxesBtn) {
      boxesBtn.classList.toggle('crsl-action--active', _boxesVisible);
      boxesBtn.textContent = _boxesVisible ? 'Boxes on' : 'Boxes off';
    }
    if (linkBtn) {
      linkBtn.classList.toggle('crsl-action--armed', !!_linkSource);
      linkBtn.textContent = _linkSource ? 'Cancel link' : 'Link';
      linkBtn.disabled = editing;
    }
    if (delBtn) delBtn.disabled = editing ? false : !hasSel;

    // Selected-bbox readout / armed-link prompt.
    if (_linkSource) {
      _selInfoEl.textContent = `Linking from ${_sideLabel(_linkSource.sideIndex)} — tap target`;
    } else if (!editing && hasSel) {
      const s = _session();
      const side = s && s.sides[_sideIndex];
      const bbox = side && side.bboxes.find(b => b.id === selected);
      _selInfoEl.textContent = `${_sideLabel(_sideIndex)} · ${bbox ? bbox.className : ''} selected`;
    } else {
      _selInfoEl.textContent = `${_sideLabel(_sideIndex)} · ${_sideCount()} sides`;
    }
  }

  function _renderDots() {
    const n = _sideCount();
    _dotsEl.innerHTML = '';
    const s = _session();
    for (let i = 0; i < n; i++) {
      const side = s.sides[i];
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'crsl-dot';
      if (i === _sideIndex) dot.classList.add('crsl-dot--current');
      if (side.bboxes.length > 0) dot.classList.add('crsl-dot--has-boxes');
      const linked = s.confirmedLinks.some(l => l.sideA === i || l.sideB === i);
      if (linked) dot.classList.add('crsl-dot--has-links');
      dot.title = `${_sideLabel(i)} — ${side.bboxes.length} box(es)`;
      dot.addEventListener('click', () => goToSide(i));
      _dotsEl.appendChild(dot);
    }
  }

  function _renderThumbs() {
    const n = _sideCount();
    _thumbsEl.innerHTML = '';
    const s = _session();
    for (let i = 0; i < n; i++) {
      const side = s.sides[i];
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'crsl-thumb';
      if (i === _sideIndex) thumb.classList.add('crsl-thumb--current');
      thumb.addEventListener('click', () => goToSide(i));

      const url = _imageUrlForSide(side);
      if (url) {
        const im = document.createElement('img');
        im.src = url;
        im.alt = _sideLabel(i);
        thumb.appendChild(im);
      }
      const cap = document.createElement('span');
      cap.className = 'crsl-thumb__cap';
      cap.textContent = (i + 1) + (side.bboxes.length ? ` · ${side.bboxes.length}` : '');
      thumb.appendChild(cap);
      _thumbsEl.appendChild(thumb);
    }
  }

  // Confirmed links touching the current side, with a tap-to-remove control.
  function _renderLinksList() {
    const s = _session();
    _linksListEl.innerHTML = '';
    if (!s) return;
    const links = s.confirmedLinks.filter(l => l.sideA === _sideIndex || l.sideB === _sideIndex);
    if (links.length === 0) {
      _linksListEl.classList.add('crsl-links--empty');
      _linksListEl.textContent = '';
      return;
    }
    _linksListEl.classList.remove('crsl-links--empty');

    s.confirmedLinks.forEach((link, i) => {
      if (link.sideA !== _sideIndex && link.sideB !== _sideIndex) return;
      const otherSide = link.sideA === _sideIndex ? link.sideB : link.sideA;
      const color = _colorForLink(link.linkId);

      const row = document.createElement('div');
      row.className = 'crsl-link-row';

      const badge = document.createElement('span');
      badge.className = 'crsl-link-badge';
      badge.style.background = color;
      badge.textContent = String(i + 1);

      const label = document.createElement('span');
      label.className = 'crsl-link-label';
      label.textContent = `→ ${_sideLabel(otherSide)}`;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'crsl-link-del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Remove link');
      del.addEventListener('click', () => {
        ActiveSession.removeConfirmedLink(link.linkId);
        refresh();
      });

      row.append(badge, label, del);
      _linksListEl.appendChild(row);
    });
  }

  // ── Stage swipe gestures (REVIEW only) ──────────────────────────────────────

  function _onStageDown(e) {
    if (_mode === MODE_EDIT) return; // editor owns gestures
    // Ignore presses that originate on edge buttons (they have their own click).
    if (e.target.closest('.crsl-edge')) return;
    _ptr = {
      id: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      lastX: e.clientX,
      dx: 0, dy: 0,
      decided: false, isSwipe: false,
    };
    try { _stage.setPointerCapture(e.pointerId); } catch (_) {}
  }

  function _onStageMove(e) {
    if (!_ptr || e.pointerId !== _ptr.id) return;
    _ptr.dx = e.clientX - _ptr.x0;
    _ptr.dy = e.clientY - _ptr.y0;
    _ptr.lastX = e.clientX;

    if (!_ptr.decided) {
      const adx = Math.abs(_ptr.dx), ady = Math.abs(_ptr.dy);
      if (adx > TAP_SLOP || ady > TAP_SLOP) {
        // Horizontal-dominant travel → swipe; otherwise leave as tap/scroll.
        _ptr.decided = true;
        _ptr.isSwipe = adx > ady * SWIPE_DOMINANCE;
      }
    }

    if (_ptr.isSwipe) {
      e.preventDefault();
      // Rubber-band the track with the finger for live feedback.
      _track.style.transition = 'none';
      _track.style.transform = `translateX(${_ptr.dx}px)`;
    }
  }

  function _onStageUp(e) {
    if (!_ptr || e.pointerId !== _ptr.id) return;
    const p = _ptr;
    _ptr = null;
    try { _stage.releasePointerCapture(e.pointerId); } catch (_) {}

    // Reset any live drag transform before deciding.
    _track.style.transition = '';
    _track.style.transform = '';

    if (p.isSwipe) {
      if (p.dx <= -SWIPE_THRESHOLD) { _go(1); return; }
      if (p.dx >=  SWIPE_THRESHOLD) { _go(-1); return; }
      // Below threshold — snapped back, no side change.
      return;
    }

    // Not a swipe: treat as a tap if travel stayed within slop.
    if (Math.abs(p.dx) <= TAP_SLOP && Math.abs(p.dy) <= TAP_SLOP) {
      _onReviewTap(e.clientX, e.clientY);
    }
  }

  function _onStageCancel(e) {
    if (!_ptr || e.pointerId !== _ptr.id) return;
    _ptr = null;
    _track.style.transition = '';
    _track.style.transform = '';
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  // Build DOM inside containerEl for the CURRENT session. Safe to call repeatedly
  // (re-binds to a new container / re-reads the session).
  function init(containerEl, opts) {
    if (!containerEl) return;
    _hooks = (opts && opts.hooks && typeof opts.hooks === 'object') ? opts.hooks : {};
    _treeLabelEl = null;
    _actionRowEl = null;
    _destroyEditor();
    _root = containerEl;
    _destroyed = false;
    _releaseImgCache();
    _linkColorMap.clear();
    _colorSeq = 0;
    _selectedId = null;
    _linkSource = null;
    _mode = MODE_REVIEW;
    _sideIndex = 0;
    _buildDom(containerEl);
    _renderAll();
  }

  // (Re)render / resume — call when the tab becomes visible. EDIT mode remounts
  // the editor so its canvas is sized to the now-visible panel.
  function show() {
    if (!_root || !_session()) { if (_root) _renderAll(); return; }
    if (_mode === MODE_EDIT) {
      _destroyEditor();
      _mountEditor();
    } else {
      _renderSide();
    }
    _renderDots();
    _renderThumbs();
    _renderClassBar();
    _renderLinksList();
  }

  // Re-read ActiveSession and redraw everything (after external changes such as
  // detection or auto-load).
  function refresh() {
    if (!_root) return;
    const n = _sideCount();
    if (n > 0 && _sideIndex >= n) _sideIndex = 0;
    if (_mode === MODE_EDIT && _editor) {
      const s = _session();
      const side = s && s.sides[_sideIndex];
      if (side) _editor.syncBboxes(side.bboxes);
    } else {
      _renderSide();
    }
    _renderDots();
    _renderThumbs();
    _renderClassBar();
    _renderLinksList();
  }

  function _renderAll() {
    if (!_session()) {
      // Graceful no-op render: clear surfaces, no boxes.
      if (_canvas) _clearCanvas();
      if (_dotsEl) _dotsEl.innerHTML = '';
      if (_thumbsEl) _thumbsEl.innerHTML = '';
      if (_linksListEl) { _linksListEl.innerHTML = ''; _linksListEl.classList.add('crsl-links--empty'); }
      if (_selInfoEl) _selInfoEl.textContent = 'No tree loaded';
      _renderClassBar && _classBar && _renderClassBar();
      return;
    }
    if (_mode === MODE_EDIT) { _destroyEditor(); _mountEditor(); }
    else _renderSide();
    _renderDots();
    _renderThumbs();
    _renderClassBar();
    _renderLinksList();
  }

  // Jump directly to side `i` (clamped). Clears per-side transient selection.
  function goToSide(i) {
    const n = _sideCount();
    if (n === 0) return;
    const target = ((i % n) + n) % n;
    _sideIndex = target;
    _selectedId = null;
    // Keep an armed link source across navigation (that is the whole point of
    // arming it before swiping) — only clear it when it has been resolved.

    if (_mode === MODE_EDIT) {
      _destroyEditor();
      _mountEditor();
    } else {
      _renderSide();
    }
    _renderDots();
    _renderThumbs();
    _renderClassBar();
    _renderLinksList();
  }

  // Tear down editor + listeners. The container DOM is left in place; init()
  // rebuilds it. Safe to call when nothing was initialized.
  function destroy() {
    _destroyed = true;
    _destroyEditor();
    if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
    if (_stage) {
      _stage.removeEventListener('pointerdown', _onStageDown);
      _stage.removeEventListener('pointermove', _onStageMove);
      _stage.removeEventListener('pointerup', _onStageUp);
      _stage.removeEventListener('pointercancel', _onStageCancel);
    }
    _releaseImgCache();
    _ptr = null;
    _selectedId = null;
    _linkSource = null;
  }

  // Update the compact topbar tree label (host calls this when the tree changes
  // without a full re-init).
  function setTreeLabel(text) {
    _hooks.treeLabel = text;
    if (_treeLabelEl) _treeLabelEl.textContent = _resolveTreeLabel();
  }

  return { init, show, refresh, goToSide, destroy, setTreeLabel };
})();

window.CarouselUI = CarouselUI;
