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
 * the app-external PalmAnnotate/dataset folder (see CapacitorAdapter), but the
 * DatasetManager tree list lives only in memory. This registry is the INDEX of
 * those captured trees so the app can
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
  const K_SESSIONS       = NS + 'sessions';
  const K_INPUTCACHE     = NS + 'inputCache';
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
  const FIXED_KEYS = [K_SETTINGS, K_CAPTURED, K_SESSIONS, K_INPUTCACHE];

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

  // ── Sessions / groups index ─────────────────────────────────────────────────
  //
  // A "session" (Sesi Pendataan) is one capture run, locked to a single
  // variety+blok. It holds the list of pohon (trees) captured during that run.
  // A "group" is the (variety, blok) identity that a session belongs to:
  // DAMIMAS·A21B and DAMIMAS·A21A are different groups; two sessions on the same
  // variety+blok roll up into ONE group. This index is what powers the home
  // screen's stats + resumable-session list across app restarts. Image/label
  // files still live on disk under the app-external PalmAnnotate/dataset folder;
  // the trees here carry only the persistable refs needed to reopen them.

  let _sidCounter = 0;

  /**
   * Normalize a variety/blok token for the group key: uppercase, keep only
   * A-Z0-9 so "A 21b" and "A21B" collapse to the same group.
   */
  function _normToken(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Stable group key for a (variety, blok) pair.
   */
  function groupKeyFor(variety, blok) {
    return _normToken(variety) + '__' + _normToken(blok);
  }

  /**
   * Generate a unique-enough session id. Date-stamped plus a per-process counter
   * so two sessions created in the same millisecond don't collide.
   */
  function _sid(variety, blok) {
    _sidCounter += 1;
    return 'sess_' + Date.now() + '_' + _sidCounter + '_' + _normToken(variety) + '_' + _normToken(blok);
  }

  /**
   * The full sessions index, newest-updated first.
   * @returns {Promise<Array>} sessions, or [] when none/unreadable.
   */
  async function getSessions() {
    const v = await _getJSON(K_SESSIONS, []);
    if (!Array.isArray(v)) return [];
    // Newest activity first; `seq` (creation order) breaks ties when two
    // sessions share an updatedAt down to the millisecond.
    return v.slice().sort((a, b) => {
      const t = String((b && b.updatedAt) || '').localeCompare(String((a && a.updatedAt) || ''));
      if (t !== 0) return t;
      return (Number((b && b.seq) || 0) - Number((a && a.seq) || 0));
    });
  }

  /**
   * One session by id, or null.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async function getSession(id) {
    if (!id) return null;
    const sessions = await getSessions();
    return sessions.find(s => s && s.id === id) || null;
  }

  /**
   * Create and persist a new session locked to variety+blok.
   * @param {{variety:string, blok:string, sideCount?:number, autoId?:boolean, operator?:string}} opts
   * @returns {Promise<object>} the created session.
   */
  async function createSession(opts = {}) {
    const variety = String(opts.variety || '').trim() || 'UNKNOWN';
    const blok = String(opts.blok || '').trim();
    const now = new Date().toISOString();
    const session = {
      id: _sid(variety, blok),
      seq: _sidCounter,
      variety,
      blok,
      groupKey: groupKeyFor(variety, blok),
      sideCount: Math.max(2, Number(opts.sideCount) || 4),
      autoId: opts.autoId !== false,
      operator: String(opts.operator || '').trim(),
      nextId: 1,
      createdAt: now,
      updatedAt: now,
      trees: [],
    };
    const sessions = await getSessions();
    sessions.push(session);
    await _setJSON(K_SESSIONS, sessions);
    // Remember the typed variety/block for next time's suggestions. Pass the raw
    // opts.variety (not the 'UNKNOWN' fallback) so a blank entry isn't cached.
    await rememberInput(String(opts.variety || '').trim(), blok);
    return session;
  }

  /**
   * Shallow-merge a patch into a session (cannot change id) and persist.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>} the updated session, or null if not found.
   */
  async function updateSession(id, patch) {
    const sessions = await getSessions();
    const idx = sessions.findIndex(s => s && s.id === id);
    if (idx === -1) return null;
    const merged = Object.assign({}, sessions[idx],
      (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : {},
      { id: sessions[idx].id, updatedAt: new Date().toISOString() });
    // Keep the group key consistent if variety/blok changed.
    merged.groupKey = groupKeyFor(merged.variety, merged.blok);
    sessions[idx] = merged;
    await _setJSON(K_SESSIONS, sessions);
    return merged;
  }

  /**
   * Append a pohon (tree) to a session, dedupe by name, bump the auto-increment
   * counter, and persist. Only the persistable side refs are kept.
   * @param {string} id
   * @param {{name, treeId?, sideCount?, metadata?, sides?}} tree
   * @returns {Promise<object|null>} the updated session, or null if not found.
   */
  async function addTreeToSession(id, tree) {
    const sessions = await getSessions();
    const idx = sessions.findIndex(s => s && s.id === id);
    if (idx === -1) return null;
    if (!tree || !tree.name) {
      console.warn('[SessionStore] addTreeToSession: missing tree name, ignored');
      return sessions[idx];
    }
    const session = sessions[idx];
    const treeIdNum = Number(tree.treeId);
    const entry = {
      name: tree.name,
      treeId: Number.isFinite(treeIdNum) ? treeIdNum : (session.trees.length + 1),
      sideCount: Math.max(2, Number(tree.sideCount) || session.sideCount || 4),
      metadata: tree.metadata || {},
      sides: _slimSides(tree.sides),
    };
    session.trees = (session.trees || []).filter(t => t && t.name !== entry.name);
    session.trees.push(entry);
    // Auto-increment counter always advances past the highest id used so the
    // next "+ Pohon" never reuses an id, even after manual entries.
    session.nextId = Math.max(Number(session.nextId) || 1, entry.treeId + 1);
    session.updatedAt = new Date().toISOString();
    sessions[idx] = session;
    await _setJSON(K_SESSIONS, sessions);
    return session;
  }

  /**
   * Remove one pohon (tree) from a session by name and persist. The
   * auto-increment counter is intentionally NOT rewound — tree ids are never
   * reused. On-disk files are handled by the caller (the storage adapter's
   * deleteDatasetTree); this only updates the index.
   * @param {string} id
   * @param {string} treeName
   * @returns {Promise<object|null>} the updated session, or null if not found.
   */
  async function removeTreeFromSession(id, treeName) {
    const sessions = await getSessions();
    const idx = sessions.findIndex(s => s && s.id === id);
    if (idx === -1) return null;
    const session = sessions[idx];
    const before = Array.isArray(session.trees) ? session.trees.length : 0;
    session.trees = (session.trees || []).filter(t => t && t.name !== treeName);
    if (session.trees.length !== before) {
      session.updatedAt = new Date().toISOString();
      sessions[idx] = session;
      await _setJSON(K_SESSIONS, sessions);
    }
    return session;
  }

  /**
   * Remove a session from the index by id and persist. Does NOT delete the
   * on-disk image/label files (those are the dataset of record).
   * @param {string} id
   * @returns {Promise<Array>} the updated sessions list.
   */
  async function removeSession(id) {
    const sessions = await getSessions();
    const next = sessions.filter(s => s && s.id !== id);
    if (next.length !== sessions.length) await _setJSON(K_SESSIONS, next);
    return next;
  }

  /**
   * Derived home-screen stats. Groups roll sessions up by (variety, blok).
   * @returns {Promise<{totalPohon:number, totalGroups:number, totalSessions:number, groups:Array}>}
   */
  async function homeStats() {
    const sessions = await getSessions();
    const groups = new Map(); // groupKey → { groupKey, variety, blok, pohon, sessions }
    let totalPohon = 0;
    for (const s of sessions) {
      if (!s) continue;
      const pohon = Array.isArray(s.trees) ? s.trees.length : 0;
      totalPohon += pohon;
      const key = s.groupKey || groupKeyFor(s.variety, s.blok);
      const g = groups.get(key) || { groupKey: key, variety: s.variety, blok: s.blok, pohon: 0, sessions: 0 };
      g.pohon += pohon;
      g.sessions += 1;
      groups.set(key, g);
    }
    return {
      totalPohon,
      totalGroups: groups.size,
      totalSessions: sessions.length,
      groups: Array.from(groups.values()).sort((a, b) => b.pohon - a.pohon),
    };
  }

  // ── Input cache (variety / block autocomplete) ───────────────────────────────
  //
  // Field crews type the same handful of varieties and blocks over and over. We
  // remember what they entered — most-recent first, capped, case-insensitively
  // deduped — so the new-session form can offer them as <datalist> suggestions.
  // This cache is independent of the sessions list: deleting a session does not
  // forget its variety/block.

  const RECENT_CAP = 12;

  /**
   * Prepend `value` to a recents list (most-recent first), dropping any prior
   * case-insensitive duplicate and capping the length. Blank values are ignored.
   */
  function _pushRecent(list, value) {
    const base = Array.isArray(list) ? list : [];
    const v = String(value == null ? '' : value).trim();
    if (!v) return base.slice(0, RECENT_CAP);
    const out = [v];
    for (const item of base) {
      if (String(item).trim().toLowerCase() !== v.toLowerCase()) out.push(item);
    }
    return out.slice(0, RECENT_CAP);
  }

  /**
   * Remembered free-text inputs for the new-session form.
   * @returns {Promise<{varieties:string[], bloks:string[]}>}
   */
  async function getInputCache() {
    const v = await _getJSON(K_INPUTCACHE, {});
    const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return {
      varieties: Array.isArray(obj.varieties) ? obj.varieties : [],
      bloks: Array.isArray(obj.bloks) ? obj.bloks : [],
    };
  }

  /**
   * Record a variety and/or block the operator just used so it surfaces as a
   * suggestion next time. Blank values are skipped. Never throws.
   * @returns {Promise<{varieties:string[], bloks:string[]}>}
   */
  async function rememberInput(variety, blok) {
    const cache = await getInputCache();
    const next = {
      varieties: _pushRecent(cache.varieties, variety),
      bloks: _pushRecent(cache.bloks, blok),
    };
    await _setJSON(K_INPUTCACHE, next);
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
    // sessions / groups
    getSessions, getSession, createSession, updateSession, addTreeToSession,
    removeTreeFromSession, removeSession, homeStats, groupKeyFor,
    getInputCache, rememberInput,
    // snapshots
    saveSnapshot, loadSnapshot, clearSnapshot,
    // bulk
    clearAll,
  };
})();

window.SessionStore = SessionStore;
