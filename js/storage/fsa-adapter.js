'use strict';

/**
 * FsaAdapter — StorageAdapter backed by the browser File System Access API.
 *
 * This is the web/desktop path (Chrome/Edge). It OWNS the output and labels
 * directory handles (previously held by ProjectConfig) and performs all
 * direct-to-disk writes, with a browser-download fallback when the API is
 * unavailable or a permission was revoked.
 *
 * Logic here was ported verbatim from the original js/fs-output.js
 * (getFileHandle/createWritable writes, nested label dirs, download fallback,
 * listOutputFiles regex matching, readJSON, verifyAccess) and js/project.js
 * (showDirectoryPicker + dir-name state).
 */
const FsaAdapter = (() => {

  // Directory handles + display names live here now (moved out of ProjectConfig).
  let _outputDirHandle = null;
  let _outputDirName = '';
  let _labelsDirHandle = null;
  let _labelsDirName = '';

  function isNative() { return false; }

  function isSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  // ── Output / labels directory selection ────────────────────────────────────

  async function pickOutputDir() {
    if (!window.showDirectoryPicker) return false;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      _outputDirHandle = handle;
      _outputDirName = handle.name;
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('[FsaAdapter] pickOutputDir error:', e);
      }
      return false;
    }
  }

  async function pickLabelsDir() {
    if (!window.showDirectoryPicker) return false;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      _labelsDirHandle = handle;
      _labelsDirName = handle.name;
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('[FsaAdapter] pickLabelsDir error:', e);
      }
      return false;
    }
  }

  function clearLabelsDir() {
    _labelsDirHandle = null;
    _labelsDirName = '';
  }

  // Clear ALL chosen directories (output + labels). Called from ProjectConfig.reset()
  // so a new session starts with no folder selected, matching the original behavior
  // where the handles lived inside ProjectConfig and were wiped on reset.
  function resetDirs() {
    _outputDirHandle = null;
    _outputDirName = '';
    _labelsDirHandle = null;
    _labelsDirName = '';
  }

  function hasOutputDir() { return !!_outputDirHandle; }
  function hasLabelsDir() { return !!_labelsDirHandle; }
  function outputDirName() { return _outputDirName; }
  function labelsDirName() { return _labelsDirName; }

  // Raw handle accessors — used by ProjectConfig.getOutputDirHandle/getLabelsDirHandle
  // so existing callers that need a real FileSystemDirectoryHandle keep working.
  function getOutputDirHandle() { return _outputDirHandle; }
  function getLabelsDirHandle() { return _labelsDirHandle; }

  // ── Saving ─────────────────────────────────────────────────────────────────

  /**
   * Save a JSON object to the output directory (or download as fallback).
   * @returns {Promise<{ok: boolean, method: string, error?: string}>}
   */
  async function saveJSON(filename, data, opts = {}) {
    const dirHandle = _outputDirHandle;
    const jsonStr = JSON.stringify(data, null, 2);
    const allowDownload = opts.allowDownload !== false;
    const safeName = _safeFileName(filename, 'output.json');

    // Try File System Access API first
    if (dirHandle) {
      try {
        const fileHandle = await dirHandle.getFileHandle(safeName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(jsonStr);
        await writable.close();
        return { ok: true, method: 'filesystem' };
      } catch (e) {
        console.warn('[FsaAdapter] File System write failed, falling back to download:', e);
        // Permission may have been revoked — fall through to download
      }
    }

    if (!allowDownload) {
      return { ok: false, method: 'none', error: 'No writable output folder is available.' };
    }

    // Fallback: browser download
    try {
      _download(safeName, jsonStr, 'application/json');
      return { ok: true, method: 'download' };
    } catch (e) {
      return { ok: false, method: 'none', error: e.message };
    }
  }

  /**
   * Resolve (or create) a nested sub-directory under a given FileSystemDirectoryHandle.
   * `segments` is an ordered array of folder names, e.g. ['train'].
   */
  async function _resolveSubDir(rootHandle, segments) {
    let cur = rootHandle;
    for (const seg of segments) {
      if (!seg) continue;
      cur = await cur.getDirectoryHandle(seg, { create: true });
    }
    return cur;
  }

  /**
   * Save a corrected YOLO .txt label file into the configured labels directory,
   * nested by `split` (e.g. "train") so the output mirrors the dataset layout.
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async function saveLabelFile(filename, content, split, opts = {}) {
    const labelsDir = _labelsDirHandle;
    const allowDownload = opts.allowDownload === true;
    const safeName = _safeFileName(filename, 'label.txt');

    if (labelsDir) {
      try {
        const segments = [];
        const safeSplit = _safeSplit(split);
        if (safeSplit) segments.push(safeSplit);
        const dir = await _resolveSubDir(labelsDir, segments);
        const fileHandle = await dir.getFileHandle(safeName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return { ok: true, method: 'filesystem' };
      } catch (e) {
        console.warn('[FsaAdapter] Label write failed, falling back to download:', e);
      }
    }

    if (!allowDownload) {
      return { ok: false, method: 'none', error: 'No writable label folder is available.' };
    }

    try {
      _download(safeName, content, 'text/plain');
      return { ok: true, method: 'download' };
    } catch (e) {
      return { ok: false, method: 'none', error: e.message };
    }
  }

  /**
   * Trigger a browser download (fallback).
   */
  function _download(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /**
   * Check if we currently have write access to the output directory.
   */
  async function verifyAccess() {
    const dirHandle = _outputDirHandle;
    if (!dirHandle) return false;
    try {
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return true;
      const req = await dirHandle.requestPermission({ mode: 'readwrite' });
      return req === 'granted';
    } catch (e) {
      return false;
    }
  }

  /**
   * List all output JSON files in the output directory and map them by tree name.
   *
   * Supports two filename patterns:
   *   - canonical: `${treeName}.json`
   *   - legacy:    `${treeId}__${treeName}.json`
   *
   * The canonical key is the tree_name so resume logic is idempotent.
   * @returns {Promise<Map<string, FileSystemFileHandle>>}
   */
  async function listOutputFiles() {
    const dirHandle = _outputDirHandle;
    if (!dirHandle) return new Map();
    const ok = await verifyAccess();
    if (!ok) return new Map();

    const map = new Map();
    const sourceLegacy = new Map(); // key -> true if the entry came from a legacy filename
    const reLegacy = /^.+?__(.+)\.json$/i;          // v1 with double-prefix
    const reTreeName = /^([A-Za-z]+_.+?)\.json$/i;  // v2 canonical (variety-prefixed)
    try {
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind !== 'file') continue;
        if (!name.toLowerCase().endsWith('.json')) continue;
        let key = null;
        let isLegacy = false;
        const mLegacy = name.match(reLegacy);
        if (mLegacy) {
          key = mLegacy[1];
          isLegacy = true;
        } else {
          const mNew = name.match(reTreeName);
          if (mNew) key = mNew[1];
        }
        if (!key) continue;
        // Prefer the canonical filename when both exist for the same tree.
        if (!map.has(key) || (sourceLegacy.get(key) && !isLegacy)) {
          map.set(key, handle);
          sourceLegacy.set(key, isLegacy);
        }
      }
    } catch (e) {
      console.warn('[FsaAdapter] listOutputFiles error:', e);
    }
    return map;
  }

  /**
   * Read and parse a JSON file from a FileSystemFileHandle.
   */
  async function readJSON(fileHandle) {
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text());
  }

  // ── Dataset persistence (capture-first flow) ────────────────────────────────

  /**
   * Web has no persistent dataset directory by default, so a captured image is
   * wrapped in an in-memory File. The existing imageUrlFor(side) path
   * (createObjectURL on side.imageFile) then renders it just like a
   * folder-loaded side — no disk write needed.
   * @param {string} relPath  e.g. images/field/DAMIMAS_20260603_001_1.jpg
   * @param {Blob}   blob
   * @returns {Promise<{file:File}>}
   */
  async function persistDatasetImage(relPath, blob) {
    const name = _safeFileName(relPath, 'captured.jpg');
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
    return { file };
  }

  /**
   * Web metadata persistence is native-focused for now. Resolve ok without
   * touching disk so the capture flow proceeds; the data lives on the in-memory
   * datasetTree.metadata for the session.
   * @returns {Promise<{ok:boolean}>}
   */
  async function writeDatasetJson(relPath /*, obj */) {
    console.info('[FsaAdapter] writeDatasetJson is a no-op on web (metadata kept in-session):', relPath);
    return { ok: true };
  }

  /**
   * No-op on web: captured trees live as in-memory File objects, not on a
   * persistent dataset folder, so removing the tree from the session index is
   * all that's needed. Mirrors the native adapter's signature.
   * @returns {Promise<{ok:boolean, removed:number}>}
   */
  async function deleteDatasetTree(/* treeName, sideCount */) {
    return { ok: true, removed: 0 };
  }

  function _safeFileName(filename, fallback) {
    const raw = String(filename || '').replace(/\\/g, '/').split('/').pop() || '';
    const safe = _safeSegment(raw);
    return safe || fallback;
  }

  function _safeSplit(split) {
    if (!split || split === 'unknown') return '';
    return _safeSegment(split);
  }

  function _safeSegment(segment) {
    return String(segment || '')
      .trim()
      .replace(/^[.]+|[.]+$/g, '')
      .replace(/[^A-Za-z0-9._ -]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 160);
  }

  // ── Dataset input ──────────────────────────────────────────────────────────

  /**
   * No-op on web — the dataset is loaded via <input webkitdirectory> FileList,
   * so DatasetManager.load(fileList) is used instead of loadFromAdapter().
   */
  async function readDatasetEntries() {
    return [];
  }

  /**
   * Image URL for a side. Web sides carry a File in `imageFile`.
   */
  function imageUrlFor(side) {
    return side && side.imageFile ? URL.createObjectURL(side.imageFile) : null;
  }

  /**
   * Label text for a side. Web sides carry a File in `labelFile`.
   */
  async function labelTextFor(side) {
    return side && side.labelFile ? side.labelFile.text() : null;
  }

  return {
    isNative, isSupported,
    pickOutputDir, pickLabelsDir, clearLabelsDir, resetDirs,
    hasOutputDir, hasLabelsDir, outputDirName, labelsDirName,
    getOutputDirHandle, getLabelsDirHandle,
    verifyAccess,
    saveJSON, saveLabelFile, listOutputFiles, readJSON,
    persistDatasetImage, writeDatasetJson, deleteDatasetTree,
    readDatasetEntries, imageUrlFor, labelTextFor,
  };
})();

window.FsaAdapter = FsaAdapter;
