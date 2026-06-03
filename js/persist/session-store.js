'use strict';

/**
 * SessionStore — lightweight key/value persistence for settings, the on-device
 * captured-tree registry, and in-progress annotation snapshots.
 *
 * Two backends, same interface (no bundler/import — plugins are reached on
 * window.Capacitor.Plugins):
 *   - Native (Android): @capacitor/preferences — window.Capacitor.Plugins.Preferences.
 *   - Web (Chrome/Edge): window.localStorage.
 *
 * Native detection follows the rest of the app:
 *   window.Capacitor && window.Capacitor.isNativePlatform && isNativePlatform().
 *
 * Why this exists: image/label files captured on-device persist on disk under
 * Documents/PalmAnnotate/dataset, but the DatasetManager tree list lives only in
 * memory. This registry is the INDEX of those captured trees so the app can
 * repopulate DatasetManager after a restart. Settings (operator/variety defaults)
 * and optional autosave snapshots ride along on the same store.
 *
 * Design contract:
 *   - Every method is async.
 *   - Values are JSON-encoded.
 *   - Methods are NON-THROWING: on any failure they catch + console.warn and
 *     return a sensible default ({}/[]/null/undefined), so callers never need a
 *     try/catch around persistence.
 *   - All keys are namespaced under 'palmannotate.'.
 */
const SessionStore = (() => {

  // ── Namespaced keys ─────────────────────────────────────────────────────────

  const NS               = 'palmannotate.';
  const K_SETTINGS       = NS + 'settings';
  const K_CAPTURED       = NS + 'capturedRegistry';
  const SNAPSHOT_PREFIX  = NS + 'snapshot.';

  /**
   * localStorage key for a per-tree annotation snapshot. The tree name is
   * encoded so unusual characters can't collide with the prefix delimiter.
   */
  function _snapshotKey(treeName) {
    return SNAPSHOT_PREFIX + encodeURIComponent(String(treeName == null ? '' : treeName));
  }

  // All keys this module owns, used by clearAll(). Snapshot keys are discovered
  // dynamically (they're per-tree), so they're handled separately there.
  const FIXED_KEYS = [K_SETTINGS, K_CAPTURED];

  // ── Backend selection ───────────────────────────────────────────────────────

  /**
   * The native Preferences plugin, or null on web / when unavailable.
   */
  function _prefs() {
    return (window.Capacitor &&
            window.Capacitor.isNativePlatform &&
            window.Capacitor.isNativePlatform() &&
            window.Capacitor.Plugins &&
            window.Capacitor.Plugins.Preferences) || null;
  }

  // ── JSON value helper (Preferences on native, localStorage on web) ──────────

  /**
   * Read a JSON value by key. Returns `fallback` on a missing key, a parse
   * error, or any backend failure (never throws).
   * @template T
   * @param {string} key
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  async function _getJSON(key, fallback) {
    try {
      let raw = null;
      const prefs = _prefs();
      if (prefs) {
        const res = await prefs.get({ key });
        raw = res ? res.value : null;
      } else if (window.localStorage) {
        raw = window.localStorage.getItem(key);
      }
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[SessionStore] _getJSON failed for', key, e);
      return fallback;
    }
  }

  /**
   * Write a JSON value by key. Returns true on success, false on any failure
   * (never throws).
   * @param {string} key
   * @param {*} value
   * @returns {Promise<boolean>}
   */
  async function _setJSON(key, value) {
    try {
      const raw = JSON.stringify(value);
      const prefs = _prefs();
      if (prefs) {
        await prefs.set({ key, value: raw });
      } else if (window.localStorage) {
        window.localStorage.setItem(key, raw);
      } else {
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[SessionStore] _setJSON failed for', key, e);
      return false;
    }
  }

  /**
   * Remove a key from whichever backend is active. Never throws.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async function _removeKey(key) {
    try {
      const prefs = _prefs();
      if (prefs) {
        await prefs.remove({ key });
      } else if (window.localStorage) {
        window.localStorage.removeItem(key);
      }
      return true;
    } catch (e) {
      console.warn('[SessionStore] _removeKey failed for', key, e);
      return false;
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  /**
   * Persisted app settings, e.g. { defaultVariety, operator, datasetRoot, … }.
   * @returns {Promise<object>} the stored object, or {} when none/unreadable.
   */
  async function getSettings() {
    const v = await _getJSON(K_SETTINGS, {});
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }

  /**
   * Shallow-merge `obj` into the stored settings and persist the result.
   * @param {object} obj
   * @returns {Promise<object>} the merged settings (also when persist fails).
   */
  async function setSettings(obj) {
    const current = await getSettings();
    const merged = Object.assign({}, current,
      (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {});
    await _setJSON(K_SETTINGS, merged);
    return merged;
  }

  // ── Captured-tree registry ──────────────────────────────────────────────────

  /**
   * The on-device captured-tree index. Each entry mirrors a DatasetManager tree:
   *   { name, split, metadata, sides:[{ imageUri, labelUri }] }
   * @returns {Promise<Array>} the registry, or [] when none/unreadable.
   */
  async function getCapturedRegistry() {
    const v = await _getJSON(K_CAPTURED, []);
    return Array.isArray(v) ? v : [];
  }

  /**
   * Normalize a tree's sides down to the persistable refs. Only the native file
   * URIs survive a restart (Blob/File handles do not), so we keep just those.
   */
  function _slimSides(sides) {
    if (!Array.isArray(sides)) return [];
    return sides.map(s => ({
      imageUri: (s && s.imageUri) || null,
      labelUri: (s && s.labelUri) || null,
    }));
  }

  /**
   * Append a captured tree to the registry (dedupe by name — an existing entry
   * with the same name is replaced) and persist.
   * @param {{name, split, metadata, sides}} treeMeta
   * @returns {Promise<Array>} the updated registry.
   */
  async function addCapturedTree(treeMeta) {
    const registry = await getCapturedRegistry();
    if (!treeMeta || !treeMeta.name) {
      console.warn('[SessionStore] addCapturedTree: missing tree name, ignored');
      return registry;
    }
    const entry = {
      name: treeMeta.name,
      split: treeMeta.split || 'field',
      metadata: treeMeta.metadata || {},
      sides: _slimSides(treeMeta.sides),
    };
    const next = registry.filter(t => t && t.name !== entry.name);
    next.push(entry);
    await _setJSON(K_CAPTURED, next);
    return next;
  }

  /**
   * Remove a captured tree from the registry by name and persist.
   * @param {string} name
   * @returns {Promise<Array>} the updated registry.
   */
  async function removeCapturedTree(name) {
    const registry = await getCapturedRegistry();
    const next = registry.filter(t => t && t.name !== name);
    if (next.length !== registry.length) {
      await _setJSON(K_CAPTURED, next);
    }
    return next;
  }

  // ── In-progress annotation snapshots (optional autosave) ─────────────────────

  /**
   * Save an in-progress annotation snapshot (ActiveSession.toJSON() shape),
   * keyed by tree name.
   * @param {string} treeName
   * @param {object} snapshot
   * @returns {Promise<boolean>} true on success.
   */
  async function saveSnapshot(treeName, snapshot) {
    if (!treeName) {
      console.warn('[SessionStore] saveSnapshot: missing treeName, ignored');
      return false;
    }
    return _setJSON(_snapshotKey(treeName), snapshot);
  }

  /**
   * Load the snapshot for a tree, or null when none/unreadable.
   * @param {string} treeName
   * @returns {Promise<object|null>}
   */
  async function loadSnapshot(treeName) {
    if (!treeName) return null;
    return _getJSON(_snapshotKey(treeName), null);
  }

  /**
   * Delete the snapshot for a tree.
   * @param {string} treeName
   * @returns {Promise<boolean>}
   */
  async function clearSnapshot(treeName) {
    if (!treeName) return false;
    return _removeKey(_snapshotKey(treeName));
  }

  // ── Bulk clear ──────────────────────────────────────────────────────────────

  /**
   * Remove every key this module owns: settings, the captured registry, and all
   * per-tree snapshots (including those for trees no longer in the registry).
   * Never throws.
   * @returns {Promise<boolean>}
   */
  async function clearAll() {
    try {
      // Snapshots are keyed per tree. Collect keys to clear: the ones referenced
      // by the current registry, plus any snapshot keys still in localStorage.
      const snapshotKeys = new Set();
      const registry = await getCapturedRegistry();
      for (const t of registry) {
        if (t && t.name) snapshotKeys.add(_snapshotKey(t.name));
      }
      if (!_prefs() && window.localStorage) {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.indexOf(SNAPSHOT_PREFIX) === 0) snapshotKeys.add(k);
        }
      }
      for (const key of FIXED_KEYS) await _removeKey(key);
      for (const key of snapshotKeys) await _removeKey(key);
      return true;
    } catch (e) {
      console.warn('[SessionStore] clearAll failed:', e);
      return false;
    }
  }

  return {
    // settings
    getSettings, setSettings,
    // captured-tree registry
    getCapturedRegistry, addCapturedTree, removeCapturedTree,
    // snapshots
    saveSnapshot, loadSnapshot, clearSnapshot,
    // bulk
    clearAll,
  };
})();

window.SessionStore = SessionStore;
