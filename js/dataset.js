'use strict';

/**
 * DatasetManager — load a dataset folder and group files into tree objects
 * for navigation.
 *
 * Two input paths share the SAME grouping core (_buildTrees):
 *   - Web:     load(fileList) from <input webkitdirectory> (File objects).
 *   - Android: loadFromAdapter() from Storage.active().readDatasetEntries()
 *              (native file uris).
 *
 * Expected folder structure:
 *   {root}/images/{split}/{stem}_{N}.jpg
 *   {root}/labels/{split}/{stem}_{N}.txt           (original predictions)
 *   {root}/Output TXT/{split}/{stem}_{N}.txt       (annotator's corrections, optional)
 *   {root}/Output JSON/{tree_name}.json            (saved tree-level GT)
 *
 * Where stem = e.g. DAMIMAS_A21B_0004, and _{N} is the side number (1..99).
 * Number of sides per tree is derived from the max side number observed
 * for that tree (so 4-sided and 8-sided trees can coexist in one dataset).
 *
 * Label resolution: when both `labels/` and `Output TXT/` contain the same
 * stem, the Output TXT version wins. This lets annotators resume from their
 * own corrections instead of falling back to the original predictions.
 *
 * Each side object carries platform-specific refs:
 *   - web:     { imageFile: File|null, labelFile: File|null }
 *   - native:  { imageUri: string|null, labelUri: string|null }
 * Use imageUrlForSide()/labelTextForSide() to read them platform-agnostically.
 */
const DatasetManager = (() => {
  let _trees = [];
  let _currentIndex = 0;

  /**
   * Strip file extension from a filename.
   */
  function _stem(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  /**
   * Extract side number (1-99) from stem suffix (_1, _2, …).
   * Returns null if no valid suffix found.
   */
  function _sideNum(stem) {
    const m = stem.match(/_([1-9]\d?)$/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Strip the side suffix from a stem: DAMIMAS_A21B_0004_1 → DAMIMAS_A21B_0004
   */
  function _treeName(stem) {
    return stem.replace(/_[1-9]\d?$/, '');
  }

  /**
   * Detect split from a relative path.
   * Looks for /train/, /val/, /test/ segments.
   */
  function _detectSplit(relPath) {
    if (/\/train\//i.test(relPath) || /\\train\\/i.test(relPath)) return 'train';
    if (/\/val\//i.test(relPath)   || /\\val\\/i.test(relPath))   return 'val';
    if (/\/test\//i.test(relPath)  || /\\test\\/i.test(relPath))  return 'test';
    return 'unknown';
  }

  /**
   * Skip OS metadata / archive artifacts that webkitdirectory exposes.
   * macOS: __MACOSX/, .DS_Store, ._foo.
   * Windows: Thumbs.db, desktop.ini.
   */
  function _isJunkFile(relPath, name) {
    if (/(^|[/\\])__MACOSX([/\\]|$)/.test(relPath)) return true;
    if (name === '.DS_Store') return true;
    if (name.startsWith('._')) return true;
    if (/^thumbs\.db$/i.test(name)) return true;
    if (/^desktop\.ini$/i.test(name)) return true;
    return false;
  }

  /**
   * Source rank for label files: higher wins. 2 = Output TXT (correction),
   * 1 = labels/ (original prediction).
   */
  function _labelSource(rel) {
    if (/(^|[/\\])Output TXT([/\\])/i.test(rel)) return 2;
    return 1;
  }

  /**
   * Core grouping shared by load() and loadFromAdapter().
   *
   * @param {Array<{relPath:string, name:string, ext:string, file?:File, uri?:string, path?:string}>} entries
   *   A normalized list of files. `file` is set on web, `uri` on native.
   * @returns {Array} sorted tree objects (also stored as _trees)
   */
  function _buildTrees(entries) {
    // Separate images and labels by stem.
    // For labels, track source priority so `Output TXT/` overrides `labels/`
    // when both exist (annotator's corrections win over original predictions).
    const imagesByStem = new Map(); // stem → { ref, split }
    const labelsByStem = new Map(); // stem → { ref, split, source }
    let _junkSkipped = 0;

    for (const entry of entries) {
      const rel  = entry.relPath || entry.name;
      const name = entry.name;
      if (_isJunkFile(rel, name)) { _junkSkipped++; continue; }
      const stem = _stem(name);
      const ext  = (entry.ext || name.split('.').pop()).toLowerCase();
      const split = _detectSplit(rel);
      // ref carries whichever platform-specific reference we have.
      const ref = { file: entry.file || null, uri: entry.uri || null, path: entry.path || null, name };

      if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        imagesByStem.set(stem, { ref, split });
      } else if (ext === 'txt') {
        // Skip txt files that aren't under labels/ or Output TXT/ (e.g. data.yaml siblings)
        const isLabelPath = /(^|[/\\])(labels|Output TXT)([/\\])/i.test(rel);
        if (!isLabelPath) continue;
        const source = _labelSource(rel);
        const existing = labelsByStem.get(stem);
        if (!existing || source >= existing.source) {
          labelsByStem.set(stem, { ref, split, source });
        }
      }
    }

    // Group by tree name
    const treeMap = new Map(); // treeName → { split, sides: Map<sideNum, side> }

    for (const [stem, { ref, split }] of imagesByStem) {
      const sNum = _sideNum(stem);
      if (sNum === null) continue;
      const name = _treeName(stem);
      if (!treeMap.has(name)) {
        treeMap.set(name, { split, sides: new Map() });
      }
      const entry = treeMap.get(name).sides.get(sNum) || {};
      entry.imageFile = ref.file;
      entry.imageUri  = ref.uri;
      entry.imagePath = ref.path;
      treeMap.get(name).sides.set(sNum, entry);
    }

    for (const [stem, { ref }] of labelsByStem) {
      const sNum = _sideNum(stem);
      if (sNum === null) continue;
      const name = _treeName(stem);
      if (!treeMap.has(name)) continue; // no matching image, skip
      const sidesMap = treeMap.get(name).sides;
      const entry = sidesMap.get(sNum) || {};
      entry.labelFile = ref.file;
      entry.labelUri  = ref.uri;
      entry.labelPath = ref.path;
      sidesMap.set(sNum, entry);
    }

    // Convert to sorted array of tree objects.
    // Side count per tree is the max side number observed in its filenames.
    _trees = Array.from(treeMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { split, sides: sidesMap }]) => {
        const maxSide = sidesMap.size ? Math.max(...sidesMap.keys()) : 4;
        const n = Math.max(2, maxSide);
        return {
          name,
          split,
          sides: Array.from({ length: n }, (_, i) =>
            sidesMap.get(i + 1) || { imageFile: null, labelFile: null, imageUri: null, labelUri: null, imagePath: null, labelPath: null }
          ),
        };
      });

    _currentIndex = 0;
    if (_junkSkipped > 0) {
      console.log('[Dataset] Skipped', _junkSkipped, 'junk file(s) (__MACOSX/.DS_Store/Thumbs.db/etc.)');
    }
    return _trees;
  }

  /**
   * Load a FileList from <input webkitdirectory> and build tree list (web).
   * @param {FileList} fileList
   */
  function load(fileList) {
    const entries = [];
    for (const file of fileList) {
      entries.push({
        relPath: file.webkitRelativePath || file.name,
        name: file.name,
        ext: file.name.split('.').pop().toLowerCase(),
        file,
      });
    }
    return _buildTrees(entries);
  }

  /**
   * Load the dataset from the active StorageAdapter (Android). Reuses the same
   * grouping core as load(); each side gets native imageUri/labelUri refs.
   */
  async function loadFromAdapter() {
    const entries = await Storage.active().readDatasetEntries();
    return _buildTrees(entries || []);
  }

  // ── Platform-agnostic per-side accessors ───────────────────────────────────

  /**
   * Object URL (web) or webview-loadable URL (native) for a side's image.
   */
  function imageUrlForSide(side) {
    return Storage.active().imageUrlFor(side);
  }

  /**
   * Label text for a side, or null when the side has no label file.
   * @returns {Promise<string|null>}
   */
  function labelTextForSide(side) {
    return Storage.active().labelTextFor(side);
  }

  function count()   { return _trees.length; }
  function getTree() { return _trees[_currentIndex] || null; }
  function getIndex(){ return _currentIndex; }

  function goTo(idx) {
    if (idx < 0 || idx >= _trees.length) return false;
    _currentIndex = idx;
    return true;
  }

  function next() { return goTo(_currentIndex + 1); }
  function prev() { return goTo(_currentIndex - 1); }

  /**
   * Find a tree by name. Returns its index or -1.
   */
  function findByName(name) {
    return _trees.findIndex(t => t.name === name);
  }

  function getTrees() { return _trees; }

  /**
   * Append/replace a tree produced by the capture-first flow (CaptureFlow) and
   * make it current. Replacing by name is deliberate: if an operator deletes a
   * session then captures the same variety/block/id again in the same app run,
   * stale in-memory tree refs must not win DatasetManager.findByName().
   * @param {object} tree
   * @returns {number} the selected tree index
   */
  function addCapturedTree(tree) {
    const existing = tree && tree.name ? findByName(tree.name) : -1;
    if (existing >= 0) {
      _trees[existing] = tree;
      _currentIndex = existing;
      return existing;
    }
    _trees.push(tree);
    _currentIndex = _trees.length - 1;
    return _currentIndex;
  }

  /** Remove every in-memory tree with this name. Returns how many were removed. */
  function removeByName(name) {
    const before = _trees.length;
    _trees = _trees.filter(t => t && t.name !== name);
    const removed = before - _trees.length;
    if (_trees.length === 0) _currentIndex = 0;
    else if (_currentIndex >= _trees.length) _currentIndex = _trees.length - 1;
    return removed;
  }

  return {
    load, loadFromAdapter, imageUrlForSide, labelTextForSide,
    count, getTree, getIndex, goTo, next, prev, findByName, getTrees,
    addCapturedTree, removeByName,
  };
})();

window.DatasetManager = DatasetManager;
