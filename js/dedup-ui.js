'use strict';

/**
 * DedupUI — two-canvas side-by-side cross-side linking interface.
 *
 * Usage:
 *   DedupUI.init(leftCanvasEl, rightCanvasEl, suggestionsListEl, linksListEl);
 *   DedupUI.showPair(pairIndex);   // 0-3
 *   DedupUI.destroy();
 */

const DedupUI = (() => {
  // Link color palette (cyclic)
  const LINK_COLORS = [
    '#22c55e', '#3b82f6', '#f59e0b', '#ec4899',
    '#06b6d4', '#a855f7', '#ef4444', '#84cc16',
  ];
  const CROSS_PAIR_COLOR = '#94a3b8';

  let _leftCanvas, _rightCanvas, _suggEl, _linksEl;
  let _pairIndex = 0;
  let _leftImage = null, _rightImage = null;
  let _leftTr = null,    _rightTr = null;
  let _pendingLeft = null;   // bboxId selected on left canvas waiting for right click
  let _guideY = null;        // normalized Y for horizontal guideline
  let _destroyed = false;
  let _colorSeq = 0;
  let _listenersAttached = false;

  // Edit state: which bbox is currently selected for class change / delete
  // { sideIdx: number, bboxId: string } | null
  let _editSelection = null;

  // Draw/interaction state on mousedown
  // { side: 'left'|'right', sideIdx, mode: 'click'|'draw', bboxId?, ix0,iy0,ix1,iy1, moved }
  let _drawState = null;
  const DRAG_THRESHOLD_PX = 3;   // image px
  const MIN_NEW_BBOX_PX   = 4;   // image px
  const DEFAULT_NEW_CLASS_ID = 1; // B2

  // Cached bboxes/highlights for magnifier use in mousemove
  let _lastBboxesLeft     = [], _lastBboxesRight     = [];
  let _lastHighlightsLeft = new Map(), _lastHighlightsRight = new Map();

  // ── Magnifier ──────────────────────────────────────────────────────────────
  const MAG_SIZE      = 230;   // CSS px side length of magnifier window
  const MAG_ZOOM_MIN  = 1.5;
  const MAG_ZOOM_MAX  = 8.0;
  const MAG_ZOOM_STEP = 0.3;
  let _magZoom = 3.8;          // adjustable via scroll wheel
  let _magEnabled = true;
  let _lastMagState = null;    // cached args for re-render on zoom change

  let _magEl = null, _magCanvas = null, _magCtx = null;

  // Whether algorithm suggestions are shown on canvas + in the panel.
  // When false, confirmed links still render; suggested-only bboxes are not
  // decorated and the suggestion panel shows a hint instead of rows.
  let _showSuggestions = true;

  function _ensureMagnifier() {
    if (_magEl) return;
    _magEl = document.createElement('div');
    _magEl.className = 'dedup-magnifier';
    _magCanvas = document.createElement('canvas');
    const magDpr = window.devicePixelRatio || 1;
    _magCanvas.width  = MAG_SIZE * magDpr;
    _magCanvas.height = MAG_SIZE * magDpr;
    _magCanvas.style.width  = MAG_SIZE + 'px';
    _magCanvas.style.height = MAG_SIZE + 'px';
    _magEl.appendChild(_magCanvas);
    document.body.appendChild(_magEl);
    _magCtx = _magCanvas.getContext('2d');
  }

  function _hideMagnifier() {
    if (_magEl) _magEl.style.display = 'none';
    _lastMagState = null;
  }

  function _onWheel(e) {
    if (!_magEl || _magEl.style.display === 'none') return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -MAG_ZOOM_STEP : MAG_ZOOM_STEP;
    _magZoom = Math.min(MAG_ZOOM_MAX, Math.max(MAG_ZOOM_MIN,
                        parseFloat((_magZoom + delta).toFixed(1))));
    if (_lastMagState) {
      const s = _lastMagState;
      _showMagnifier(s.canvas, s.img, s.tr, s.bboxes, s.highlights, s.e);
    }
  }

  function _showMagnifier(sourceCanvas, img, tr, bboxes, highlights, e) {
    if (!_magEnabled) { _hideMagnifier(); return; }
    if (!img || !tr) { _hideMagnifier(); return; }
    _ensureMagnifier();

    // Cache state for scroll-wheel re-render
    _lastMagState = { canvas: sourceCanvas, img, tr, bboxes, highlights, e };

    const dpr    = _dpr();
    const magDpr = window.devicePixelRatio || 1;
    const rect   = sourceCanvas.getBoundingClientRect();
    const cssX   = e.clientX - rect.left;
    const cssY   = e.clientY - rect.top;

    // Image coords at cursor
    const { x: imgX, y: imgY } = tr.canvasToImage(cssX * dpr, cssY * dpr);

    // Source half-size in image pixels
    const halfW = (MAG_SIZE / 2) / _magZoom;
    const halfH = (MAG_SIZE / 2) / _magZoom;
    const srcX = imgX - halfW, srcY = imgY - halfH;

    const ctx = _magCtx;
    ctx.clearRect(0, 0, _magCanvas.width, _magCanvas.height);

    // Draw image region zoomed
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, _magCanvas.width, _magCanvas.height);
    ctx.clip();
    ctx.drawImage(img, srcX, srcY, halfW * 2, halfH * 2,
                  0, 0, _magCanvas.width, _magCanvas.height);

    // Draw bboxes in magnified coords
    const magScale = _magZoom * magDpr;
    bboxes.forEach(b => {
      const hi = highlights.get(b.id);
      const isCrossPair = !!(hi && hi.crossPair && b.id !== _pendingLeft);
      let color = CanvasRenderer.getClassColor(b.className);
      if (hi) color = hi.color;
      if (b.id === _pendingLeft) color = '#fff';

      const mx1 = (b.x1 - srcX) * magScale;
      const my1 = (b.y1 - srcY) * magScale;
      const mx2 = (b.x2 - srcX) * magScale;
      const my2 = (b.y2 - srcY) * magScale;
      const mw  = mx2 - mx1, mh = my2 - my1;

      if (hi || b.id === _pendingLeft) {
        ctx.fillStyle = color + (isCrossPair ? '1f' : '30');
        ctx.fillRect(mx1, my1, mw, mh);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = hi ? (isCrossPair ? 2 * magDpr : 3 * magDpr) : 1.5 * magDpr;
      if (isCrossPair) ctx.setLineDash([6 * magDpr, 4 * magDpr]);
      ctx.strokeRect(mx1, my1, mw, mh);
      if (isCrossPair) ctx.setLineDash([]);

      // Label
      if (mw > 10) {
        const fs = Math.max(10, 11 * magDpr);
        ctx.font = `${fs}px sans-serif`;
        const lbl = b.className + (hi ? (hi.crossPair ? ' [other pair]' : ` #${hi.num}`) : '');
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

    // Zoom level badge (bottom-right corner)
    const zoomTxt = _magZoom.toFixed(1) + '×';
    const fs = Math.round(11 * magDpr);
    ctx.font = `bold ${fs}px monospace`;
    const tw = ctx.measureText(zoomTxt).width;
    const bx = _magCanvas.width  - tw - Math.round(6 * magDpr);
    const by = _magCanvas.height - Math.round(4 * magDpr);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx - 2, by - fs - 2, tw + 6, fs + 4);
    ctx.fillStyle = '#facc15';
    ctx.fillText(zoomTxt, bx, by);

    ctx.restore();

    // Position: above-right cursor, flip if near edge
    const off = 18;
    let left = e.clientX + off;
    let top  = e.clientY - MAG_SIZE - off;
    if (left + MAG_SIZE > window.innerWidth - 4)  left = e.clientX - MAG_SIZE - off;
    if (top < 4) top = e.clientY + off;

    _magEl.style.display = 'block';
    _magEl.style.left    = left + 'px';
    _magEl.style.top     = top  + 'px';
  }

  const _dpr = () => window.devicePixelRatio || 1;

  function _isSameSidePair(link, sideA, sideB) {
    return (link.sideA === sideA && link.sideB === sideB) ||
           (link.sideA === sideB && link.sideB === sideA);
  }

  // ── Bbox summary helper ────────────────────────────────────────────────────

  function _bboxSummary(bboxes) {
    if (!bboxes || !bboxes.length) return '0 bbox';
    const counts = {};
    bboxes.forEach(b => { counts[b.className] = (counts[b.className] || 0) + 1; });
    const parts = Object.entries(counts).sort().map(([cls, n]) => `${n}× ${cls}`);
    return `${bboxes.length} bbox: ${parts.join(', ')}`;
  }

  // ── Transforms ────────────────────────────────────────────────────────────

  function _makeTr(canvas, imgW, imgH, anchor) {
    const dpr = _dpr();
    const displayW = canvas.clientWidth;
    const displayH = canvas.clientHeight;
    const scale = Math.min(displayW / imgW, displayH / imgH);
    // anchor: 'right' pushes the image to the right edge (shared seam for LEFT canvas / sideB),
    //         'left'  pushes to the left edge (shared seam for RIGHT canvas / sideA),
    //         default center.
    let offX;
    if      (anchor === 'right') offX = displayW - imgW * scale;
    else if (anchor === 'left')  offX = 0;
    else                         offX = (displayW - imgW * scale) / 2;
    const offY = (displayH - imgH * scale) / 2;
    return {
      scale,
      imageToCanvas(ix, iy) {
        return { x: (ix * scale + offX) * dpr, y: (iy * scale + offY) * dpr };
      },
      canvasToImage(cx, cy) {
        return { x: (cx / dpr - offX) / scale, y: (cy / dpr - offY) / scale };
      },
      scaleToCanvas(v) { return v * scale * dpr; },
    };
  }

  // ── Color assignment for links ─────────────────────────────────────────────

  const _linkColorMap = new Map(); // linkId → color

  function _colorForLink(linkId) {
    if (!_linkColorMap.has(linkId)) {
      _linkColorMap.set(linkId, LINK_COLORS[(_colorSeq++) % LINK_COLORS.length]);
    }
    return _linkColorMap.get(linkId);
  }

  function _colorForSuggest(idx) {
    return LINK_COLORS[idx % LINK_COLORS.length];
  }

  // ── Image loading ──────────────────────────────────────────────────────────

  function _loadImg(url) {
    return new Promise((resolve, reject) => {
      if (!url) { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function _renderCanvas(canvas, img, tr, bboxes, highlights, guideYNorm, editSelId, drawRect) {
    if (!canvas || !img || !tr) return;
    const dpr = _dpr();
    canvas.width  = canvas.clientWidth  * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Image
    const tl = tr.imageToCanvas(0, 0);
    const br = tr.imageToCanvas(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    const lineW = Math.max(1.5, tr.scaleToCanvas(1.5));

    // Bboxes
    bboxes.forEach((b, idx) => {
      const btl = tr.imageToCanvas(b.x1, b.y1);
      const bbr = tr.imageToCanvas(b.x2, b.y2);
      const bw = bbr.x - btl.x, bh = bbr.y - btl.y;

      const hi = highlights.get(b.id);
      const isCrossPair = !!(hi && hi.crossPair && b.id !== _pendingLeft);
      let color = CanvasRenderer.getClassColor(b.className);
      let lw = lineW;

      if (hi) {
        color = hi.color;
        lw = isCrossPair ? lineW * 1.8 : lineW * 2.5;
        // Colored fill
        ctx.fillStyle = color + (isCrossPair ? '1f' : '33');
        ctx.fillRect(btl.x, btl.y, bw, bh);
        if (!isCrossPair) {
          // Badge circle
          const bx = bbr.x - 10, by = btl.y + 10;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(bx, by, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.max(9, tr.scaleToCanvas(10))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(hi.num, bx, by);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
        }
      }

      // Pending link selection glow (left bbox waiting for right pair)
      if (b.id === _pendingLeft) {
        ctx.fillStyle = '#fff4';
        ctx.fillRect(btl.x, btl.y, bw, bh);
        color = '#fff';
        lw = lineW * 3;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      if (isCrossPair) ctx.setLineDash([8, 5]);
      ctx.strokeRect(btl.x, btl.y, bw, bh);
      if (isCrossPair) ctx.setLineDash([]);

      // Edit selection ring (cyan dashed outer)
      if (b.id === editSelId) {
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = Math.max(1.5, lineW * 1.2);
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(btl.x - 2, btl.y - 2, bw + 4, bh + 4);
        ctx.setLineDash([]);
      }

      // Label
      const labelSuffix = hi ? (hi.crossPair ? ' [other pair]' : ` #${hi.num}`) : '';
      const label = `#${idx + 1} ${b.className}${labelSuffix}`;
      const fontSize = Math.max(10, tr.scaleToCanvas(11));
      ctx.font = `${fontSize}px sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(btl.x, Math.max(0, btl.y - fontSize - 2), tw + 4, fontSize + 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, btl.x + 2, Math.max(fontSize, btl.y - 2));
    });

    // Drag-drawing in progress
    if (drawRect) {
      const dtl = tr.imageToCanvas(Math.min(drawRect.x1, drawRect.x2), Math.min(drawRect.y1, drawRect.y2));
      const dbr = tr.imageToCanvas(Math.max(drawRect.x1, drawRect.x2), Math.max(drawRect.y1, drawRect.y2));
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(dtl.x, dtl.y, dbr.x - dtl.x, dbr.y - dtl.y);
      ctx.setLineDash([]);
    }

    // Horizontal guideline
    if (guideYNorm !== null && guideYNorm >= 0) {
      const gc = tr.imageToCanvas(0, guideYNorm * img.naturalHeight);
      ctx.strokeStyle = 'rgba(255,255,0,0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, gc.y);
      ctx.lineTo(canvas.width, gc.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function _getHighlights(session, pairLinks, pairSuggestions, sideIndex, pairSideA, pairSideB) {
    const map = new Map(); // bboxId → {color, num}

    // Confirmed links in the active pair
    pairLinks.forEach((link, i) => {
      const color = _colorForLink(link.linkId);
      const num = i + 1;
      if (link.sideA === sideIndex) map.set(link.bboxIdA, { color, num });
      if (link.sideB === sideIndex) map.set(link.bboxIdB, { color, num });
    });

    // Suggested links (show after confirmed) — only when the suggestion layer is visible.
    if (_showSuggestions) {
      pairSuggestions.forEach((sug, i) => {
        const color = _colorForSuggest(pairLinks.length + i);
        const num = pairLinks.length + i + 1;
        if (sug.sideA === sideIndex && !map.has(sug.bboxIdA)) {
          map.set(sug.bboxIdA, { color, num, suggested: true });
        }
        if (sug.sideB === sideIndex && !map.has(sug.bboxIdB)) {
          map.set(sug.bboxIdB, { color, num, suggested: true });
        }
      });
    }

    // Cross-pair indicator for boxes linked in another pair.
    session.confirmedLinks.forEach(link => {
      if (_isSameSidePair(link, pairSideA, pairSideB)) return;

      let bboxId = null;
      if (link.sideA === sideIndex) bboxId = link.bboxIdA;
      else if (link.sideB === sideIndex) bboxId = link.bboxIdB;
      if (!bboxId || map.has(bboxId)) return;

      map.set(bboxId, {
        color: CROSS_PAIR_COLOR,
        num: 'x',
        crossPair: true,
      });
    });

    return map;
  }

  // ── Pair rendering ─────────────────────────────────────────────────────────

  async function _renderPair() {
    const session = ActiveSession.get();
    if (!session) return;
    const [iA, iB] = ADJACENT_PAIRS[_pairIndex];
    const sA = session.sides[iA], sB = session.sides[iB];

    // Display: sideB on LEFT, sideA on RIGHT
    // (left edge of sideA meets right edge of sideB at the shared corner)
    [_leftImage, _rightImage] = await Promise.all([
      _loadImg(sB.imageUrl), _loadImg(sA.imageUrl),
    ]);

    // Anchor each canvas toward the shared seam so images meet tightly in the middle.
    if (_leftImage)  _leftTr  = _makeTr(_leftCanvas,  _leftImage.naturalWidth,  _leftImage.naturalHeight, 'right');
    if (_rightImage) _rightTr = _makeTr(_rightCanvas, _rightImage.naturalWidth, _rightImage.naturalHeight, 'left');

    const pairLinks = session.confirmedLinks.filter(
      l => (l.sideA === iA && l.sideB === iB) || (l.sideA === iB && l.sideB === iA)
    );
    const pairSuggestions = session.suggestedLinks.filter(
      l => l.sideA === iA && l.sideB === iB
    );

    _lastHighlightsLeft  = _getHighlights(session, pairLinks, pairSuggestions, iB, iA, iB);
    _lastHighlightsRight = _getHighlights(session, pairLinks, pairSuggestions, iA, iA, iB);
    _lastBboxesLeft      = sB.bboxes;
    _lastBboxesRight     = sA.bboxes;

    const editSelLeftId  = _editSelection && _editSelection.sideIdx === iB ? _editSelection.bboxId : null;
    const editSelRightId = _editSelection && _editSelection.sideIdx === iA ? _editSelection.bboxId : null;
    const leftDraw  = (_drawState && _drawState.mode === 'draw' && _drawState.moved && _drawState.side === 'left')
      ? { x1: _drawState.ix0, y1: _drawState.iy0, x2: _drawState.ix1, y2: _drawState.iy1 } : null;
    const rightDraw = (_drawState && _drawState.mode === 'draw' && _drawState.moved && _drawState.side === 'right')
      ? { x1: _drawState.ix0, y1: _drawState.iy0, x2: _drawState.ix1, y2: _drawState.iy1 } : null;

    _renderCanvas(_leftCanvas,  _leftImage,  _leftTr,  sB.bboxes, _lastHighlightsLeft,  _guideY, editSelLeftId,  leftDraw);
    _renderCanvas(_rightCanvas, _rightImage, _rightTr, sA.bboxes, _lastHighlightsRight, _guideY, editSelRightId, rightDraw);

    // Bbox info overlays
    const leftInfoEl  = document.getElementById('dedup-left-info');
    const rightInfoEl = document.getElementById('dedup-right-info');
    if (leftInfoEl)  leftInfoEl.textContent  = _bboxSummary(sB.bboxes);
    if (rightInfoEl) rightInfoEl.textContent = _bboxSummary(sA.bboxes);

    _renderSuggestions(pairSuggestions, pairLinks.length);
    _renderLinks(pairLinks, iA, iB);
  }

  // ── Suggestion panel ───────────────────────────────────────────────────────

  function _renderSuggestions(suggestions, linkOffset) {
    if (!_suggEl) return;
    _suggEl.innerHTML = '';

    const [iA, iB] = ADJACENT_PAIRS[_pairIndex];

    if (!_showSuggestions) {
      _suggEl.innerHTML = '<p class="dedup-empty">Automatic suggestions are hidden.</p>';
      return;
    }

    if (suggestions.length === 0) {
      _suggEl.innerHTML = '<p class="dedup-empty">No suggestions.</p>';
      return;
    }

    const autoCount = suggestions.filter(s => s.category === 'auto').length;
    if (autoCount > 0) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-success btn-sm';
      btn.textContent = `Accept All Auto (${autoCount})`;
      btn.onclick = () => {
        ActiveSession.confirmAllAutoForPair(iA, iB);
        _renderPair();
      };
      _suggEl.appendChild(btn);
    }

    suggestions.forEach((sug, i) => {
      const session = ActiveSession.get();
      const sA = session.sides[iA], sB = session.sides[iB];
      const bA = sA.bboxes.find(b => b.id === sug.bboxIdA);
      const bB = sB.bboxes.find(b => b.id === sug.bboxIdB);
      if (!bA || !bB) return;

      const color = _colorForSuggest(linkOffset + i);
      const row = document.createElement('div');
      row.className = 'dedup-suggestion-row ' + (sug.category === 'auto' ? 'auto' : 'candidate');

      const badge = document.createElement('span');
      badge.className = 'dedup-badge';
      badge.style.background = color;
      badge.textContent = linkOffset + i + 1;

      const main = document.createElement('div');
      main.className = 'dedup-suggestion-main';

      const label = document.createElement('span');
      label.className = 'dedup-suggestion-label';
      const scoreStr = (sug.score * 100).toFixed(0);
      const mismatch = bA.className !== bB.className;
      label.textContent = `${bB.className} (${TREE_SIDE_LABELS[iB]}) <-> ${bA.className} (${TREE_SIDE_LABELS[iA]}) - ${scoreStr}%${mismatch ? ' !' : ''}`;
      main.appendChild(label);

      if (sug.signals) main.appendChild(_buildSignalBadges(sug.signals));

      const accept = document.createElement('button');
      accept.className = 'btn btn-xs btn-success';
      accept.textContent = 'Accept';
      accept.onclick = () => { ActiveSession.confirmLink(sug.linkId); _renderPair(); };

      const reject = document.createElement('button');
      reject.className = 'btn btn-xs btn-danger';
      reject.textContent = 'Reject';
      reject.onclick = () => { ActiveSession.rejectLink(sug.linkId); _renderPair(); };

      row.append(badge, main, accept, reject);
      _suggEl.appendChild(row);
    });
  }

  // Build small colored badges showing the per-signal breakdown of a score.
    // Green >= 0.75, amber 0.50-0.75, red < 0.50. Class multiplier is shown
  // separately (green = same class, amber = adjacent, red = far).
  function _buildSignalBadges(signals) {
    const wrap = document.createElement('div');
    wrap.className = 'dedup-signal-badges';
    const entries = [
      ['seam', signals.seam, 'Seam proximity (0 = center, 1 = near seam)'],
      ['vert', signals.vert, 'Vertical centroid similarity'],
      ['size', signals.size, 'Size and aspect-ratio similarity'],
      ['cls',  signals.cls,  'Class-based multiplier (1 = same, 0.85 = ±1 grade, 0.5 = far)'],
    ];
    for (const [key, val, tip] of entries) {
      if (val == null) continue;
      const span = document.createElement('span');
      span.className = 'sig-badge sig-' + (val >= 0.75 ? 'hi' : val >= 0.5 ? 'mid' : 'lo');
      span.textContent = `${key} ${val.toFixed(2)}`;
      span.title = tip;
      wrap.appendChild(span);
    }
    return wrap;
  }

  // ── Confirmed links panel ──────────────────────────────────────────────────

  function _renderLinks(links, iA, iB) {
    if (!_linksEl) return;
    _linksEl.innerHTML = '';

    if (links.length === 0) {
      _linksEl.innerHTML = '<p class="dedup-empty">No confirmed links yet.</p>';
      return;
    }

    const session = ActiveSession.get();
    links.forEach((link, i) => {
      const color = _colorForLink(link.linkId);
      // Normalize: put LEFT-canvas side (iB) first in label for visual consistency
      const leftIdx  = link.sideA === iB ? link.sideA : link.sideB;
      const rightIdx = link.sideA === iB ? link.sideB : link.sideA;
      const bIdLeft  = link.sideA === iB ? link.bboxIdA : link.bboxIdB;
      const bIdRight = link.sideA === iB ? link.bboxIdB : link.bboxIdA;
      const bLeft  = session.sides[leftIdx].bboxes.find(b => b.id === bIdLeft);
      const bRight = session.sides[rightIdx].bboxes.find(b => b.id === bIdRight);

      const row = document.createElement('div');
      row.className = 'dedup-link-row';

      const badge = document.createElement('span');
      badge.className = 'dedup-badge';
      badge.style.background = color;
      badge.textContent = i + 1;

      const label = document.createElement('span');
      label.className = 'dedup-link-label';
      const classMismatch = bLeft && bRight && bLeft.className !== bRight.className;
      label.textContent = `${bLeft ? bLeft.className : '-'} (${TREE_SIDE_LABELS[leftIdx]}) <-> ${bRight ? bRight.className : '-'} (${TREE_SIDE_LABELS[rightIdx]})${classMismatch ? ' !' : ''}`;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-xs btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.onclick = () => { ActiveSession.removeConfirmedLink(link.linkId); _renderPair(); };

      row.append(badge, label, deleteBtn);
      _linksEl.appendChild(row);
    });
  }

  // ── Mouse events ───────────────────────────────────────────────────────────

  function _canvasCoords(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const dpr = _dpr();
    return { cx: (e.clientX - rect.left) * dpr, cy: (e.clientY - rect.top) * dpr };
  }

  function _hitBbox(bboxes, ix, iy) {
    for (let i = bboxes.length - 1; i >= 0; i--) {
      const b = bboxes[i];
      if (ix >= b.x1 && ix <= b.x2 && iy >= b.y1 && iy <= b.y2) return b;
    }
    return null;
  }

  function _newBboxId() {
    return 'db-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  function _clampImg(ix, iy, img) {
    return {
      ix: Math.max(0, Math.min(img.naturalWidth,  ix)),
      iy: Math.max(0, Math.min(img.naturalHeight, iy)),
    };
  }

  function _handleBboxSelection(side, sideIdx, bboxId) {
    // Always mark this as the edit-focused bbox
    _editSelection = { sideIdx, bboxId };

    const session = ActiveSession.get();
    if (!session) return;
    const [iA, iB] = ADJACENT_PAIRS[_pairIndex];

    if (side === 'left') {
      // LEFT canvas = sideB. Record as pending partner for linking.
      _pendingLeft = bboxId;
    } else {
      // RIGHT canvas = sideA.
      if (_pendingLeft) {
        ActiveSession.addManualLink(iA, bboxId, iB, _pendingLeft);
        _pendingLeft = null;
      } else {
        // If this sideA bbox is already linked, resurface its partner as pending.
        const linked = session.confirmedLinks.find(
          l => _isSameSidePair(l, iA, iB) && (
            (l.sideA === iA && l.bboxIdA === bboxId) ||
            (l.sideB === iA && l.bboxIdB === bboxId)
          )
        );
        if (linked) {
          if (linked.sideA === iB) _pendingLeft = linked.bboxIdA;
          else if (linked.sideB === iB) _pendingLeft = linked.bboxIdB;
        }
      }
    }
  }

  function _onCanvasMouseDown(side, e) {
    if (e.button !== 0) return; // only primary button
    const canvas = side === 'left' ? _leftCanvas : _rightCanvas;
    const tr     = side === 'left' ? _leftTr     : _rightTr;
    const img    = side === 'left' ? _leftImage  : _rightImage;
    if (!tr || !img) return;
    const session = ActiveSession.get();
    if (!session) return;

    const { cx, cy } = _canvasCoords(canvas, e);
    const pt = tr.canvasToImage(cx, cy);
    const [iA, iB] = ADJACENT_PAIRS[_pairIndex];
    const sideIdx = side === 'left' ? iB : iA;
    const bboxes = session.sides[sideIdx].bboxes;

    // Inside-image check: only allow drawing when click starts on the image
    const onImage = pt.x >= 0 && pt.x <= img.naturalWidth && pt.y >= 0 && pt.y <= img.naturalHeight;

    const hit = onImage ? _hitBbox(bboxes, pt.x, pt.y) : null;
    if (hit) {
      _drawState = { side, sideIdx, mode: 'click', bboxId: hit.id, ix0: pt.x, iy0: pt.y, moved: false };
    } else if (onImage) {
      const { ix, iy } = _clampImg(pt.x, pt.y, img);
      _drawState = { side, sideIdx, mode: 'draw', ix0: ix, iy0: iy, ix1: ix, iy1: iy, moved: false };
      e.preventDefault();
    } else {
      _drawState = null;
    }
  }

  function _onCanvasMouseUp(side, e) {
    if (!_drawState || _drawState.side !== side) { _drawState = null; return; }
    const img = side === 'left' ? _leftImage : _rightImage;

    if (_drawState.mode === 'click') {
      if (!_drawState.moved) {
        _handleBboxSelection(side, _drawState.sideIdx, _drawState.bboxId);
      }
    } else if (_drawState.mode === 'draw') {
      if (_drawState.moved && img) {
        const x1 = Math.max(0, Math.min(_drawState.ix0, _drawState.ix1));
        const y1 = Math.max(0, Math.min(_drawState.iy0, _drawState.iy1));
        const x2 = Math.min(img.naturalWidth,  Math.max(_drawState.ix0, _drawState.ix1));
        const y2 = Math.min(img.naturalHeight, Math.max(_drawState.iy0, _drawState.iy1));
        if (x2 - x1 >= MIN_NEW_BBOX_PX && y2 - y1 >= MIN_NEW_BBOX_PX) {
          const classId = DEFAULT_NEW_CLASS_ID;
          const newBbox = {
            id: _newBboxId(),
            classId,
            className: CLASS_MAP[classId],
            x1, y1, x2, y2,
          };
          ActiveSession.addBbox(_drawState.sideIdx, newBbox);
          _editSelection = { sideIdx: _drawState.sideIdx, bboxId: newBbox.id };
          // Drawing on LEFT pre-loads it as a link partner for convenience.
          if (side === 'left') _pendingLeft = newBbox.id;
        }
      } else if (!_drawState.moved) {
        // Simple click on empty area → clear both selections.
        _pendingLeft = null;
        _editSelection = null;
      }
    }
    _drawState = null;
    _renderPair();
  }

  function _onMouseMove(canvas, img, tr, e) {
    if (!tr || !img) return;
    const { cx, cy } = _canvasCoords(canvas, e);
    const pt = tr.canvasToImage(cx, cy);
    _guideY = Math.max(0, Math.min(1, pt.y / img.naturalHeight));

    // Update draw/click drag state
    if (_drawState) {
      const side = canvas === _leftCanvas ? 'left' : 'right';
      if (_drawState.side === side) {
        if (_drawState.mode === 'draw') {
          const { ix, iy } = _clampImg(pt.x, pt.y, img);
          _drawState.ix1 = ix;
          _drawState.iy1 = iy;
          const dx = ix - _drawState.ix0, dy = iy - _drawState.iy0;
          if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
            _drawState.moved = true;
          }
        } else if (_drawState.mode === 'click') {
          const dx = pt.x - _drawState.ix0, dy = pt.y - _drawState.iy0;
          if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
            _drawState.moved = true; // cancel click-to-link if user drags
          }
        }
      }
    }

    // Re-render both canvases with updated guideline
    const [iA, iB] = ADJACENT_PAIRS[_pairIndex];
    const editSelLeftId  = _editSelection && _editSelection.sideIdx === iB ? _editSelection.bboxId : null;
    const editSelRightId = _editSelection && _editSelection.sideIdx === iA ? _editSelection.bboxId : null;
    const leftDraw  = (_drawState && _drawState.mode === 'draw' && _drawState.moved && _drawState.side === 'left')
      ? { x1: _drawState.ix0, y1: _drawState.iy0, x2: _drawState.ix1, y2: _drawState.iy1 } : null;
    const rightDraw = (_drawState && _drawState.mode === 'draw' && _drawState.moved && _drawState.side === 'right')
      ? { x1: _drawState.ix0, y1: _drawState.iy0, x2: _drawState.ix1, y2: _drawState.iy1 } : null;
    _renderCanvas(_leftCanvas,  _leftImage,  _leftTr,  _lastBboxesLeft,  _lastHighlightsLeft,  _guideY, editSelLeftId,  leftDraw);
    _renderCanvas(_rightCanvas, _rightImage, _rightTr, _lastBboxesRight, _lastHighlightsRight, _guideY, editSelRightId, rightDraw);

    // Show magnifier for the hovered canvas
    const isLeft = canvas === _leftCanvas;
    _showMagnifier(canvas, img, tr,
      isLeft ? _lastBboxesLeft : _lastBboxesRight,
      isLeft ? _lastHighlightsLeft : _lastHighlightsRight,
      e
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // Stable bound handlers for add/removeEventListener
  const _boundLeftDown   = (e) => _onCanvasMouseDown('left',  e);
  const _boundRightDown  = (e) => _onCanvasMouseDown('right', e);
  const _boundWinUp      = (e) => {
    // Route mouseup to whichever side is actively dragging (even if released off-canvas)
    if (!_drawState) return;
    _onCanvasMouseUp(_drawState.side, e);
  };
  const _boundLeftMove   = (e) => _onMouseMove(_leftCanvas,  _leftImage,  _leftTr,  e);
  const _boundRightMove  = (e) => _onMouseMove(_rightCanvas, _rightImage, _rightTr, e);
  const _boundHidemag    = ()  => _hideMagnifier();
  const _boundWheel      = (e) => _onWheel(e);
  const _boundContextMenu = (e) => e.preventDefault();
  let _winUpAttached = false;

  function init(leftCanvas, rightCanvas, suggEl, linksEl) {
    // Detach from previous canvases if switching
    if (_leftCanvas && _listenersAttached) {
      _leftCanvas.removeEventListener('mousedown',  _boundLeftDown);
      _leftCanvas.removeEventListener('mousemove',  _boundLeftMove);
      _leftCanvas.removeEventListener('mouseleave', _boundHidemag);
      _leftCanvas.removeEventListener('wheel',      _boundWheel);
      _leftCanvas.removeEventListener('contextmenu', _boundContextMenu);
    }
    if (_rightCanvas && _listenersAttached) {
      _rightCanvas.removeEventListener('mousedown', _boundRightDown);
      _rightCanvas.removeEventListener('mousemove', _boundRightMove);
      _rightCanvas.removeEventListener('mouseleave', _boundHidemag);
      _rightCanvas.removeEventListener('wheel',     _boundWheel);
      _rightCanvas.removeEventListener('contextmenu', _boundContextMenu);
    }

    _leftCanvas  = leftCanvas;
    _rightCanvas = rightCanvas;
    _suggEl      = suggEl;
    _linksEl     = linksEl;
    _pendingLeft = null;
    _editSelection = null;
    _drawState   = null;
    _guideY      = null;
    _colorSeq    = 0;
    _linkColorMap.clear();
    _destroyed   = false;

    _leftCanvas.addEventListener('mousedown',  _boundLeftDown);
    _rightCanvas.addEventListener('mousedown', _boundRightDown);
    _leftCanvas.addEventListener('mousemove',  _boundLeftMove);
    _rightCanvas.addEventListener('mousemove', _boundRightMove);
    _leftCanvas.addEventListener('mouseleave', _boundHidemag);
    _rightCanvas.addEventListener('mouseleave', _boundHidemag);
    _leftCanvas.addEventListener('wheel',      _boundWheel, { passive: false });
    _rightCanvas.addEventListener('wheel',     _boundWheel, { passive: false });
    _leftCanvas.addEventListener('contextmenu',  _boundContextMenu);
    _rightCanvas.addEventListener('contextmenu', _boundContextMenu);

    if (!_winUpAttached) {
      window.addEventListener('mouseup', _boundWinUp);
      _winUpAttached = true;
    }
    _listenersAttached = true;
  }

  // ── Edit actions (called from app.js keyboard + toolbar) ───────────────────

  function changeSelectedClass(key) {
    if (!_editSelection) return false;
    const classId = parseInt(key, 10) - 1;
    if (classId < 0 || classId > 3) return false;
    // Propagate to all confirmed-cluster members so paired bboxes stay class-consistent.
    ActiveSession.setBboxClass(_editSelection.sideIdx, _editSelection.bboxId, classId);
    _renderPair();
    return true;
  }

  function deleteSelected() {
    if (!_editSelection) return false;
    const { sideIdx, bboxId } = _editSelection;
    ActiveSession.removeBbox(sideIdx, bboxId);
    if (_pendingLeft === bboxId) _pendingLeft = null;
    _editSelection = null;
    _renderPair();
    return true;
  }

  function getSelectedInfo() {
    if (!_editSelection) return null;
    const session = ActiveSession.get();
    if (!session) return null;
    const side = session.sides[_editSelection.sideIdx];
    const bbox = side && side.bboxes.find(b => b.id === _editSelection.bboxId);
    if (!bbox) return null;
    return {
      sideIdx: _editSelection.sideIdx,
      sideLabel: TREE_SIDE_LABELS[_editSelection.sideIdx],
      bboxId: bbox.id,
      className: bbox.className,
      classId: bbox.classId,
    };
  }

  function getMagnifierEnabled() { return _magEnabled; }

  function setMagnifierEnabled(v) {
    _magEnabled = !!v;
    if (!_magEnabled) _hideMagnifier();
  }

  function getSuggestionsVisible() { return _showSuggestions; }

  function setSuggestionsVisible(v) {
    _showSuggestions = !!v;
    _renderPair();
  }

  function showPair(pairIndex, direction = null) {
    _pendingLeft = null;
    _editSelection = null;
    _drawState = null;
    const canvasesEl = document.querySelector('.dedup-canvases');
    if (direction && canvasesEl) {
      // slide-left for → (content exits left, new enters right)
      // slide-right for ← (content exits right, new enters left)
      const animClass = direction === 'right' ? 'slide-left' : 'slide-right';
      canvasesEl.classList.add(animClass);
      // Swap content at midpoint when opacity = 0 (110ms into 280ms animation)
      setTimeout(() => {
        _pairIndex = pairIndex;
        _renderPair();
      }, 110);
      setTimeout(() => canvasesEl.classList.remove(animClass), 280);
    } else {
      _pairIndex = pairIndex;
      _renderPair();
    }
  }

  function refresh() { _renderPair(); }

  function destroy() {
    _destroyed = true;
    _leftImage = null; _rightImage = null;
    _leftTr = null; _rightTr = null;
    _hideMagnifier();
  }

  function getPairLabels() {
    return (window.ADJACENT_PAIRS || []).map(([a, b]) => [
      (window.TREE_SIDE_LABELS || [])[a] || `Side ${a + 1}`,
      (window.TREE_SIDE_LABELS || [])[b] || `Side ${b + 1}`,
    ]);
  }
  function getCurrentPair() { return _pairIndex; }

  return {
    init, showPair, refresh, destroy, getPairLabels, getCurrentPair,
    changeSelectedClass, deleteSelected, getSelectedInfo,
    getMagnifierEnabled, setMagnifierEnabled,
    getSuggestionsVisible, setSuggestionsVisible,
  };
})();

window.DedupUI = DedupUI;
