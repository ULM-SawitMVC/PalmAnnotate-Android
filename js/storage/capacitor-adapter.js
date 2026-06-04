'use strict';

/**
 * CapacitorAdapter — StorageAdapter backed by the native Capacitor Filesystem
 * plugin (Android). No bundler/import: core plugins are reachable at
 * window.Capacitor.Plugins.Filesystem and enum values are passed as strings.
 *
 * Layout (all under {External}/PalmAnnotate, i.e.
 * /Android/data/dev.sawitulm.palmannotate/files/PalmAnnotate):
 *   PalmAnnotate/dataset/images/{split}/{stem}_{N}.jpg
 *   PalmAnnotate/dataset/labels/{split}/{stem}_{N}.txt
 *   PalmAnnotate/Output JSON/{tree_name}.json
 *   PalmAnnotate/Output TXT/{split}/{stem}_{N}.txt
 *
 * Storage root: Directory.External (app-specific external storage). This is the
 * ONLY location that, on every supported Android version, the app can both write
 * AND read back through the WebView (Capacitor.convertFileSrc) without any
 * runtime permission. The public Documents folder was tried first but, under
 * scoped storage (Android 11+, and reliably broken on 13/14 = targetSdk 34),
 * Filesystem.writeFile to Directory.Documents fails — which left captured photos
 * neither on disk nor displayable ("Image unavailable"). Files here are reachable
 * over USB/adb and via the in-app "Download Session" export. A SAF (Storage
 * Access Framework) folder picker — letting the operator choose a public, fully
 * browsable folder — is the proper long-term replacement; see TODOs.
 */
const CapacitorAdapter = (() => {

  const DIRECTORY     = 'EXTERNAL';           // Capacitor Directory enum (string form)
  const BASE          = 'PalmAnnotate';       // root subfolder under app-external storage
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

  // ── Output directory selection (fixed reliable app store) ──────────────────
  // SAF export lives in js/storage/saf-store.js as an additive public mirror;
  // this adapter intentionally remains the app-readable source of truth.

  async function pickOutputDir() { await _ensureBase(); return true; }
  async function pickLabelsDir() { await _ensureBase(); return true; }
  function clearLabelsDir() { /* fixed folder on native — nothing to clear */ }
  function resetDirs() { /* fixed app-external PalmAnnotate folder — nothing to reset */ }

  function hasOutputDir() { return true; }
  function hasLabelsDir() { return true; }
  function outputDirName() { return 'PalmAnnotate (app storage)'; }
  function labelsDirName() { return 'PalmAnnotate (app storage)'; }

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
    return persistDatasetFile(relPath, blob, 'images/field/captured.jpg');
  }

  /** Persist an arbitrary dataset sidecar Blob under PalmAnnotate/dataset/{relPath}. */
  async function persistDatasetFile(relPath, blob, fallback) {
    const fs = _fs();
    if (!fs) throw new Error('Filesystem plugin unavailable.');
    await _ensureBase();
    const path = DATASET + '/' + _safeRelPath(relPath, fallback || 'files/captured.bin');
    const base64 = await _blobToBase64(blob);
    await fs.writeFile({
      path,
      data: base64,
      directory: DIRECTORY,
      recursive: true,
    });
    const res = await fs.getUri({ directory: DIRECTORY, path });
    return { uri: (res && res.uri) || null, path };
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

  /**
   * Best-effort removal of every on-disk artefact for one captured tree: its
   * side images, any saved labels, the per-tree metadata, and the output JSON.
   * Used when the operator deletes a tree from a session so a later folder
   * re-scan can't resurrect it. Each candidate is deleted independently and a
   * "not found" is ignored, so this never throws.
   * @param {string} treeName  e.g. DAMIMAS_A21B_0001
   * @param {number} [sideCount=8] how many sides to attempt (defaults high)
   * @returns {Promise<{ok:boolean, removed:number}>}
   */
  async function deleteDatasetTree(treeName, sideCount) {
    const fs = _fs();
    const stem = _safeSegment(treeName);
    if (!fs || !stem) return { ok: false, removed: 0 };
    await _ensureBase();
    const n = Math.max(1, Math.min(64, Math.floor(Number(sideCount) || 8)));
    const candidates = [];
    const imageSplits = ['field', 'train', 'val', 'test'];
    const imageExts = ['jpg', 'jpeg', 'png'];
    const depthExts = ['raw', 'bin', 'png', 'json'];
    const labelSplits = ['field', 'train', 'val', 'test'];
    for (let i = 1; i <= n; i++) {
      for (const split of imageSplits) {
        for (const ext of imageExts) {
          candidates.push(DATASET + `/images/${split}/${stem}_${i}.${ext}`);
        }
        for (const ext of depthExts) {
          candidates.push(DATASET + `/depth/${split}/${stem}_${i}.${ext}`);
        }
      }
      for (const split of labelSplits) {
        candidates.push(DATASET + `/labels/${split}/${stem}_${i}.txt`);
        candidates.push(OUTPUT_TXT + `/${split}/${stem}_${i}.txt`);
      }
    }
    candidates.push(DATASET + `/metadata/${stem}.json`);
    candidates.push(OUTPUT_JSON + `/${stem}.json`);

    let removed = 0;
    for (const path of candidates) {
      try {
        await fs.deleteFile({ path, directory: DIRECTORY });
        removed += 1;
      } catch (e) {
        // Missing file — expected for most candidates; ignore.
      }
    }
    return { ok: true, removed };
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
    // Native dataset loading reads the fixed app-external PalmAnnotate working
    // store. SAF export is a write-only public mirror, not the read source.
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
    const url = window.Capacitor.convertFileSrc(side.imageUri);
    // WebView can cache file:///_capacitor_file_ URLs aggressively. Reusing the
    // same tree id therefore reuses the same src URL and can show the old photo
    // even after the file was deleted/overwritten. CaptureFlow stores a fresh
    // cacheBust token per capture; append it as a harmless query string.
    const bust = side.cacheBust || side.imageVersion || '';
    if (!bust) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(String(bust));
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

  // ── Dataset binary / JSON readback (depth raw viewer) ───────────────────────

  /** Decode a base64 payload (Filesystem.readFile with no encoding) to bytes. */
  function _base64ToBytes(data) {
    const raw = String(data == null ? '' : data);
    const comma = raw.indexOf(',');
    const b64 = comma >= 0 && raw.slice(0, comma).indexOf('base64') >= 0 ? raw.slice(comma + 1) : raw;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * Read a dataset file as raw bytes. Accepts either a native uri (file://…,
   * content://…) or a dataset-relative path (e.g. depth/field/STEM_1.raw). Used
   * by the depth raw viewer to colorize captured uint16 depth planes. Returns
   * null on any failure so the viewer can degrade gracefully.
   * @returns {Promise<Uint8Array|null>}
   */
  async function readDatasetBinary(relPathOrUri) {
    const fs = _fs();
    if (!fs || !relPathOrUri) return null;
    try {
      let args;
      if (_looksLikeNativeUri(relPathOrUri)) {
        args = { path: relPathOrUri };
      } else {
        await _ensureBase();
        args = { path: DATASET + '/' + _safeRelPath(relPathOrUri, 'depth/field/depth.raw'), directory: DIRECTORY };
      }
      const res = await fs.readFile(args);  // no encoding → base64 string
      return _base64ToBytes(res && res.data);
    } catch (e) {
      console.warn('[CapacitorAdapter] readDatasetBinary failed:', relPathOrUri, e);
      return null;
    }
  }

  /**
   * Read + parse a dataset-relative JSON file (e.g. depth/field/STEM_1.json or
   * metadata/STEM.json). Returns null when missing/unparseable.
   * @returns {Promise<object|null>}
   */
  async function readDatasetJsonAt(relPath) {
    const fs = _fs();
    if (!fs || !relPath) return null;
    try {
      await _ensureBase();
      const path = DATASET + '/' + _safeRelPath(relPath, 'metadata/tree.json');
      const res = await fs.readFile({ path, directory: DIRECTORY, encoding: ENCODING });
      return JSON.parse(_decode(res && res.data));
    } catch (e) {
      return null;
    }
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
    persistDatasetImage, persistDatasetFile, writeDatasetJson, deleteDatasetTree,
    readDatasetEntries, imageUrlFor, labelTextFor,
    readDatasetBinary, readDatasetJsonAt,
  };
})();

window.CapacitorAdapter = CapacitorAdapter;
