'use strict';

document.addEventListener('DOMContentLoaded', () => {

  // ── Elements ───────────────────────────────────────────────────────────────
  const inputFolder      = document.getElementById('input-folder');
  const inputSession     = document.getElementById('input-session');
  const btnLoadFolder    = document.getElementById('btn-load-folder');
  const btnLoadFolderHero= document.getElementById('btn-load-folder-hero');
  const btnLoadSession   = document.getElementById('btn-load-session');
  const btnCaptureTree     = document.getElementById('btn-capture-tree');
  const btnCaptureTreeHero = document.getElementById('btn-capture-tree-hero');
  const treeNav          = document.getElementById('tree-nav');
  const treeSelect       = document.getElementById('tree-select');
  const treeSplit        = document.getElementById('tree-split');
  const treeSides        = document.getElementById('tree-sides');
  const treeCounter      = document.getElementById('tree-counter');
  const btnPrevTree      = document.getElementById('btn-prev-tree');
  const btnNextTree      = document.getElementById('btn-next-tree');
  const treeSaveStatus   = document.getElementById('tree-save-status');
  const saveCounter      = document.getElementById('save-counter');
  const btnSaveOutput    = document.getElementById('btn-save-output');

  // Mismatch resolve modal
  const modalMismatch    = document.getElementById('modal-mismatch');
  const mismatchBody     = document.getElementById('mismatch-body');
  const btnMismatchCancel= document.getElementById('btn-mismatch-cancel');
  const btnMismatchConfirm=document.getElementById('btn-mismatch-confirm');

  // Project config modal elements
  const modalProjectCfg  = document.getElementById('modal-project-config');
  const cfgOutputDirName = document.getElementById('cfg-output-dir-name');
  const cfgLabelsDirName = document.getElementById('cfg-labels-dir-name');
  const cfgFsWarning     = document.getElementById('cfg-fs-warning');
  const btnPickOutputDir = document.getElementById('btn-pick-output-dir');
  const btnPickLabelsDir = document.getElementById('btn-pick-labels-dir');
  const btnClearLabelsDir= document.getElementById('btn-clear-labels-dir');
  const btnCfgConfirm    = document.getElementById('btn-cfg-confirm');
  const toastContainer   = document.getElementById('toast-container');

  const emptyState       = document.getElementById('empty-state');
  const editorArea       = document.getElementById('editor-area');
  const homeView         = document.getElementById('home-view');
  const btnHome          = document.getElementById('btn-home');

  const tabs             = document.querySelectorAll('.tab');
  const panels           = document.querySelectorAll('.tab-panel');
  const panelCarousel    = document.getElementById('panel-carousel');

  const sidePillsContainer = document.getElementById('side-pills');
  let   sidePills          = []; // rebuilt dynamically per tree
  const editorCanvas     = document.getElementById('editor-canvas');
  const canvasPlaceholder= document.getElementById('canvas-placeholder');
  const bboxCount        = document.getElementById('bbox-count');
  const btnDeleteBbox        = document.getElementById('btn-delete-bbox');
  const btnDetectSide        = document.getElementById('btn-detect-side');
  const btnToggleBoxes       = document.getElementById('btn-toggle-boxes');
  const classBtns            = document.querySelectorAll('.btn-class');

  const btnPrevPair      = document.getElementById('btn-prev-pair');
  const btnNextPair      = document.getElementById('btn-next-pair');
  const dedupPairLabel   = document.getElementById('dedup-pair-label');
  const dedupLeftLabel   = document.getElementById('dedup-left-label');
  const dedupRightLabel  = document.getElementById('dedup-right-label');
  const btnRunSuggestions= document.getElementById('btn-run-suggestions');
  const dedupLeftCanvas  = document.getElementById('dedup-left-canvas');
  const dedupRightCanvas = document.getElementById('dedup-right-canvas');
  const dedupSuggestionsEl = document.getElementById('dedup-suggestions');
  const dedupLinksEl     = document.getElementById('dedup-links');
  const btnToggleDedupSuggestions= document.getElementById('btn-toggle-dedup-suggestions');

  const fileInfo         = document.getElementById('file-info');
  const treeQualityCard  = document.getElementById('tree-quality-card');
  const treeQualityBadge = document.getElementById('tree-quality-badge');
  const treeQualityMetrics = document.getElementById('tree-quality-metrics');
  const treeQualityIssues  = document.getElementById('tree-quality-issues');

  const btnCompute       = document.getElementById('btn-compute');
  const exportButtons    = document.getElementById('export-buttons');
  const btnExportYolo    = document.getElementById('btn-export-yolo');
  const btnExportJSON    = document.getElementById('btn-export-json');
  const btnExportCSV     = document.getElementById('btn-export-csv');
  const btnExportIdentity = document.getElementById('btn-export-identity');
  const resultsContainer = document.getElementById('results-container');

  // ── State ──────────────────────────────────────────────────────────────────
  let _currentSide = 0;
  let _currentPair = 0;
  let _editor = null;
  let _dedupInitialized = false;
  let _lastResult = null;
  let _pendingTrees = null;  // trees waiting for config modal confirmation
  let _autoSaving = false;   // prevent re-entrant auto-save
  let _touchDefaultApplied = false; // one-time carousel default on touch
  let _busy = false;
  let _loadSeq = 0;
  let _opQueue = Promise.resolve();
  const _savedSnapshotSignatures = new Map();

  // ── View routing: Sessions home ⇄ annotation editor ─────────────────────────
  // The capture-first landing is the Sessions home (stats + resumable sessions),
  // rendered by SessionsUI into #home-view. Loading a folder, a session JSON, or
  // opening a pohon switches to the annotation editor; the header Home button
  // returns to the session a pohon was opened from (its tree list), or to the
  // sessions home when the editor wasn't entered from a session.

  // The session a pohon was opened from, so the editor's Home button can return
  // to that session's tree list instead of the top-level session chooser. Null
  // when the editor was entered some other way (Load Folder / Load JSON).
  let _activeSessionId = null;

  // Show the annotation workspace (hide home + empty-state).
  function _enterEditorView() {
    if (homeView) homeView.classList.add('hidden');
    document.body.classList.remove('is-home');
    // On touch devices the carousel is the whole annotate screen: hide the
    // desktop tabs + header tree-nav (revealed on demand via the carousel's
    // "More" button). CSS keys off body.crsl-shell.
    if (_isTouchShell()) document.body.classList.add('crsl-shell');
    emptyState.classList.add('hidden');
    editorArea.classList.remove('hidden');
  }

  function _isTouchShell() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  // Show the Sessions home and (re)render it.
  async function _showHome() {
    _activeSessionId = null;
    document.body.classList.remove('crsl-shell', 'crsl-show-tabs');
    editorArea.classList.add('hidden');
    emptyState.classList.add('hidden');
    if (homeView) homeView.classList.remove('hidden');
    document.body.classList.add('is-home');
    if (window.SessionsUI) {
      try { await SessionsUI.showHome(); } catch (e) { console.warn('[Home] render failed:', e); }
    }
  }

  // Return to a specific session's detail view (its tree list). Falls back to
  // the sessions home if the detail can't be rendered.
  async function _showSessionDetail(id) {
    if (!id || !(window.SessionsUI && SessionsUI.showDetail)) return _showHome();
    document.body.classList.remove('crsl-shell', 'crsl-show-tabs');
    editorArea.classList.add('hidden');
    emptyState.classList.add('hidden');
    if (homeView) homeView.classList.remove('hidden');
    document.body.classList.add('is-home');
    try {
      await SessionsUI.showDetail(id);
    } catch (e) {
      console.warn('[Home] session detail render failed:', e);
      await _showHome();
    }
  }

  // The editor's Home button: back to the owning session when we came from one,
  // otherwise to the sessions home.
  function _onHomeButton() {
    if (_activeSessionId) return _showSessionDetail(_activeSessionId);
    return _showHome();
  }

  // Android hardware/gesture Back entry point. MainActivity calls this before it
  // lets Android finish the Activity, so the SPA can go editor → session detail
  // → home, or close transient overlays, instead of exiting immediately.
  window.PalmAnnotateHandleBack = function () {
    const modal = document.querySelector('.pa-modal');
    if (modal) {
      const cancel = modal.querySelector('button');
      if (cancel) cancel.click();
      return true;
    }
    const captureOverlay = document.querySelector('.capture-overlay');
    if (captureOverlay) {
      const cancel = captureOverlay.querySelector('.capture-btn--ghost');
      if (cancel) cancel.click();
      return true;
    }
    if (modalProjectCfg && !modalProjectCfg.classList.contains('hidden')) {
      modalProjectCfg.classList.add('hidden');
      return true;
    }
    if (modalMismatch && !modalMismatch.classList.contains('hidden')) {
      if (btnMismatchCancel) btnMismatchCancel.click();
      else modalMismatch.classList.add('hidden');
      return true;
    }
    if (editorArea && !editorArea.classList.contains('hidden')) {
      _onHomeButton();
      return true;
    }
    if (homeView && !homeView.classList.contains('hidden') && window.SessionsUI && SessionsUI.handleBack) {
      return !!SessionsUI.handleBack();
    }
    return false;
  };

  // Photograph one pohon for a session (locked variety+blok, auto/manual id).
  // Mirrors _startCapture's persistence but returns the tree to SessionsUI so it
  // can record it in the session index. Returns the datasetTree or null.
  async function _capturePohon(session) {
    const tree = await CaptureFlow.start({
      sideCount: session.sideCount,
      session: {
        variety: session.variety,
        blok: session.blok,
        treeId: session.nextId,
        autoId: session.autoId,
        sideCount: session.sideCount,
        operator: session.operator || '',
      },
    });
    if (!tree) return null;
    // Surface a silent persist failure: on native every side should have come
    // back with an imageUri from the storage adapter. If none did, the photos
    // didn't reach disk and the tree would show "Image unavailable" — tell the
    // operator rather than recording a broken pohon without a word.
    if (Storage.isNative()) {
      const persisted = (tree.sides || []).filter(s => s && s.imageUri).length;
      if (persisted === 0) {
        _showToast('Photos could not be saved to storage — check device space/permissions', 'error');
      } else if (persisted < (tree.sides || []).length) {
        _showToast(`Only ${persisted}/${tree.sides.length} photos saved`, 'error');
      }
    }
    DatasetManager.addCapturedTree(tree);
    // Persist the flat captured-tree registry so the pohon survives a restart
    // (image files already live on disk; the session index references by name).
    if (Storage.isNative() && window.SessionStore) {
      SessionStore.addCapturedTree({
        name: tree.name, split: tree.split, metadata: tree.metadata, sides: tree.sides,
      }).catch(e => console.warn('[Capture] persist registry failed:', e));
    }
    return tree;
  }

  // Open a captured pohon (by tree name) in the annotation pipeline. The
  // optional sessionId lets the editor's Home button return to that session's
  // tree list (see _onHomeButton).
  async function _openPohonByName(name, sessionId) {
    _activeSessionId = sessionId || null;
    const idx = DatasetManager.findByName(name);
    if (idx === -1) {
      _showToast('Tree not found in dataset — capture it again', 'error');
      return;
    }
    _enterEditorView();
    treeNav.classList.remove('hidden');
    _populateTreeSelect(DatasetManager.getTrees());
    DatasetManager.goTo(idx);
    _setBusy(true, 'Loading...');
    try { await _loadCurrentTree(); } finally { _setBusy(false); }
    _updateSaveCounter();
    await _autoDetectCurrentTree();
  }

  // ── Single-screen carousel: hooks + tree-capture loop (native field flow) ───

  // Hooks the carousel renders into its compact topbar (Home / browse / More)
  // and bottom action row (Detect again / Next tree / Save & exit).
  function _carouselHooks() {
    return {
      onHome: () => _onHomeButton(),
      onMore: () => _openMoreMenu(),
      onBrowsePrev: () => _navigateTree('prev'),
      onBrowseNext: () => _navigateTree('next'),
      onDetect: () => _detectCurrentSide(),
      onNextTree: () => _nextTreeFlow(),
      onSaveExit: () => _saveAndExit(),
      treeLabel: () => { const t = DatasetManager.getTree(); return t ? t.name : ''; },
    };
  }

  function _initCarousel() {
    if (!(window.CarouselUI && panelCarousel)) return;
    CarouselUI.init(panelCarousel, { hooks: _carouselHooks() });
  }

  // The carousel "More" button reveals the legacy tabs (Annotation Editor /
  // Deduplication / Results) for power users on the single annotate screen.
  function _toggleMoreTabs() {
    document.body.classList.toggle('crsl-show-tabs');
  }

  // "More" action sheet on the single annotate screen: open the raw depth/JSON
  // viewer for the current tree, or reveal the legacy editor tabs. Built/removed
  // here so it never leaks into the rest of the shell.
  function _openMoreMenu() {
    const existing = document.querySelector('.more-menu');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'capture-overlay more-menu';
    const sheet = document.createElement('div');
    sheet.className = 'more-menu__sheet';

    const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };

    const mkBtn = (label, sub, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'more-menu__item';
      const t = document.createElement('span');
      t.className = 'more-menu__item-label';
      t.textContent = label;
      b.appendChild(t);
      if (sub) {
        const s = document.createElement('span');
        s.className = 'more-menu__item-sub';
        s.textContent = sub;
        b.appendChild(s);
      }
      b.addEventListener('click', () => { close(); onClick(); });
      return b;
    };

    sheet.appendChild(mkBtn('Depth & raw viewer', 'Inspect captured .raw depth + JSON', () => {
      const tree = window.DatasetManager && DatasetManager.getTree && DatasetManager.getTree();
      if (!tree) { _showToast('Open a tree first to inspect its depth.', 'info'); return; }
      if (window.DepthViewer && DepthViewer.open) DepthViewer.open(tree);
      else _showToast('Depth viewer unavailable.', 'error');
    }));

    sheet.appendChild(mkBtn('Editor tools', 'Show / hide annotation, dedup & results tabs', () => {
      _toggleMoreTabs();
    }));

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'capture-btn capture-btn--ghost more-menu__cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    sheet.appendChild(cancel);

    overlay.appendChild(sheet);
    // Tapping the backdrop (outside the sheet) dismisses the menu.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  // Record a freshly-captured pohon into the owning session's index. The photos
  // and the captured registry were already persisted by _capturePohon.
  async function _recordPohonInSession(sessionId, tree) {
    if (!sessionId || !window.SessionStore) return;
    try {
      await SessionStore.addTreeToSession(sessionId, {
        name: tree.name, treeId: tree.treeId, sideCount: tree.sideCount,
        metadata: tree.metadata, sides: tree.sides,
      });
    } catch (e) { console.warn('[NextTree] addTreeToSession failed:', e); }
  }

  // Capture the next pohon for the active session, then open it in the carousel.
  async function _captureNextForSession(sessionId) {
    if (!window.SessionStore) { await _startCapture(); return; }
    let session = null;
    try { session = await SessionStore.getSession(sessionId); } catch (_) {}
    if (!session) { _showToast('Session unavailable; capture from the tree list.', 'error'); return; }
    const tree = await _capturePohon(session);
    if (!tree) {
      // Cancelled at the camera. Return to the owning session's tree list —
      // NOT the previous tree's annotation (which is what staying put would
      // show, since Next tree already saved + left that tree behind).
      await _showSessionDetail(sessionId);
      return;
    }
    await _recordPohonInSession(sessionId, tree);
    _showToast(`Captured ${tree.name} (${tree.sides.length} views)`, 'success');
    await _openPohonByName(tree.name, sessionId);
  }

  // "Next tree": compute & mark the current tree complete first (the chosen
  // behavior — may surface the class-mismatch resolver), then jump straight into
  // capturing the next tree and open it for annotation.
  function _nextTreeFlow() {
    return _enqueueOperation(async () => {
      const session = ActiveSession.get();
      if (session) {
        const ok = await _resolveMismatchesIfAny();
        if (!ok) { _showToast('Next tree cancelled: resolve class mismatches first.', 'info'); return; }
        _setBusy(true, 'Saving...');
        try {
          const snapshot = _cloneSessionSnapshot();
          if (snapshot) {
            _lastResult = Results.compute(snapshot);
            Results.render(_lastResult, resultsContainer);
            exportButtons.classList.remove('hidden');
            await _saveCurrentTreeOutput({ recompute: false, allowDirty: true, markConfirmed: true, snapshot });
          }
        } finally {
          _setBusy(false);
        }
      }
      if (_activeSessionId) await _captureNextForSession(_activeSessionId);
      else await _startCapture();
    });
  }

  // "Save & exit": persist the current tree's progress WITHOUT forcing mismatch
  // resolution (so a tired operator can stop mid-tree), then return to the
  // owning session's tree list (or the sessions home).
  function _saveAndExit() {
    return _enqueueOperation(async () => {
      const session = ActiveSession.get();
      if (session) {
        _setBusy(true, 'Saving...');
        try {
          await _saveCurrentTreeOutput({ recompute: true, allowDirty: true, allowDownload: false });
        } catch (e) {
          console.warn('[SaveExit] save failed:', e);
        } finally {
          _setBusy(false);
        }
      }
      if (_activeSessionId) await _showSessionDetail(_activeSessionId);
      else await _showHome();
    });
  }

  // ── Dataset loading ────────────────────────────────────────────────────────

  function _onFolderLoad(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const trees = DatasetManager.load(files);
    _onTreesLoaded(trees);
    inputFolder.value = '';
  }

  // Shared post-load handling for both the web (<input webkitdirectory>) and
  // native (Storage adapter) dataset sources.
  function _onTreesLoaded(trees) {
    // Folder/JSON loads aren't scoped to a SessionsUI session, so the editor's
    // Home button should return to the session chooser, not a stale session.
    _activeSessionId = null;
    if (!trees || trees.length === 0) {
      alert('No trees found. Make sure the folder contains image files named NAME_1.jpg through NAME_N.jpg (N is the side count, usually 4 or 8).');
      return;
    }
    // Debug: summary of detected side counts across trees
    const sideHistogram = {};
    trees.forEach(t => {
      const n = (t.sides || []).length;
      sideHistogram[n] = (sideHistogram[n] || 0) + 1;
    });
    console.log('[Dataset] Loaded', trees.length, 'tree(s). Side histogram:', sideHistogram);

    // Store trees and show config modal before proceeding
    _pendingTrees = trees;
    _showProjectConfigModal(trees);
  }

  // Native (Android): load the dataset from the fixed app-external
  // PalmAnnotate working store via the Capacitor adapter instead of an
  // <input webkitdirectory>.
  async function _loadFolderNative() {
    try {
      const trees = await DatasetManager.loadFromAdapter();
      _onTreesLoaded(trees);
    } catch (e) {
      console.error('[Dataset] native load failed:', e);
      alert('Failed to read the dataset folder: ' + ((e && e.message) || e));
    }
  }

  // Entry point for the Load Folder buttons: branch on platform.
  function _triggerLoadFolder() {
    if (Storage.isNative()) {
      _loadFolderNative();
    } else {
      inputFolder.click();
    }
  }

  // ── Capture-first flow (Phase 2) ─────────────────────────────────────────
  // Photograph one tree (4 views) with the built-in camera, then load it into
  // the session like any folder/native tree. Coexists with Load Folder.
  let _capturing = false;
  async function _startCapture() {
    if (_capturing) return;
    _capturing = true;
    _activeSessionId = null; // freeform capture isn't tied to a SessionsUI session
    if (btnCaptureTree) btnCaptureTree.disabled = true;
    try {
      const tree = await CaptureFlow.start({ sideCount: 4 });
      if (!tree) return; // user cancelled
      const idx = DatasetManager.addCapturedTree(tree);
      // Persist the captured-tree registry so it survives an app restart
      // (image files already live on disk under app-external PalmAnnotate/dataset).
      if (Storage.isNative() && window.SessionStore) {
        SessionStore.addCapturedTree({
          name: tree.name, split: tree.split, metadata: tree.metadata, sides: tree.sides,
        }).catch(e => console.warn('[Capture] persist registry failed:', e));
        if (tree.metadata) {
          SessionStore.setSettings({
            operator: tree.metadata.operator, defaultVariety: tree.metadata.variety,
          }).catch(() => {});
        }
      }
      // Show the workspace + tree nav and load the captured tree through the
      // same render path used after a folder load.
      _enterEditorView();
      treeNav.classList.remove('hidden');
      _populateTreeSelect(DatasetManager.getTrees());
      DatasetManager.goTo(idx);
      _setBusy(true, 'Loading...');
      try {
        await _loadCurrentTree();
      } finally {
        _setBusy(false);
      }
      _updateSaveCounter();
      _showToast(`Captured ${tree.name} (${tree.sides.length} views)`, 'success');
      // Phase 3: auto-detect FFB on the freshly captured sides (over-detect,
      // detect-only). Non-blocking and silently skipped when no model is present.
      await _autoDetectCurrentTree();
    } catch (e) {
      console.error('[Capture] failed:', e);
      _showToast('Capture failed: ' + ((e && e.message) || e), 'error');
    } finally {
      _capturing = false;
      if (btnCaptureTree) btnCaptureTree.disabled = false;
    }
  }

  // Restore on-device captured trees from the persistent registry so they
  // survive an app restart (native only — the image files persist on disk).
  // This only repopulates DatasetManager so a pohon can be reopened by name
  // from the Sessions home; it does NOT switch into the editor (the home is the
  // landing view — see _bootView).
  async function _restoreCapturedTrees() {
    if (!Storage.isNative() || !window.SessionStore) return;
    let registry = [];
    try { registry = await SessionStore.getCapturedRegistry(); } catch (_) { registry = []; }
    if (!registry.length) return;
    for (const t of registry) {
      if (DatasetManager.findByName(t.name) !== -1) continue; // already present
      DatasetManager.addCapturedTree({
        name: t.name,
        split: t.split || 'field',
        metadata: t.metadata || {},
        sides: (t.sides || []).map((s, i) => ({
          imageFile: { name: `${t.name}_${i + 1}.jpg` }, labelFile: null,
          imageUri: s.imageUri || null, labelUri: s.labelUri || null,
          depthFile: s.depthUri ? { name: `${t.name}_${i + 1}.raw` } : null,
          depthUri: s.depthUri || null,
          depthPath: s.depthPath || null,
          depth: s.depth || null,
          cacheBust: s.cacheBust || null,
        })),
      });
    }
    if (DatasetManager.count() > 0) {
      _populateTreeSelect(DatasetManager.getTrees());
      // Important after app restart: ProjectConfig saved handles are in-memory,
      // while Output JSON/TXT files are on disk. Re-scan native output now so
      // opening a session pohon resumes the saved JSON instead of starting from
      // the raw captured photo again.
      try { await _scanOutputDirectory(); } catch (e) { console.warn('[Restore] output scan failed:', e); }
    }
  }

  // ── On-device detection (Phase 3) ────────────────────────────────────────
  let _detectWarned = false;

  // Auto-detect FFB on every side of the current tree that has no boxes yet.
  // Over-detect + detect-only: boxes default to B2 for the expert to re-label.
  async function _autoDetectCurrentTree() {
    if (!window.Detector) return;
    let available = false;
    try { available = await Detector.isAvailable(); } catch (_) { available = false; }
    if (!available) {
      if (!_detectWarned) {
        _detectWarned = true;
        _showToast('On-device detection unavailable (drop a model in models/).', 'info');
      }
      return;
    }
    const session = ActiveSession.get();
    if (!session) return;
    _setBusy(true, 'Detecting...');
    let total = 0;
    try {
      for (const side of session.sides) {
        if (side.bboxes && side.bboxes.length) continue;       // only empty sides
        if (!side.imageWidth || !side.imageHeight) continue;    // need dimensions
        const boxes = await Detector.detectForSide(side);
        if (boxes && boxes.length) {
          side.bboxes = boxes;
          side.originalBboxes = boxes.map(b => ({ ...b }));
          session.dirty = true;
          total += boxes.length;
        }
      }
    } catch (e) {
      console.warn('[Detect] auto-detect failed:', e);
    } finally {
      _setBusy(false);
    }
    _initEditor(_currentSide);
    _updateBboxCount(_currentSide);
    if (_activeTab() === 'carousel' && window.CarouselUI) CarouselUI.refresh();
    if (total > 0) _showToast(`Detected ${total} bunch(es) — review & re-label`, 'success');
  }

  // Manual re-detect for the side currently shown in the editor.
  async function _detectCurrentSide() {
    if (!window.Detector) return;
    const session = ActiveSession.get();
    if (!session) return;
    const side = session.sides[_currentSide];
    if (!side || !side.imageWidth) return;
    let available = false;
    try { available = await Detector.isAvailable(); } catch (_) { available = false; }
    if (!available) { _showToast('On-device detection unavailable (no model in models/).', 'info'); return; }
    _setBusy(true, 'Detecting...');
    try {
      const boxes = await Detector.detectForSide(side);
      if (boxes && boxes.length) {
        // Append to any existing boxes so a re-detect never silently wipes edits.
        side.bboxes = side.bboxes.concat(boxes);
        session.dirty = true;
        _showToast(`Detected ${boxes.length} bunch(es) on ${side.label}`, 'success');
      } else {
        _showToast('No bunches detected on this side.', 'info');
      }
    } catch (e) {
      console.warn('[Detect] side detect failed:', e);
      _showToast('Detection failed; see console.', 'error');
    } finally {
      _setBusy(false);
    }
    _initEditor(_currentSide);
    _updateBboxCount(_currentSide);
    if (_activeTab() === 'carousel' && window.CarouselUI) CarouselUI.refresh();
  }

  // ── Project Config Modal ─────────────────────────────────────────────────

  function _showProjectConfigModal(trees) {
    ProjectConfig.reset();

    // FS API warning
    if (!ProjectConfig.isFileSystemAccessSupported()) {
      cfgFsWarning.style.display = '';
      btnPickOutputDir.disabled = true;
      if (btnPickLabelsDir) btnPickLabelsDir.disabled = true;
    } else {
      cfgFsWarning.style.display = 'none';
      btnPickOutputDir.disabled = false;
      if (btnPickLabelsDir) btnPickLabelsDir.disabled = false;
    }

    cfgOutputDirName.textContent = 'Not selected';
    if (cfgLabelsDirName) cfgLabelsDirName.textContent = 'Not selected';
    modalProjectCfg.classList.remove('hidden');
  }

  btnPickOutputDir.addEventListener('click', async () => {
    const ok = await ProjectConfig.pickOutputDirectory();
    if (ok) {
      cfgOutputDirName.textContent = ProjectConfig.get().outputDirName;
    }
  });

  if (btnPickLabelsDir) {
    btnPickLabelsDir.addEventListener('click', async () => {
      const ok = await ProjectConfig.pickLabelsDirectory();
      if (ok && cfgLabelsDirName) {
        cfgLabelsDirName.textContent = ProjectConfig.get().labelsDirName;
      }
    });
  }
  if (btnClearLabelsDir) {
    btnClearLabelsDir.addEventListener('click', () => {
      ProjectConfig.clearLabelsDirectory();
      if (cfgLabelsDirName) cfgLabelsDirName.textContent = 'Not selected';
    });
  }

  btnCfgConfirm.addEventListener('click', async () => {
    modalProjectCfg.classList.add('hidden');

    if (!_pendingTrees) return;

    // Discover prior saves before rendering the dropdown so ✓ marks appear immediately.
    const matched = await _scanOutputDirectory();
    if (matched > 0) _showToast(`Restored ${matched} tree(s) from the output folder`, 'success');

    _populateTreeSelect(_pendingTrees);
    treeNav.classList.remove('hidden');
    _updateSaveCounter();
    _setBusy(true, 'Loading...');
    try {
      await _loadCurrentTree();
    } finally {
      _setBusy(false);
    }
    _pendingTrees = null;
  });

  function _populateTreeSelect(trees) {
    treeSelect.innerHTML = '';
    trees.forEach((t, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      const saved = ProjectConfig.isSaved(t.name);
      opt.textContent = (saved ? '\u2713 ' : '   ') + t.name;
      if (saved) opt.classList.add('option-saved');
      treeSelect.appendChild(opt);
    });
    treeSelect.value = DatasetManager.getIndex();
    _updateTreeCounter();
  }

  function _refreshTreeSelectOption(treeIdx) {
    const opt = treeSelect.options[treeIdx];
    if (!opt) return;
    const t = DatasetManager.getTrees()[treeIdx];
    if (!t) return;
    const saved = ProjectConfig.isSaved(t.name);
    opt.textContent = (saved ? '\u2713 ' : '   ') + t.name;
    opt.classList.toggle('option-saved', saved);
  }

  function _updateTreeCounter() {
    const idx = DatasetManager.getIndex();
    const total = DatasetManager.count();
    treeCounter.textContent = `${idx + 1} / ${total}`;
    treeSelect.value = idx;

    const tree = DatasetManager.getTree();
    if (treeSplit) treeSplit.textContent = tree ? (tree.split || 'unknown') : '';
    if (treeSides) {
      const nSides = tree && tree.sides ? tree.sides.length : 0;
      treeSides.textContent = nSides ? `${nSides} views` : '';
    }
  }

  function _setBusy(flag, label = 'Working...') {
    _busy = !!flag;
    const disabled = !!flag;
    for (const el of [btnPrevTree, btnNextTree, treeSelect, btnCompute, btnSaveOutput]) {
      if (el) el.disabled = disabled;
    }
    if (disabled && treeSaveStatus) {
      treeSaveStatus.classList.remove('hidden');
      treeSaveStatus.textContent = label;
      treeSaveStatus.title = label;
    } else {
      _updateSaveStatus();
    }
  }

  function _enqueueOperation(fn) {
    _opQueue = _opQueue.catch(() => {}).then(fn);
    return _opQueue;
  }

  function _cloneSessionSnapshot() {
    const snapshot = ActiveSession.toJSON ? ActiveSession.toJSON() : null;
    return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
  }

  function _snapshotSignature(snapshot) {
    return JSON.stringify({
      treeName: snapshot.treeName,
      split: snapshot.split,
      sides: snapshot.sides,
      confirmedLinks: snapshot.confirmedLinks,
    });
  }

  function _treeStemFromFilename(filename) {
    return String(filename || '').replace(/\.[^.]+$/, '').replace(/_[1-9]\d?$/, '');
  }

  function _fileStem(filename) {
    return String(filename || '').replace(/\.[^.]+$/, '');
  }

  function _getDatasetTreeByName(treeName) {
    const idx = DatasetManager.findByName(treeName);
    if (idx < 0) return null;
    return DatasetManager.getTrees()[idx] || null;
  }

  function _qualityReport(opts = {}) {
    if (!window.QualityCheck || !QualityCheck.analyzeTree) return null;
    const session = opts.session || ActiveSession.get();
    const tree = opts.tree || (session ? _getDatasetTreeByName(session.treeName) : DatasetManager.getTree());
    let mismatches = [];
    try { mismatches = ActiveSession.getMismatchedClusters ? ActiveSession.getMismatchedClusters() : []; } catch (_) { mismatches = []; }
    return QualityCheck.analyzeTree(tree, session, {
      result: opts.result !== undefined ? opts.result : _lastResult,
      mismatches,
    });
  }

  function _renderQualityPanel() {
    if (!treeQualityCard || !treeQualityBadge || !treeQualityMetrics || !treeQualityIssues) return;
    const report = _qualityReport();
    if (!report) {
      treeQualityCard.classList.add('hidden');
      return;
    }
    treeQualityCard.classList.remove('hidden');
    treeQualityCard.classList.remove('quality-card--ok', 'quality-card--warn', 'quality-card--error');
    treeQualityCard.classList.add(`quality-card--${report.status}`);
    treeQualityBadge.textContent = report.status === 'ok' ? 'OK' : (report.status === 'error' ? 'Fix' : 'Check');
    const m = report.metrics || {};
    treeQualityMetrics.innerHTML = '';
    const chips = [
      `${m.imageSides || 0}/${m.expectedSides || 0} views`,
      `${m.depthSides || 0} depth`,
      `${m.totalBoxes || 0} bbox`,
      `${m.links || 0} links`,
    ];
    chips.forEach(txt => {
      const chip = document.createElement('span');
      chip.className = 'quality-chip';
      chip.textContent = txt;
      treeQualityMetrics.appendChild(chip);
    });
    treeQualityIssues.innerHTML = '';
    const issues = (report.issues || []).slice(0, 5);
    if (!issues.length) {
      const ok = document.createElement('p');
      ok.className = 'quality-issue quality-issue--ok';
      ok.textContent = 'Ready: view, metadata, annotation, and depth-pair checks look good.';
      treeQualityIssues.appendChild(ok);
    } else {
      issues.forEach(it => {
        const row = document.createElement('p');
        row.className = `quality-issue quality-issue--${it.level}`;
        row.textContent = it.message;
        treeQualityIssues.appendChild(row);
      });
      if ((report.issues || []).length > issues.length) {
        const more = document.createElement('p');
        more.className = 'quality-issue quality-issue--info';
        more.textContent = `+${report.issues.length - issues.length} more issue(s)`;
        treeQualityIssues.appendChild(more);
      }
    }
  }

  function _confirmQualityBeforeExport(label) {
    return new Promise((resolve) => {
      const report = _qualityReport();
      if (!report || report.status === 'ok') { resolve(true); return; }

      const overlay = document.createElement('div');
      overlay.className = 'pa-modal quality-modal';
      const panel = document.createElement('div');
      panel.className = 'quality-modal__panel';
      const title = document.createElement('h2');
      title.textContent = 'Dataset check before export';
      const desc = document.createElement('p');
      desc.className = 'quality-modal__desc';
      desc.textContent = `${label || 'Export'} can continue, but review these warnings first.`;
      panel.appendChild(title);
      panel.appendChild(desc);

      const metrics = document.createElement('div');
      metrics.className = 'quality-modal__metrics';
      const m = report.metrics || {};
      [`${m.imageSides || 0}/${m.expectedSides || 0} views`, `${m.depthSides || 0} depth`, `${m.totalBoxes || 0} bbox`, `${m.links || 0} links`].forEach(txt => {
        const chip = document.createElement('span'); chip.className = 'quality-chip'; chip.textContent = txt; metrics.appendChild(chip);
      });
      panel.appendChild(metrics);

      const list = document.createElement('div');
      list.className = 'quality-modal__issues';
      (report.issues || []).forEach(it => {
        const row = document.createElement('p');
        row.className = `quality-issue quality-issue--${it.level}`;
        row.textContent = it.message;
        list.appendChild(row);
      });
      panel.appendChild(list);

      const actions = document.createElement('div');
      actions.className = 'quality-modal__actions';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn btn--ghost';
      back.textContent = 'Back to fix';
      const cont = document.createElement('button');
      cont.type = 'button';
      cont.className = report.status === 'error' ? 'btn btn--outline' : 'btn btn--primary';
      cont.textContent = report.status === 'error' ? 'Export anyway' : 'Continue export';
      actions.appendChild(back);
      actions.appendChild(cont);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const done = (ok) => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(ok); };
      back.addEventListener('click', () => done(false));
      cont.addEventListener('click', () => done(true));
    });
  }

  function _validateOutputAgainstTree(outputJson, datasetTree) {
    if (!outputJson || !datasetTree) throw new Error('Missing output or dataset tree.');
    if (outputJson.tree_name !== datasetTree.name) {
      throw new Error(`Output tree mismatch: ${outputJson.tree_name} != ${datasetTree.name}`);
    }
    for (const [sideKey, imageInfo] of Object.entries(outputJson.images || {})) {
      const imageTree = _treeStemFromFilename(imageInfo.filename);
      const labelTree = _treeStemFromFilename(imageInfo.label_file);
      if (imageTree !== outputJson.tree_name) {
        throw new Error(`${sideKey} image belongs to ${imageTree}, not ${outputJson.tree_name}.`);
      }
      if (labelTree !== outputJson.tree_name) {
        throw new Error(`${sideKey} label belongs to ${labelTree}, not ${outputJson.tree_name}.`);
      }
      const expectedSideStem = `${outputJson.tree_name}_${imageInfo.side_index + 1}`;
      if (_fileStem(imageInfo.filename) !== expectedSideStem) {
        throw new Error(`${sideKey} image side mismatch: expected ${expectedSideStem}.`);
      }
      if (_fileStem(imageInfo.label_file) !== expectedSideStem) {
        throw new Error(`${sideKey} label side mismatch: expected ${expectedSideStem}.`);
      }
      if ((imageInfo.annotations || []).length !== imageInfo.bbox_count) {
        throw new Error(`${sideKey} annotation count does not match bbox_count.`);
      }
    }
  }

  function _countYoloLines(content) {
    if (!content || !content.trim()) return 0;
    return content.trim().split(/\r?\n/).filter(line => line.trim()).length;
  }

  async function _loadCurrentTree() {
    const loadToken = ++_loadSeq;
    const tree = DatasetManager.getTree();
    if (!tree) return;
    _enterEditorView();

    await ActiveSession.loadTree(tree);
    if (loadToken !== _loadSeq || DatasetManager.getTree() !== tree) return;


    // Lazy resume from output JSON if we previously saved this tree.
    let resumed = false;
    const savedHandle = ProjectConfig.getSavedHandle(tree.name);
    if (savedHandle) {
      try {
        const outputJson = await FsOutput.readJSON(savedHandle);
        if (loadToken !== _loadSeq || DatasetManager.getTree() !== tree) return;
        if (outputJson && outputJson.images && outputJson.bunches) {
          _validateOutputAgainstTree(outputJson, tree);
          const sessionJson = OutputSchema.toSessionJSON(outputJson);
          await ActiveSession.fromJSON(sessionJson, tree);
            if (loadToken !== _loadSeq || DatasetManager.getTree() !== tree) return;
            resumed = true;
          }
      } catch (e) {
        console.warn('[Resume] failed for', tree.name, e);
      }
    }

    console.log('[Tree]', tree.name, '->', tree.sides.length, 'sides, pairs:', (window.ADJACENT_PAIRS || []).length, resumed ? '(resumed)' : '');
    _lastResult = resumed ? Results.compute(ActiveSession.get()) : null;
    if (resumed) {
      Results.render(_lastResult, resultsContainer);
      exportButtons.classList.remove('hidden');
    } else {
      exportButtons.classList.add('hidden');
      resultsContainer.innerHTML = '';
    }

    _currentSide = 0;
    _currentPair = 0;
    _dedupInitialized = false;

    _rebuildSidePills();
    _activateSidePill(0);
    _initEditor(0);
    _updateTreeCounter();
    _updateSaveStatus();
    _renderQualityPanel();

    // Refresh dedup if that tab is visible
    if (_activeTab() === 'dedup') _initDedup();
    if (_activeTab() === 'results' && !resumed) { resultsContainer.innerHTML = ''; }
    // Rebuild the carousel for this tree when it is the visible tab.
    if (_activeTab() === 'carousel' && window.CarouselUI && panelCarousel) {
      _initCarousel();
    }

    // On touch devices, make the finger-first carousel the default surface the
    // first time a tree loads. Desktop keeps the classic editor tab.
    if (!_touchDefaultApplied) {
      _touchDefaultApplied = true;
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches &&
          window.CarouselUI && panelCarousel) {
        _activateTab('carousel');
      }
    }
  }

  // ── Tree navigation (with auto-save) ────────────────────────────────────

  async function _navigateTree(action) {
    if (_busy) return Promise.resolve();
    return _enqueueOperation(async () => {
      _setBusy(true, 'Saving...');
      const beforeIdx = DatasetManager.getIndex();
      try {
        const saved = await _autoSaveCurrentTree();
        if (saved === false) return;

        let ok = false;
        if (action === 'prev') ok = DatasetManager.prev();
        else if (action === 'next') ok = DatasetManager.next();
        else if (typeof action === 'number') ok = DatasetManager.goTo(action);
        if (!ok) {
          treeSelect.value = DatasetManager.getIndex();
          return;
        }

        _setBusy(true, 'Loading...');
        await _loadCurrentTree();
      } catch (e) {
        console.error('[Navigation] failed:', e);
        _showToast(`Navigation failed: ${e.message}`, 'error');
        DatasetManager.goTo(beforeIdx);
        treeSelect.value = DatasetManager.getIndex();
      } finally {
        _setBusy(false);
      }
    });
  }

  btnPrevTree.addEventListener('click', () => _navigateTree('prev'));
  btnNextTree.addEventListener('click', () => _navigateTree('next'));
  treeSelect.addEventListener('change', () => {
    const idx = parseInt(treeSelect.value, 10);
    _navigateTree(idx);
  });

  // ── Output folder scan (batch resume discovery) ─────────────────────────

  /**
   * Scan the chosen output directory for previously-saved tree JSON files
   * and register their handles with ProjectConfig for lazy resume.
   * Returns the number of trees matched.
   */
  async function _scanOutputDirectory() {
    if (!ProjectConfig.get().hasOutputDir) return 0;
    let map;
    try { map = await FsOutput.listOutputFiles(); }
    catch (e) { console.warn('[Resume] scan failed:', e); return 0; }
    let matched = 0;
    for (const [treeName, handle] of map) {
      if (DatasetManager.findByName(treeName) === -1) continue;
      ProjectConfig.setSavedHandle(treeName, handle);
      matched++;
    }
    console.log('[Resume] discovered', matched, 'saved tree(s) in output folder');
    return matched;
  }

  // ── Auto-save & Output ──────────────────────────────────────────────────

  /**
   * Auto-save the current tree's output JSON + corrected TXT before navigating.
   * Always writes — even if the annotator made no edits — so every visited tree
   * leaves an Output JSON and Output TXT on disk. This makes resume rules
   * deterministic (Output TXT exists ⇔ tree was visited).
   */
  async function _autoSaveCurrentTree() {
    if (_autoSaving) return true;
    const snapshot = _cloneSessionSnapshot();
    if (!snapshot) return true;
    const signature = _snapshotSignature(snapshot);
    if (!ActiveSession.isDirty() && _savedSnapshotSignatures.get(snapshot.treeName) === signature) {
      return true;
    }
    if (!ActiveSession.isDirty() && !_savedSnapshotSignatures.has(snapshot.treeName)) {
      return true;
    }
    if (!ProjectConfig.get().hasOutputDir) {
      _showToast('Auto-save skipped: choose an output JSON folder first.', 'info');
      return true;
    }

    // Force user to resolve class mismatches before persisting. If they cancel,
    // leave the session dirty — the prompt will return on the next save attempt.
    const ok = await _resolveMismatchesIfAny();
    if (!ok) {
      _showToast('Auto-save postponed: class mismatches are not resolved yet.', 'info');
      return false;
    }

    _autoSaving = true;
    try {
      await _saveCurrentTreeOutput({ allowDirty: true, snapshot, allowDownload: false, silent: true });
      return true;
    } finally {
      _autoSaving = false;
    }
  }

  /**
   * Compute results and save the output JSON for the current tree.
   */
  async function _saveCurrentTreeOutput(opts = {}) {
    const recompute = opts.recompute !== false;
    const allowDirty = !!opts.allowDirty;
    const markConfirmed = opts.markConfirmed === true;
    const allowDownload = opts.allowDownload !== false;
    const snapshot = opts.snapshot || _cloneSessionSnapshot();
    if (!snapshot) return false;
    const activeSession = ActiveSession.get();

    if (!recompute && !allowDirty && _lastResult && ActiveSession.isDirty()) {
      _showToast('Unsaved changes. Click "Compute & Mark Complete" first so output stays in sync.', 'info');
      return false;
    }

    // Compute results (union-find clustering) when needed
    let result = _lastResult;
    if (recompute || !result || !activeSession || activeSession.treeName !== snapshot.treeName) {
      result = Results.compute(snapshot);
      if (activeSession && activeSession.treeName === snapshot.treeName) _lastResult = result;
    }

    // Generate output JSON
    const datasetTree = _getDatasetTreeByName(snapshot.treeName);
    if (!datasetTree || datasetTree.name !== snapshot.treeName) {
      _showToast(`Save blocked: dataset tree mismatch for ${snapshot.treeName}.`, 'error');
      return false;
    }
    const outputJson = OutputSchema.generate(snapshot, result, datasetTree);
    try {
      _validateOutputAgainstTree(outputJson, datasetTree);
    } catch (e) {
      _showToast(`Save blocked: ${e.message}`, 'error');
      console.error('[Output] validation failed:', e);
      return false;
    }

    // Save to output folder or download.
    // Filename is canonical (tree_name only) so re-saves overwrite in place
    // instead of producing duplicates with shifting tree_id counters.
    const filename = `${snapshot.treeName}.json`;
    const saveResult = await FsOutput.saveJSON(filename, outputJson, { allowDownload });

    if (saveResult.ok) {
      // Only flip the "confirmed done" flag (green checkmark + counter) when
      // the user explicitly clicked "Compute & Mark Complete". Auto-save on navigate writes
      // bytes to disk but must not imply human review.
      _updateSaveStatus();
      _updateSaveCounter();
      const savedIdx = DatasetManager.findByName(snapshot.treeName);
      if (savedIdx >= 0) _refreshTreeSelectOption(savedIdx);
      // Cache the freshly-written file handle so next refresh can lazy-resume.
      if (saveResult.method === 'filesystem') {
        try {
          const dirHandle = ProjectConfig.getOutputDirHandle();
          if (dirHandle) {
            const fh = await dirHandle.getFileHandle(filename);
            ProjectConfig.setSavedHandle(snapshot.treeName, fh);
          }
        } catch (e) { /* non-fatal */ }
      } else if (saveResult.method === 'native') {
        // On Android there is no handle; cache a path ref the adapter can re-read.
        try {
          ProjectConfig.setSavedHandle(snapshot.treeName, { path: 'PalmAnnotate/Output JSON/' + filename });
        } catch (e) { /* non-fatal */ }
      }
      const method = saveResult.method === 'filesystem'
        ? 'output folder'
        : (saveResult.method === 'native' ? 'PalmAnnotate app storage' : 'download');
      if (window.SafStore && SafStore.isSupported && SafStore.isSupported()) {
        try { await SafStore.writeJson('Output JSON/' + filename, outputJson); } catch (_) {}
      }
      if (!opts.silent) _showToast(`Saved: ${filename} (${method})`, 'success');
      console.log('[Output]', filename, '→', saveResult.method);

      // Write corrected YOLO .txt labels into the labels folder if configured.
      const labelsOk = await _saveCorrectedLabels(snapshot, datasetTree, outputJson);
      if (labelsOk === false) return false;
      _savedSnapshotSignatures.set(snapshot.treeName, _snapshotSignature(snapshot));
      if (activeSession && activeSession.treeName === snapshot.treeName && ActiveSession.markClean) {
        ActiveSession.markClean();
      }
      if (markConfirmed) {
        ProjectConfig.markSaved(snapshot.treeName);
        _updateSaveStatus();
        _updateSaveCounter();
        if (savedIdx >= 0) _refreshTreeSelectOption(savedIdx);
      }
      _renderQualityPanel();
      return true;
    } else {
      _showToast(`Save failed: ${saveResult.error}`, 'error');
      console.error('[Output] Save failed:', saveResult.error);
      return false;
    }
  }

  /**
   * Write one YOLO-format .txt per side into the configured labels directory
   * (nested under the dataset split). No-ops when no labels directory is set.
   */
  async function _saveCorrectedLabels(snapshot, datasetTree, outputJson) {
    if (!snapshot) return true;
    if (!ProjectConfig.get().hasLabelsDir) return true;
    if (!FsOutput.saveLabelFile) return true;

    let saved = 0;
    let failed = 0;
    for (const side of snapshot.sides) {
      if (!side.imageWidth || !side.imageHeight) continue;
      const dSide = datasetTree && datasetTree.sides && datasetTree.sides[side.sideIndex];
      const filename = _originalLabelFilename(snapshot, side, dSide);
      if (_treeStemFromFilename(filename) !== snapshot.treeName) {
        failed++;
        console.warn('[Labels] blocked mixed-tree label:', filename, snapshot.treeName);
        continue;
      }
      if (_fileStem(filename) !== `${snapshot.treeName}_${side.sideIndex + 1}`) {
        failed++;
        console.warn('[Labels] blocked wrong-side label:', filename, snapshot.treeName, side.sideIndex);
        continue;
      }
      const content = toYoloFormat(side.bboxes, side.imageWidth, side.imageHeight);
      const imageInfo = outputJson && outputJson.images && outputJson.images[`side_${side.sideIndex + 1}`];
      const expected = imageInfo ? (imageInfo.annotations || []).length : side.bboxes.length;
      if (_countYoloLines(content) !== expected) {
        failed++;
        console.warn('[Labels] blocked count mismatch:', filename);
        continue;
      }
      const res = await FsOutput.saveLabelFile(filename, content, snapshot.split, { allowDownload: false });
      if (res.ok) {
        saved++;
        if (window.SafStore && SafStore.isSupported && SafStore.isSupported() && SafStore.writeText) {
          const split = snapshot.split && snapshot.split !== 'unknown' ? snapshot.split : 'field';
          try { await SafStore.writeText(`Output TXT/${split}/${filename}`, content); } catch (_) {}
        }
      } else { failed++; console.warn('[Labels] failed:', filename, res.error); }
    }
    if (saved > 0) {
      _showToast(`Saved ${saved} label .txt file(s) to the label folder`, 'success');
    }
    if (failed > 0) {
      _showToast(`Failed to write ${failed} label .txt file(s); see the console.`, 'error');
      return false;
    }
    return true;
  }

  function _originalLabelFilename(session, side, dSide) {
    if (dSide && dSide.labelFile && dSide.labelFile.name) {
      return dSide.labelFile.name;
    }
    if (dSide && dSide.imageFile && dSide.imageFile.name) {
      return dSide.imageFile.name.replace(/\.[^.]+$/, '.txt');
    }
    return `${session.treeName}_${side.sideIndex + 1}.txt`;
  }

  // Manual save button
  btnSaveOutput.addEventListener('click', () => _enqueueOperation(async () => {
    const ok = await _resolveMismatchesIfAny();
    if (!ok) {
      _showToast('Save cancelled: class mismatches are not resolved yet.', 'info');
      return;
    }
    _setBusy(true, 'Saving...');
    btnSaveOutput.textContent = 'Saving...';
    try {
      await _saveCurrentTreeOutput({ recompute: false });
      // Also render results in the Results tab if visible
      if (_lastResult) {
        Results.render(_lastResult, resultsContainer);
        exportButtons.classList.remove('hidden');
      }
    } finally {
      btnSaveOutput.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Output Again`;
      _setBusy(false);
    }
  }));

  // ── Save status indicators ───────────────────────────────────────────────

  function _updateSaveStatus() {
    if (!treeSaveStatus) return;
    const session = ActiveSession.get();
    if (!session) {
      treeSaveStatus.classList.add('hidden');
      return;
    }
    const saved = ProjectConfig.isSaved(session.treeName);
    treeSaveStatus.classList.remove('hidden');
    treeSaveStatus.classList.toggle('save-status--saved', saved);
    treeSaveStatus.classList.toggle('save-status--unsaved', !saved);
    treeSaveStatus.textContent = saved ? 'Complete' : 'Not confirmed';
    treeSaveStatus.title = saved
      ? `Compute clicked: output ${session.treeName}.json is confirmed`
      : 'Auto-save runs on navigation. Click "Compute & Mark Complete" to mark this tree complete.';
  }

  function _updateSaveCounter() {
    if (!saveCounter) return;
    const total = DatasetManager.count();
    const saved = ProjectConfig.getSavedCount();
    if (saved > 0) {
      saveCounter.classList.remove('hidden');
      saveCounter.textContent = `${saved}/${total} complete`;
    } else {
      saveCounter.classList.add('hidden');
    }
  }

  // ── Toast notifications ──────────────────────────────────────────────────

  function _showToast(message, type = 'info') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => toast.classList.add('toast--visible'));

    // Auto-remove after 4s
    setTimeout(() => {
      toast.classList.remove('toast--visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      // Fallback removal if transition doesn't fire
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  }

  // ── Folder + session inputs ────────────────────────────────────────────────

  inputFolder.addEventListener('change', _onFolderLoad);
  btnLoadFolder.addEventListener('click', () => _triggerLoadFolder());
  btnLoadFolderHero.addEventListener('click', () => _triggerLoadFolder());
  btnLoadSession.addEventListener('click', () => inputSession.click());
  if (btnCaptureTree)     btnCaptureTree.addEventListener('click', () => _startCapture());
  if (btnCaptureTreeHero) btnCaptureTreeHero.addEventListener('click', () => _startCapture());
  if (btnHome)            btnHome.addEventListener('click', () => _onHomeButton());

  // Wire the Sessions home/start/detail shell (capture-first landing).
  if (window.SessionsUI && homeView) {
    SessionsUI.init({
      container: homeView,
      hooks: {
        capture: (session) => _capturePohon(session),
        openPohon: (name, sessionId) => _openPohonByName(name, sessionId),
        loadFolder: () => _triggerLoadFolder(),
        loadSessionJson: () => inputSession.click(),
        toast: (msg, type) => _showToast(msg, type),
      },
    });
  }

  inputSession.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (DatasetManager.count() === 0) {
        alert('Dataset is not loaded. Click "Load Folder" before "Load Session".');
        return;
      }
      const json = JSON.parse(await file.text());

      // Auto-detect format. Output JSON has `images` +
      // `bunches`; native session JSON has `sides` + `confirmedLinks`.
      let sessionJson = json;
      const isOutputFormat = json && json.images && json.bunches && !json.sides;
      if (isOutputFormat) {
        sessionJson = OutputSchema.toSessionJSON(json);
        // Already persisted to disk → don't auto-save again on next navigate.
        ProjectConfig.markSaved(json.tree_name);
      }

      const treeIdx = DatasetManager.findByName(sessionJson.treeName);
      if (treeIdx === -1) {
        alert(`Tree "${sessionJson.treeName}" was not found in the loaded dataset. Load the dataset folder containing that tree first.`);
        return;
      }
      _activeSessionId = null; // loaded a JSON, not opened from a SessionsUI session
      DatasetManager.goTo(treeIdx);
      _updateTreeCounter();
      const tree = DatasetManager.getTree();
      _enterEditorView();
      await ActiveSession.fromJSON(sessionJson, tree);


      _currentSide = 0;
      _currentPair = 0;
      _dedupInitialized = false;
      _rebuildSidePills();
      _activateSidePill(0);
      _initEditor(0);
      _updateSaveStatus();
      _updateSaveCounter();
      // Auto-compute results so the results tab is populated immediately.
      _lastResult = Results.compute(ActiveSession.get());
      Results.render(_lastResult, resultsContainer);
      exportButtons.classList.remove('hidden');
    } catch (err) {
      alert('Failed to load session: ' + err.message);
    }
    inputSession.value = '';
  });

  // ── Tabs ───────────────────────────────────────────────────────────────────

  function _activeTab() {
    const active = document.querySelector('.tab.active');
    return active ? active.dataset.tab : 'annotation';
  }

  function _activateTab(tabName) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    // Reflect the active tab on <body> so the tablet shell can position chrome
    // per-panel (e.g. nudge the carousel topbar below the docked tab bar).
    ['carousel', 'annotation', 'dedup', 'results'].forEach(n =>
      document.body.classList.toggle('crsl-tab-' + n, n === tabName));
    panels.forEach(p => p.classList.add('hidden'));
    const panel = document.getElementById('panel-' + tabName);
    if (panel) panel.classList.remove('hidden');

    if (tabName === 'dedup') _initDedup();
    if (tabName === 'annotation') {
      // Re-init editor to restore focus/canvas size
      if (_editor) { _editor.destroy(); _editor = null; }
      _initEditor(_currentSide);
    }
    if (tabName === 'carousel' && window.CarouselUI && panelCarousel) {
      // Rebuild the carousel for the current session each time it is shown.
      _initCarousel();
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => _activateTab(tab.dataset.tab));
  });

  // The "×" on the revealed editor-tools bar hides it again (so the operator no
  // longer has to reopen More → Editor tools just to dismiss it).
  const tabsClose = document.getElementById('tabs-close');
  if (tabsClose) {
    tabsClose.addEventListener('click', () => {
      document.body.classList.remove('crsl-show-tabs');
      // Drop back to the touch Annotate surface so we never strand the operator
      // on a hidden classic tab with no visible tab bar to switch away from.
      if (document.body.classList.contains('crsl-shell')) _activateTab('carousel');
    });
  }

  // ── Side pills + Editor ────────────────────────────────────────────────────

  function _activateSidePill(sideIndex) {
    sidePills.forEach(p => p.classList.toggle('active', parseInt(p.dataset.side) === sideIndex));
    _currentSide = sideIndex;
  }

  function _rebuildSidePills() {
    if (!sidePillsContainer) return;
    const session = ActiveSession.get();
    const labels = session ? session.sides.map(s => s.label) : (window.TREE_SIDE_LABELS || []);
    sidePillsContainer.innerHTML = '';
    labels.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.className = 'side-pill' + (i === _currentSide ? ' active' : '');
      btn.dataset.side = String(i);
      btn.textContent = label;
      sidePillsContainer.appendChild(btn);
    });
    sidePills = Array.from(sidePillsContainer.querySelectorAll('.side-pill'));
  }

  // Event delegation — survives pill rebuilds
  if (sidePillsContainer) {
    sidePillsContainer.addEventListener('click', (e) => {
      const pill = e.target.closest('.side-pill');
      if (!pill) return;
      const si = parseInt(pill.dataset.side);
      if (Number.isNaN(si)) return;
      _activateSidePill(si);
      _initEditor(si);
    });
  }

  function _updateFileInfo(sideIndex) {
    if (!fileInfo) return;
    const session = ActiveSession.get();
    if (!session) { fileInfo.textContent = ''; return; }
    fileInfo.textContent = `${session.treeName}_${sideIndex + 1}.jpg - ${session.split}`;
  }

  function _initEditor(sideIndex) {
    if (_editor) { _editor.destroy(); _editor = null; }
    const session = ActiveSession.get();
    if (!session) return;
    const side = session.sides[sideIndex];
    _updateFileInfo(sideIndex);
    // Resolve the image URL platform-agnostically. On web ActiveSession.loadTree
    // already set side.imageUrl (a blob URL from the File). On native the side
    // has no blob URL, so derive one from the dataset tree's side (imageUri) via
    // the active StorageAdapter (convertFileSrc).
    let imageUrl = side.imageUrl;
    if (!imageUrl) {
      const dTree = DatasetManager.getTree();
      const dSide = dTree && dTree.sides ? dTree.sides[sideIndex] : null;
      if (dSide) imageUrl = DatasetManager.imageUrlForSide(dSide);
    }
    if (!imageUrl) {
      canvasPlaceholder.classList.remove('hidden');
      return;
    }
    canvasPlaceholder.classList.add('hidden');
    _editor = BBoxEditor.create(
      editorCanvas,
      imageUrl,
      side.bboxes,
      (updatedBboxes) => {
        // BBoxEditor owns the bbox array directly; sync back to session state
        ActiveSession.get().sides[sideIndex].bboxes = updatedBboxes;
        ActiveSession.get().dirty = true;
        _updateBboxCount(sideIndex);
      },
      (bboxId /*, classId */) => {
        // Propagate class change to every other bbox in the same confirmed cluster
        // so paired bboxes on sibling sides stay class-consistent. The editor
        // already updated the active side's bbox in place; we only need to
        // mutate sibling sides, which happens inside ActiveSession.
        ActiveSession.propagateClassFromBox(sideIndex, bboxId);
      }
    );
    if (_editor.setBoxesVisible && BBoxEditor.getBoxesVisible) _editor.setBoxesVisible(BBoxEditor.getBoxesVisible());
    _updateBoxesBtn();
    _updateBboxCount(sideIndex);
  }

  function _updateBboxCount(sideIndex) {
    const session = ActiveSession.get();
    if (!session) return;
    const count = session.sides[sideIndex].bboxes.length;
    bboxCount.textContent = `${count} bbox`;
    _renderQualityPanel();
  }

  // Class buttons — touch substitute for the [1]-[4] keyboard shortcuts.
  // data-class is 1-based (1=B1); the editor uses 0-based classId (0=B1).
  classBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const classId = parseInt(btn.dataset.class, 10) - 1;
      if (_editor && _editor.setSelectedClass) {
        _editor.setSelectedClass(classId);
      } else {
        // Fallback: dispatch the keyboard shortcut to the canvas.
        editorCanvas.dispatchEvent(new KeyboardEvent('keydown', { key: btn.dataset.class, bubbles: true }));
      }
      editorCanvas.focus();
    });
  });

  // Delete button — touch substitute for [Del].
  btnDeleteBbox.addEventListener('click', () => {
    if (_editor && _editor.deleteSelected) {
      _editor.deleteSelected();
    } else {
      editorCanvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    }
    editorCanvas.focus();
  });

  // Detect button — run on-device YOLO on the current side (Phase 3).
  if (btnDetectSide) {
    btnDetectSide.addEventListener('click', () => _detectCurrentSide());
  }

  // BBox overlay toggle — useful on tablets when the operator wants to inspect
  // the RGB image without labels/boxes covering details.
  function _updateBoxesBtn() {
    if (!btnToggleBoxes || !BBoxEditor.getBoxesVisible) return;
    const on = BBoxEditor.getBoxesVisible();
    btnToggleBoxes.classList.toggle('active', on);
    btnToggleBoxes.title = on ? 'Hide bbox overlays' : 'Show bbox overlays';
    btnToggleBoxes.textContent = on ? 'Boxes on' : 'Boxes off';
  }

  if (btnToggleBoxes) {
    btnToggleBoxes.addEventListener('click', () => {
      const next = !(BBoxEditor.getBoxesVisible && BBoxEditor.getBoxesVisible());
      if (BBoxEditor.setBoxesVisibleGlobal) BBoxEditor.setBoxesVisibleGlobal(next);
      if (_editor && _editor.setBoxesVisible) _editor.setBoxesVisible(next);
      _updateBoxesBtn();
    });
  }

  // ── Dedup ──────────────────────────────────────────────────────────────────

  function _initDedup() {
    if (!ActiveSession.get()) return;
    DedupUI.init(dedupLeftCanvas, dedupRightCanvas, dedupSuggestionsEl, dedupLinksEl);
    _updateDedupSuggestionsBtn();
    _dedupInitialized = true;
    _updateDedupPairUI();
    DedupUI.showPair(_currentPair);
  }

  function _updateDedupSuggestionsBtn() {
    if (!btnToggleDedupSuggestions || !DedupUI.getSuggestionsVisible) return;
    const on = DedupUI.getSuggestionsVisible();
    btnToggleDedupSuggestions.classList.toggle('active', on);
    btnToggleDedupSuggestions.title = on
      ? 'Hide automatic suggestions [S]'
      : 'Show automatic suggestions [S]';
  }

  function _updateDedupPairUI() {
    const pairs = window.ADJACENT_PAIRS || [];
    if (!pairs.length || !pairs[_currentPair]) return;
    const [iA, iB] = pairs[_currentPair];
    const labels = window.TREE_SIDE_LABELS || [];
    const lA = labels[iA] || `Side ${iA + 1}`;
    const lB = labels[iB] || `Side ${iB + 1}`;
    dedupPairLabel.textContent = `${lB} <-> ${lA}`;
    // Display: left=sideB, right=sideA (shared edges face center between canvases)
    dedupLeftLabel.innerHTML = `
      <span class="dedup-label-main">${lB}</span>
      <span class="edge-arrow edge-arrow--right">right edge -></span>
    `;
    dedupRightLabel.innerHTML = `
      <span class="dedup-label-main">${lA}</span>
      <span class="edge-arrow edge-arrow--left"><- left edge</span>
    `;
  }

  btnPrevPair.addEventListener('click', () => {
    const nPairs = (window.ADJACENT_PAIRS || []).length || 4;
    _currentPair = (_currentPair + 1) % nPairs;
    _updateDedupPairUI();
    DedupUI.showPair(_currentPair, 'left');
  });
  btnNextPair.addEventListener('click', () => {
    const nPairs = (window.ADJACENT_PAIRS || []).length || 4;
    _currentPair = (_currentPair + nPairs - 1) % nPairs;
    _updateDedupPairUI();
    DedupUI.showPair(_currentPair, 'right');
  });

  btnRunSuggestions.addEventListener('click', () => {
    if (!ActiveSession.get()) return;
    ActiveSession.runSuggestions();
    DedupUI.refresh();
  });

  if (btnToggleDedupSuggestions) {
    btnToggleDedupSuggestions.addEventListener('click', () => {
      DedupUI.setSuggestionsVisible(!DedupUI.getSuggestionsVisible());
      _updateDedupSuggestionsBtn();
    });
  }

  // ── Dedup edit toolbar (change class / delete selected bbox) ───────────────

  const dedupEditToolbar = document.getElementById('dedup-edit-toolbar');
  const dedupEditLabel   = document.getElementById('dedup-edit-label');
  const btnDedupDelete   = document.getElementById('btn-dedup-delete');

  function _refreshDedupEditToolbar() {
    if (!dedupEditToolbar) return;
    const info = DedupUI.getSelectedInfo && DedupUI.getSelectedInfo();
    if (info) {
      dedupEditToolbar.classList.add('active');
      dedupEditLabel.textContent = `${info.sideLabel} - ${info.className}`;
    } else {
      dedupEditToolbar.classList.remove('active');
      dedupEditLabel.textContent = 'Select bbox';
    }
  }

  // Class buttons in dedup edit toolbar
  document.querySelectorAll('[data-dedup-class]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (DedupUI.changeSelectedClass(btn.dataset.dedupClass)) {
        _refreshDedupEditToolbar();
      }
    });
  });

  if (btnDedupDelete) {
    btnDedupDelete.addEventListener('click', () => {
      if (DedupUI.deleteSelected()) _refreshDedupEditToolbar();
    });
  }

  // Poll for selection changes to keep toolbar label in sync
  // (DedupUI drives selection internally via clicks/drawings; a lightweight
  //  interval avoids coupling it to app.js via callbacks.)
  setInterval(() => {
    if (_activeTab() === 'dedup') _refreshDedupEditToolbar();
  }, 250);

  // Collapsible panels toggle
  document.getElementById('btn-toggle-panels').addEventListener('click', () => {
    const panels = document.getElementById('dedup-panels-container');
    const btn = document.getElementById('btn-toggle-panels');
    panels.classList.toggle('collapsed');
    btn.innerHTML = panels.classList.contains('collapsed') ? '&#9654; Suggestions &amp; Links' : '&#9660; Suggestions &amp; Links';
  });

  // ── Mismatch resolve modal ──────────────────────────────────────────────

  let _mismatchResolver = null; // Promise resolver for the currently-open modal

  /**
   * Show the mismatch-resolve modal for any class-inconsistent cluster in the
   * active session. Returns a Promise that resolves to `true` once the user has
   * picked a final class for every mismatch and clicked Apply, or `false` if
   * they cancelled. Resolves immediately to `true` when there are no mismatches.
   */
  function _resolveMismatchesIfAny() {
    return new Promise((resolve) => {
      const mismatches = ActiveSession.getMismatchedClusters();
      if (!mismatches || mismatches.length === 0) { resolve(true); return; }

      // Pre-seed each row with the majority-vote classId.
      const picks = mismatches.map(m => m.majorityClassId);

      mismatchBody.innerHTML = '';
      const list = document.createElement('div');
      list.className = 'mismatch-list';

      mismatches.forEach((mm, i) => {
        const item = document.createElement('div');
        item.className = 'mismatch-item';

        const head = document.createElement('div');
        head.className = 'mismatch-item__head';
        const title = document.createElement('span');
        title.className = 'mismatch-item__title';
        title.textContent = `Bunch #${i + 1}`;
        head.appendChild(title);
        item.appendChild(head);

        const members = document.createElement('div');
        members.className = 'mismatch-item__members';
        members.textContent = mm.members.map(m => {
          const label = (window.TREE_SIDE_LABELS || [])[m.sideIndex] || `Side ${m.sideIndex + 1}`;
          return `${label}: ${m.className}`;
        }).join('  -  ');
        item.appendChild(members);

        const choices = document.createElement('div');
        choices.className = 'mismatch-item__choices';
        // Offer every class observed in this cluster as a choice.
        const classIds = mm.classIds.slice().sort((a, b) => a - b);
        classIds.forEach(cid => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'mismatch-item__choice' + (cid === picks[i] ? ' active' : '');
          btn.textContent = CLASS_MAP[cid] || ('C' + cid);
          btn.dataset.classId = String(cid);
          btn.addEventListener('click', () => {
            picks[i] = cid;
            choices.querySelectorAll('.mismatch-item__choice').forEach(el => {
              el.classList.toggle('active', Number(el.dataset.classId) === cid);
            });
          });
          choices.appendChild(btn);
        });
        item.appendChild(choices);

        list.appendChild(item);
      });

      mismatchBody.appendChild(list);
      modalMismatch.classList.remove('hidden');

      _mismatchResolver = (apply) => {
        if (apply) {
          mismatches.forEach((mm, i) => {
            const targetClassId = picks[i];
            if (!Number.isInteger(targetClassId)) return;
            // Find any member whose class already matches target, otherwise use the first.
            const anchor = mm.members.find(m => m.classId === targetClassId) || mm.members[0];
            ActiveSession.setBboxClass(anchor.sideIndex, anchor.bboxId, targetClassId);
          });
        }
        modalMismatch.classList.add('hidden');
        mismatchBody.innerHTML = '';
        _mismatchResolver = null;
        resolve(!!apply);
      };
    });
  }

  btnMismatchCancel.addEventListener('click', () => {
    if (_mismatchResolver) _mismatchResolver(false);
  });
  btnMismatchConfirm.addEventListener('click', () => {
    if (_mismatchResolver) _mismatchResolver(true);
  });

  // ── Results ──────────────────────────────────────────────────────────────────

  btnCompute.addEventListener('click', () => _enqueueOperation(async () => {
    _setBusy(true, 'Saving...');
    try {
      const session = ActiveSession.get();
      if (!session) return;

      // Block compute until all class mismatches are resolved.
      const ok = await _resolveMismatchesIfAny();
      if (!ok) {
        _showToast('Compute cancelled: class mismatches are not resolved yet.', 'info');
        return;
      }

      const snapshot = _cloneSessionSnapshot();
      if (!snapshot) return;
      _lastResult = Results.compute(snapshot);
      Results.render(_lastResult, resultsContainer);
      exportButtons.classList.remove('hidden');

      // Also save output. markConfirmed=true -> tree gets the green checkmark.
      await _saveCurrentTreeOutput({ recompute: false, allowDirty: true, markConfirmed: true, snapshot });
    } finally {
      _setBusy(false);
    }
  }));

  // Turn an export summary ({count,total,native,dirName}) into operator feedback.
  // On native the files land on disk (the old blob download was a silent no-op),
  // so confirm where; on web they download.
  function _reportExport(label, summary) {
    const s = summary || { count: 0, total: 0 };
    if (!s.count) { _showToast(`${label}: nothing to export`, 'info'); return; }
    if (s.native) _showToast(`${label}: ${s.count} file(s) saved to ${s.dirName}`, 'success');
    else _showToast(`${label}: ${s.count} file(s) downloaded`, 'success');
  }

  btnExportYolo.addEventListener('click', async () => {
    const session = ActiveSession.get();
    if (!session) return;
    if (!await _confirmQualityBeforeExport('Export YOLO')) return;
    // Use mismatch-aware export when results are computed
    const summary = _lastResult
      ? await Results.exportYoloWithMismatch(session, _lastResult)
      : await Results.exportYolo(session);
    _reportExport('Export YOLO', summary);
  });

  btnExportJSON.addEventListener('click', async () => {
    const session = ActiveSession.get();
    if (!session) return;
    if (!await _confirmQualityBeforeExport('Export Session JSON')) return;
    _reportExport('Export Session JSON', await Results.exportJSON(session, _lastResult));
  });

  btnExportCSV.addEventListener('click', async () => {
    const session = ActiveSession.get();
    if (!session) return;
    if (!await _confirmQualityBeforeExport('Export CSV')) return;
    _reportExport('Export CSV', await Results.exportCSV(session, _lastResult));
  });

  btnExportIdentity.addEventListener('click', async () => {
    const session = ActiveSession.get();
    if (!session || !_lastResult) return;
    if (!await _confirmQualityBeforeExport('Export Identity JSON')) return;
    _reportExport('Export Identity JSON', await Results.exportIdentityJSON(session, _lastResult));
  });

  // ── Global keyboard shortcuts ──────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const tab = _activeTab();

    // Dedup tab: arrow keys always navigate pairs, even if a form control has focus
    if (tab === 'dedup' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (e.target.closest('input, select, textarea')) e.target.blur();
      const nSides = ActiveSession.get() ? ActiveSession.get().sides.length : 4;
      const nPairs = (window.ADJACENT_PAIRS || []).length || nSides;
      if (e.key === 'ArrowLeft') {
        _currentPair = (_currentPair + 1) % nPairs;
        _updateDedupPairUI(); DedupUI.showPair(_currentPair, 'left');
      } else {
        _currentPair = (_currentPair + nPairs - 1) % nPairs;
        _updateDedupPairUI(); DedupUI.showPair(_currentPair, 'right');
      }
      e.preventDefault();
      return;
    }

    // Skip when typing in form controls
    if (e.target.closest('input, select, textarea')) return;

    // Suggestions visibility toggle (dedup tab only)
    if ((e.key === 's' || e.key === 'S') && tab === 'dedup') {
      DedupUI.setSuggestionsVisible(!DedupUI.getSuggestionsVisible());
      _updateDedupSuggestionsBtn();
      e.preventDefault();
      return;
    }

    // Skip remaining shortcuts when canvas has focus (bbox editor handles its own keys)
    if (e.target === editorCanvas) return;

    switch (e.key) {
      case '[':
        if (DatasetManager.count() > 0) { _navigateTree('prev'); }
        e.preventDefault(); break;
      case ']':
        if (DatasetManager.count() > 0) { _navigateTree('next'); }
        e.preventDefault(); break;
    }

    const nSides = ActiveSession.get() ? ActiveSession.get().sides.length : 4;

    if (tab === 'annotation') {
      switch (e.key) {
        case 'q': case 'Q': {
          const si = (_currentSide + nSides - 1) % nSides;
          _activateSidePill(si); _initEditor(si);
          e.preventDefault(); break;
        }
        case 'e': case 'E': {
          const si = (_currentSide + 1) % nSides;
          _activateSidePill(si); _initEditor(si);
          e.preventDefault(); break;
        }
      }
    }

    if (tab === 'dedup') {
      switch (e.key) {
        case 'r': case 'R':
          if (!ActiveSession.get()) break;
          ActiveSession.runSuggestions(); DedupUI.refresh();
          e.preventDefault(); break;
        case '1': case '2': case '3': case '4':
          if (DedupUI.changeSelectedClass(e.key)) {
            _refreshDedupEditToolbar();
            e.preventDefault();
          }
          break;
        case 'Delete': case 'Backspace':
          if (DedupUI.deleteSelected()) {
            _refreshDedupEditToolbar();
            e.preventDefault();
          }
          break;
      }
    }
  });

  // If the key/value sessions index is empty (e.g. app data was cleared) but the
  // app-external PalmAnnotate/sessions.json survived, restore the sessions from
  // it so the operator doesn't lose their session list. Best-effort, native-only.
  async function _restoreSessionsFromDisk() {
    if (!(Storage.isNative && Storage.isNative()) || !window.SessionStore) return;
    try {
      const existing = await SessionStore.getSessions();
      if (existing && existing.length) return; // store already has sessions
      const adapter = Storage.active && Storage.active();
      const idx = adapter && adapter.readSessionsIndex ? await adapter.readSessionsIndex() : null;
      if (idx && Array.isArray(idx.sessions) && idx.sessions.length && SessionStore.importSessions) {
        const r = await SessionStore.importSessions(idx.sessions);
        if (r && r.imported) console.info(`[Boot] resumed ${r.imported} session(s) from disk index`);
      }
    } catch (e) { console.warn('[Boot] restore sessions from disk failed:', e); }
  }

  // Boot: repopulate captured pohon (native), then land on the Sessions home.
  async function _bootView() {
    try { await _restoreCapturedTrees(); } catch (e) { console.warn('[Boot] restore failed:', e); }
    try { await _restoreSessionsFromDisk(); } catch (e) { console.warn('[Boot] restore sessions failed:', e); }
    await _showHome();
  }
  _bootView();

});
