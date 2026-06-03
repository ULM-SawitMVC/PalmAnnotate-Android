'use strict';

/**
 * CapacitorAdapter — StorageAdapter backed by the native Capacitor Filesystem
 * plugin (Android). No bundler/import: core plugins are reachable at
 * window.Capacitor.Plugins.Filesystem and enum values are passed as strings.
 *
 * Layout (all under Documents/PalmAnnotate):
 *   PalmAnnotate/dataset/images/{split}/{stem}_{N}.jpg
 *   PalmAnnotate/dataset/labels/{split}/{stem}_{N}.txt
 *   PalmAnnotate/Output JSON/{tree_name}.json
 *   PalmAnnotate/Output TXT/{split}/{stem}_{N}.txt
 *
 * For M1 the input/output roots are this fixed Documents/PalmAnnotate folder.
 * A SAF (Storage Access Framework) folder picker is a later phase — see TODOs.
 */
const CapacitorAdapter = (() => {

  const DIRECTORY     = 'DOCUMENTS';          // Capacitor Directory enum (string form)
  const BASE          = 'PalmAnnotate';       // root subfolder under Documents
  const OUTPUT_JSON   = BASE + '/Output JSON';
  const OUTPUT_TXT    = BASE + '/Output TXT';
  const DATASET       = BASE + '/dataset';
  const ENCODING      = 'utf8';

  let _baseEnsured = false;

  function _fs() {
    return window.Capacitor &&
           window.Capacitor.Plugins &&
           window.Capacitor.Plugins.Filesystem;
  }

  function isNative() { return true; }
  function isSupported() { return !!_fs(); }

  // ── Directory bootstrap ─────────────────────────────────────────────────────

  /**
   * Ensure the base PalmAnnotate folder tree exists. mkdir is recursive so a
   * single call creates the whole chain; "already exists" errors are ignored.
   */
  async function _ensureBase() {
    if (_baseEnsured) return;
    const fs = _fs();
    if (!fs) return;
    const dirs = [BASE, OUTPUT_JSON, OUTPUT_TXT, DATASET];
    for (const path of dirs) {
      try {
        await fs.mkdir({ path, directory: DIRECTORY, recursive: true });
      } catch (e) {
        // Directory likely already exists — non-fatal.
      }
    }
    _baseEnsured = true;
  }

  // ── Output directory selection (fixed folder for M1) ────────────────────────
  // TODO(SAF): replace the fixed Documents/PalmAnnotate root with a real
  // Storage Access Framework folder picker so users can choose any location.

  async function pickOutputDir() { await _ensureBase(); return true; }
  async function pickLabelsDir() { await _ensureBase(); return true; }
  function clearLabelsDir() { /* fixed folder on native — nothing to clear */ }
  function resetDirs() { /* fixed Documents/PalmAnnotate folder — nothing to reset */ }

  function hasOutputDir() { return true; }
  function hasLabelsDir() { return true; }
  function outputDirName() { return 'Documents/PalmAnnotate'; }
  function labelsDirName() { return 'Documents/PalmAnnotate'; }

  async function verifyAccess() { return true; }

  // ── Saving ─────────────────────────────────────────────────────────────────

  /**
   * Write the tree output JSON under Output JSON/.
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async function saveJSON(filename, data /*, opts */) {
    const fs = _fs();
    if (!fs) return { ok: false, method: 'none', error: 'Filesystem plugin unavailable.' };
    try {
      await _ensureBase();
      const safeName = _safeFileName(filename, 'output.json');
      await fs.writeFile({
        path: OUTPUT_JSON + '/' + safeName,
        data: JSON.stringify(data, null, 2),
        directory: DIRECTORY,
        encoding: ENCODING,
        recursive: true,
      });
      return { ok: true, method: 'native' };
    } catch (e) {
      console.warn('[CapacitorAdapter] saveJSON failed:', e);
      return { ok: false, method: 'none', error: (e && e.message) || String(e) };
    }
  }

  /**
   * Write a corrected YOLO .txt label under Output TXT/{split}/.
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async function saveLabelFile(filename, content, split /*, opts */) {
    const fs = _fs();
    if (!fs) return { ok: false, method: 'none', error: 'Filesystem plugin unavailable.' };
    try {
      await _ensureBase();
      const safeName = _safeFileName(filename, 'label.txt');
      const safeSplit = _safeSplit(split);
      const splitSeg = safeSplit ? safeSplit + '/' : '';
      await fs.writeFile({
        path: OUTPUT_TXT + '/' + splitSeg + safeName,
        data: content,
        directory: DIRECTORY,
        encoding: ENCODING,
        recursive: true,
      });
      return { ok: true, method: 'native' };
    } catch (e) {
      console.warn('[CapacitorAdapter] saveLabelFile failed:', e);
      return { ok: false, method: 'none', error: (e && e.message) || String(e) };
    }
  }

  /**
   * List output JSON files and map them by tree name. Uses the SAME two
   * filename patterns as FsaAdapter (canonical + legacy double-prefix).
   * ref = { uri } so readJSON can read it back natively.
   * @returns {Promise<Map<string, {uri:string}>>}
   */
  async function listOutputFiles() {
    const fs = _fs();
    const map = new Map();
    if (!fs) return map;

    const sourceLegacy = new Map();
    const reLegacy = /^.+?__(.+)\.json$/i;          // v1 with double-prefix
    const reTreeName = /^([A-Za-z]+_.+?)\.json$/i;  // v2 canonical
    try {
      await _ensureBase();
      const res = await fs.readdir({ path: OUTPUT_JSON, directory: DIRECTORY });
      const files = (res && res.files) || [];
      for (const entry of files) {
        // Capacitor returns either string names (older plugin) or FileInfo objects.
        const name = typeof entry === 'string' ? entry : entry.name;
        const type = typeof entry === 'string' ? 'file' : entry.type;
        if (!name) continue;
        if (type && type !== 'file') continue;
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
        const uri = (typeof entry !== 'string' && entry.uri) ? entry.uri : null;
        const ref = { uri, path: OUTPUT_JSON + '/' + name };
        if (!map.has(key) || (sourceLegacy.get(key) && !isLegacy)) {
          map.set(key, ref);
          sourceLegacy.set(key, isLegacy);
        }
      }
    } catch (e) {
      console.warn('[CapacitorAdapter] listOutputFiles error:', e);
    }
    return map;
  }

  /**
   * Read + parse a JSON file from a ref produced by listOutputFiles().
   * Prefers the relative path (directory-scoped) and falls back to a raw uri.
   */
  async function readJSON(ref) {
    const fs = _fs();
    if (!fs) throw new Error('Filesystem plugin unavailable.');
    let res;
    if (ref && ref.path) {
      res = await fs.readFile({ path: ref.path, directory: DIRECTORY, encoding: ENCODING });
    } else if (ref && ref.uri) {
      res = await fs.readFile({ path: ref.uri, encoding: ENCODING });
    } else {
      throw new Error('Invalid output file reference.');
    }
    return JSON.parse(_decode(res && res.data));
  }

  // ── Dataset persistence (capture-first flow) ────────────────────────────────

  /**
   * Convert a Blob into a base64 string (no data: prefix) for Filesystem.writeFile.
   */
  function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result is "data:<mime>;base64,<data>" — keep only the payload.
        const out = String(reader.result || '');
        const comma = out.indexOf(',');
        resolve(comma >= 0 ? out.slice(comma + 1) : out);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Persist a captured image Blob under PalmAnnotate/dataset/{relPath}. Returns
   * a native file uri so the side can carry imageUri into the annotation flow.
   * @param {string} relPath  e.g. images/field/DAMIMAS_20260603_001_1.jpg
   * @param {Blob}   blob
   * @returns {Promise<{uri?:string}>}
   */
  async function persistDatasetImage(relPath, blob) {
    const fs = _fs();
    if (!fs) throw new Error('Filesystem plugin unavailable.');
    await _ensureBase();
    const path = DATASET + '/' + _safeRelPath(relPath, 'images/field/captured.jpg');
    const base64 = await _blobToBase64(blob);
    await fs.writeFile({
      path,
      data: base64,
      directory: DIRECTORY,
      recursive: true,
    });
    const res = await fs.getUri({ directory: DIRECTORY, path });
    return { uri: (res && res.uri) || null };
  }

  /**
   * Write capture metadata as pretty JSON under PalmAnnotate/dataset/{relPath}.
   * @param {string} relPath  e.g. metadata/DAMIMAS_20260603_001.json
   * @param {object} obj
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function writeDatasetJson(relPath, obj) {
    const fs = _fs();
    if (!fs) return { ok: false, error: 'Filesystem plugin unavailable.' };
    try {
      await _ensureBase();
      const safePath = _safeRelPath(relPath, 'metadata/captured.json');
      await fs.writeFile({
        path: DATASET + '/' + safePath,
        data: JSON.stringify(obj, null, 2),
        directory: DIRECTORY,
        encoding: ENCODING,
        recursive: true,
      });
      return { ok: true };
    } catch (e) {
      console.warn('[CapacitorAdapter] writeDatasetJson failed:', e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // ── Dataset input ──────────────────────────────────────────────────────────

  /**
   * Recursively read the native dataset folder (images/ and labels/) plus the
   * separate Output TXT folder where corrected labels are saved on Android.
   * Returning Output TXT entries here is important: DatasetManager gives them
   * priority over original labels/ so a restart resumes the latest corrections.
   * @returns {Promise<Array<{relPath:string, name:string, kind:'file', ext:string, uri?:string}>>}
   */
  async function readDatasetEntries() {
    const fs = _fs();
    const out = [];
    if (!fs) return out;
    await _ensureBase();
    // TODO(SAF): allow picking an arbitrary dataset folder; M1 uses the fixed
    // Documents/PalmAnnotate roots.
    await _walk(fs, DATASET, '', out);
    await _walk(fs, OUTPUT_TXT, 'Output TXT', out);
    return out;
  }

  /**
   * Depth-first walk of a directory, collecting file entries with a relative
   * path (relative to the dataset root) so _detectSplit/_stem keep working.
   */
  async function _walk(fs, absPath, relPath, out) {
    let res;
    try {
      res = await fs.readdir({ path: absPath, directory: DIRECTORY });
    } catch (e) {
      return; // missing subfolder (e.g. no labels/) — skip silently
    }
    const files = (res && res.files) || [];
    for (const entry of files) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const type = typeof entry === 'string' ? null : entry.type;
      if (!name) continue;
      const childAbs = absPath + '/' + name;
      const childRel = relPath ? relPath + '/' + name : name;
      let uri = (typeof entry !== 'string' && entry.uri) ? entry.uri : null;

      let isDir;
      if (type === 'directory') isDir = true;
      else if (type === 'file') isDir = false;
      else isDir = !/\.[^.]+$/.test(name); // older plugins omit type — infer from extension

      if (isDir) {
        await _walk(fs, childAbs, childRel, out);
      } else {
        if (!uri && fs.getUri) {
          try {
            const res = await fs.getUri({ directory: DIRECTORY, path: childAbs });
            uri = (res && res.uri) || null;
          } catch (e) {
            uri = null;
          }
        }
        out.push({
          relPath: childRel,
          name,
          kind: 'file',
          ext: name.split('.').pop().toLowerCase(),
          path: childAbs,
          uri: uri || childAbs,
        });
      }
    }
  }

  /**
   * Image URL for a native side: convert the file uri into a webview URL.
   */
  function imageUrlFor(side) {
    if (!side || !side.imageUri) return null;
    return window.Capacitor.convertFileSrc(side.imageUri);
  }

  /**
   * Label text for a native side: read + decode the .txt, or null if none.
   */
  async function labelTextFor(side) {
    const fs = _fs();
    if (!fs || !side || (!side.labelUri && !side.labelPath)) return null;
    try {
      const path = side.labelPath || side.labelUri;
      const args = { path, encoding: ENCODING };
      if (side.labelPath || !_looksLikeNativeUri(path)) args.directory = DIRECTORY;
      const res = await fs.readFile(args);
      return _decode(res && res.data);
    } catch (e) {
      console.warn('[CapacitorAdapter] labelTextFor failed:', e);
      return null;
    }
  }

  function _looksLikeNativeUri(path) {
    return typeof path === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(path);
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

  function _safeRelPath(relPath, fallback) {
    const segments = String(relPath || '')
      .replace(/\\/g, '/')
      .split('/')
      .map(_safeSegment)
      .filter(Boolean);
    return segments.length ? segments.join('/') : fallback;
  }

  function _safeSegment(segment) {
    return String(segment || '')
      .trim()
      .replace(/^[.]+|[.]+$/g, '')
      .replace(/[^A-Za-z0-9._ -]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 160);
  }

  /**
   * Normalize Filesystem.readFile output to a string. With encoding:'utf8' the
   * plugin returns a string already; guard against Blob/base64 just in case.
   */
  function _decode(data) {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    return String(data);
  }

  return {
    isNative, isSupported,
    pickOutputDir, pickLabelsDir, clearLabelsDir, resetDirs,
    hasOutputDir, hasLabelsDir, outputDirName, labelsDirName,
    verifyAccess,
    saveJSON, saveLabelFile, listOutputFiles, readJSON,
    persistDatasetImage, writeDatasetJson,
    readDatasetEntries, imageUrlFor, labelTextFor,
  };
})();

window.CapacitorAdapter = CapacitorAdapter;
