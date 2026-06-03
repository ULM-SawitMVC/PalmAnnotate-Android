'use strict';

/**
 * SafStore — optional Storage Access Framework "export folder" (native only).
 *
 * Android 13/14 scoped storage blocks writing to public folders like Documents
 * through the Filesystem plugin (see CapacitorAdapter — that's why the working
 * store moved to Directory.External). SAF is the supported way to let the
 * operator pick ANY browsable folder (Documents, SD card, USB-OTG) via the
 * system folder picker; the app then gets a persistable grant to write there.
 *
 * This is purely ADDITIVE: the app keeps capturing/displaying from the reliable
 * app-external store, and — when an export folder is chosen — also mirrors each
 * captured tree's photos + metadata into that public folder so the operator can
 * open/copy them in any file manager. Nothing here is on the critical path:
 * every method degrades gracefully and never throws.
 *
 * Backed by the native SafPlugin (SafPlugin.kt), reached at
 * window.Capacitor.Plugins.Saf. The chosen tree URI is remembered in
 * SessionStore settings (safFolderUri / safFolderName) and passed back to the
 * plugin on each write (the plugin itself stays stateless).
 *
 * Public API:
 *   SafStore.isSupported()                 // native + plugin present (sync)
 *   async current()        -> {uri,name}|null   // chosen folder, re-verified
 *   async pickFolder()     -> {uri,name}|null   // launch system picker
 *   async clearFolder()                          // forget the export folder
 *   async writeImage(relPath, blob)  -> {ok,...} // mirror one image (best-effort)
 *   async writeBlob(relPath, blob)   -> {ok,...} // mirror one binary sidecar
 *   async writeJson(relPath, obj)    -> {ok,...} // mirror one JSON (best-effort)
 *   async writeText(relPath, text)   -> {ok,...} // mirror one text file
 *   async deleteDatasetTree(treeName, sideCount)  // remove mirrored tree files
 */
const SafStore = (() => {

  // Everything the app writes is grouped under this root inside the chosen
  // folder, so a generic pick (e.g. Documents) doesn't get littered.
  const ROOT = 'PalmAnnotate/';

  let _cache; // undefined = not loaded; {uri,name} | null once resolved

  function _plugin() {
    return (window.Capacitor &&
            window.Capacitor.Plugins &&
            window.Capacitor.Plugins.Saf) || null;
  }

  function _isNative() {
    return !!(window.Capacitor &&
              window.Capacitor.isNativePlatform &&
              window.Capacitor.isNativePlatform());
  }

  function _store() { return window.SessionStore || null; }

  /** Native runtime with the Saf plugin installed. */
  function isSupported() {
    return _isNative() && !!_plugin();
  }

  /** The remembered folder from settings (or null), cached after first read. */
  async function _saved() {
    if (_cache !== undefined) return _cache;
    let settings = {};
    const store = _store();
    if (store) { try { settings = await store.getSettings(); } catch (_) {} }
    _cache = (settings && settings.safFolderUri)
      ? { uri: settings.safFolderUri, name: settings.safFolderName || 'Selected folder' }
      : null;
    return _cache;
  }

  /**
   * The current export folder, re-verified to still be granted/writable, or
   * null. The verify guards against a folder the user revoked or deleted.
   */
  async function current() {
    if (!isSupported()) return null;
    const saved = await _saved();
    if (!saved) return null;
    const Saf = _plugin();
    if (Saf && typeof Saf.hasFolder === 'function') {
      try {
        const res = await Saf.hasFolder({ uri: saved.uri });
        if (!res || res.has !== true) return null;
      } catch (_) {
        return null;
      }
    }
    return saved;
  }

  /**
   * Launch the system folder picker and persist the chosen folder. Returns the
   * folder {uri,name}, or null if cancelled / unavailable.
   */
  async function pickFolder() {
    if (!isSupported()) return null;
    const Saf = _plugin();
    let res = null;
    try {
      res = await Saf.pickFolder();
    } catch (e) {
      console.warn('[SafStore] pickFolder failed:', e);
      return null;
    }
    if (!res || res.cancelled || !res.uri) return null;
    const folder = { uri: res.uri, name: res.name || 'Selected folder' };
    const store = _store();
    if (store) {
      try { await store.setSettings({ safFolderUri: folder.uri, safFolderName: folder.name }); } catch (_) {}
    }
    _cache = folder;
    return folder;
  }

  /** Forget the export folder (and release the native grant if possible). */
  async function clearFolder() {
    const Saf = _plugin();
    const saved = await _saved();
    if (Saf && saved && typeof Saf.releaseFolder === 'function') {
      try { await Saf.releaseFolder({ uri: saved.uri }); } catch (_) {}
    }
    const store = _store();
    if (store) {
      try { await store.setSettings({ safFolderUri: '', safFolderName: '' }); } catch (_) {}
    }
    _cache = null;
  }

  /** Blob → base64 (no data: prefix) for the native writeFile bridge. */
  function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const out = String(reader.result || '');
        const comma = out.indexOf(',');
        resolve(comma >= 0 ? out.slice(comma + 1) : out);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Mirror one image Blob to <folder>/PalmAnnotate/<relPath>. Best-effort:
   * resolves {ok:false, skipped:true} when no folder is set, and never throws.
   */
  async function writeBlob(relPath, blob, label) {
    const folder = await current();
    if (!folder) return { ok: false, skipped: true };
    const Saf = _plugin();
    try {
      const base64 = await _blobToBase64(blob);
      const r = await Saf.writeFile({
        treeUri: folder.uri, relPath: ROOT + relPath, data: base64, encoding: 'base64',
      });
      return r || { ok: true };
    } catch (e) {
      console.warn(`[SafStore] ${label || 'writeBlob'} failed for`, relPath, e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async function writeImage(relPath, blob) {
    return writeBlob(relPath, blob, 'writeImage');
  }

  async function _writeUtf8(relPath, text, label) {
    const folder = await current();
    if (!folder) return { ok: false, skipped: true };
    const Saf = _plugin();
    try {
      const r = await Saf.writeFile({
        treeUri: folder.uri, relPath: ROOT + relPath,
        data: String(text == null ? '' : text), encoding: 'utf8',
      });
      return r || { ok: true };
    } catch (e) {
      console.warn(`[SafStore] ${label} failed for`, relPath, e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /**
   * Mirror one JSON object to <folder>/PalmAnnotate/<relPath>. Best-effort.
   */
  async function writeJson(relPath, obj) {
    return _writeUtf8(relPath, JSON.stringify(obj, null, 2), 'writeJson');
  }

  /** Mirror one text file to <folder>/PalmAnnotate/<relPath>. Best-effort. */
  async function writeText(relPath, text) {
    return _writeUtf8(relPath, text, 'writeText');
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
   * Best-effort removal of a mirrored tree from the chosen public SAF folder.
   * Mirrors may not exist (folder not chosen, grant revoked, file absent), so
   * this always resolves and reports the number of files the provider removed.
   */
  async function deleteDatasetTree(treeName, sideCount) {
    const folder = await current();
    if (!folder) return { ok: false, skipped: true, removed: 0 };
    const Saf = _plugin();
    if (!Saf || typeof Saf.deletePath !== 'function') {
      return { ok: false, skipped: true, removed: 0 };
    }
    const stem = _safeSegment(treeName);
    if (!stem) return { ok: false, removed: 0 };
    const n = Math.max(1, Math.min(64, Math.floor(Number(sideCount) || 8)));
    const paths = [];
    for (let i = 1; i <= n; i++) {
      paths.push(`dataset/images/field/${stem}_${i}.jpg`);
      paths.push(`dataset/depth/field/${stem}_${i}.raw`);
      paths.push(`dataset/depth/field/${stem}_${i}.bin`);
      paths.push(`dataset/depth/field/${stem}_${i}.png`);
      paths.push(`dataset/depth/field/${stem}_${i}.json`);
      paths.push(`dataset/labels/field/${stem}_${i}.txt`);
      paths.push(`Output TXT/field/${stem}_${i}.txt`);
    }
    paths.push(`dataset/metadata/${stem}.json`);
    paths.push(`Output JSON/${stem}.json`);

    let removed = 0;
    for (const rel of paths) {
      try {
        const r = await Saf.deletePath({ treeUri: folder.uri, relPath: ROOT + rel });
        if (r && r.removed) removed += 1;
      } catch (e) {
        console.warn('[SafStore] deletePath failed for', rel, e);
      }
    }
    return { ok: true, removed };
  }

  return { isSupported, current, pickFolder, clearFolder, writeImage, writeBlob, writeJson, writeText, deleteDatasetTree };
})();

window.SafStore = SafStore;
