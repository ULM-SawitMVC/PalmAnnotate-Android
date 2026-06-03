'use strict';

/**
 * Storage — platform-agnostic storage facade for PalmAnnotate.
 *
 * The app runs in two environments that read/write files very differently:
 *   - Web (Chrome/Edge): the File System Access API (showDirectoryPicker,
 *     FileSystemDirectoryHandle, blob URLs from <input webkitdirectory> Files).
 *   - Android (Capacitor): the native Filesystem plugin under a fixed
 *     app-external PalmAnnotate folder (Directory.External), with
 *     convertFileSrc() for image URLs.
 *
 * `Storage.active()` returns the right StorageAdapter for the current runtime
 * and caches it. Both adapters implement the SAME interface so the rest of the
 * app (DatasetManager, ProjectConfig, FsOutput) never branches on platform.
 *
 * ─── StorageAdapter interface ──────────────────────────────────────────────
 *   isNative() -> boolean
 *   isSupported() -> boolean                 // FSA available on web, or true on native
 *   // OUTPUT dirs / saving
 *   async pickOutputDir() -> boolean
 *   async pickLabelsDir() -> boolean
 *   clearLabelsDir() -> void
 *   hasOutputDir() -> boolean
 *   hasLabelsDir() -> boolean
 *   outputDirName() -> string
 *   labelsDirName() -> string
 *   async verifyAccess() -> boolean
 *   async saveJSON(filename, data, opts) -> {ok, method, error?}     // method: 'filesystem'|'download'|'native'|'none'
 *   async saveLabelFile(filename, content, split, opts) -> {ok, method, error?}
 *   async listOutputFiles() -> Map<treeName, ref>                    // ref is opaque (handle on web, {uri} on native)
 *   async readJSON(ref) -> object
 *   // INPUT dataset (Android only path; web keeps using <input webkitdirectory>)
 *   async readDatasetEntries() -> Array<{relPath, name, kind:'file', ext}>
 *   async deleteDatasetTree(treeName, sideCount) -> {ok, removed}     // native: unlink files; web: no-op
 *   imageUrlFor(side) -> string              // web: createObjectURL; native: convertFileSrc
 *   async labelTextFor(side) -> string|null  // web: labelFile.text(); native: read+decode
 */
const Storage = (() => {
  let _instance = null;

  function _isNativeRuntime() {
    return !!(window.Capacitor &&
              window.Capacitor.isNativePlatform &&
              window.Capacitor.isNativePlatform());
  }

  /**
   * Return the cached StorageAdapter for the current runtime.
   * Native → CapacitorAdapter, otherwise → FsaAdapter. The adapters
   * self-register on window, so they are resolved lazily here.
   */
  function active() {
    if (_instance) return _instance;
    if (_isNativeRuntime() && window.CapacitorAdapter) {
      _instance = window.CapacitorAdapter;
    } else {
      _instance = window.FsaAdapter;
    }
    return _instance;
  }

  function isNative() {
    return active().isNative();
  }

  return { active, isNative };
})();

window.Storage = Storage;
