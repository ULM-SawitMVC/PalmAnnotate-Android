'use strict';

/**
 * ProjectConfig - manages output destinations + per-session save tracking.
 *
 * File names are dataset-driven:
 * - output JSON: {tree_name}.json
 * - corrected labels: original label filename, per side
 *
 * Output destinations now live inside the active StorageAdapter (so the same
 * UI works on web and Android). ProjectConfig delegates directory operations
 * to Storage.active() and keeps the in-memory save tracking (savedTrees /
 * savedHandles) that drives the resume + progress UI. State resets per session.
 */
const ProjectConfig = (() => {
  let _config = {
    savedTrees: new Set(),
    savedHandles: new Map(),
  };

  function get() {
    const a = Storage.active();
    return {
      hasOutputDir: a.hasOutputDir(),
      outputDirName: a.outputDirName(),
      hasLabelsDir: a.hasLabelsDir(),
      labelsDirName: a.labelsDirName(),
    };
  }

  // Raw handle accessors. On web (FSA) these return the real directory handle;
  // on native there is no handle, so they return null. Callers that only need a
  // truthy "is a folder configured" check should use get().hasOutputDir instead.
  function getOutputDirHandle() {
    const a = Storage.active();
    return a.getOutputDirHandle ? a.getOutputDirHandle() : null;
  }

  function getLabelsDirHandle() {
    const a = Storage.active();
    return a.getLabelsDirHandle ? a.getLabelsDirHandle() : null;
  }

  async function pickOutputDirectory() {
    return Storage.active().pickOutputDir();
  }

  async function pickLabelsDirectory() {
    return Storage.active().pickLabelsDir();
  }

  function clearLabelsDirectory() {
    Storage.active().clearLabelsDir();
  }

  function markSaved(treeName) {
    _config.savedTrees.add(treeName);
  }

  function isSaved(treeName) {
    return _config.savedTrees.has(treeName);
  }

  function getSavedCount() {
    return _config.savedTrees.size;
  }

  function isFileSystemAccessSupported() {
    return Storage.active().isSupported();
  }

  function reset() {
    _config = {
      savedTrees: new Set(),
      savedHandles: new Map(),
    };
    // Clear the adapter's chosen output/labels directories too (these used to
    // live in ProjectConfig and were wiped here).
    const a = Storage.active();
    if (a.resetDirs) a.resetDirs();
  }

  function setSavedHandle(treeName, handle) {
    _config.savedHandles.set(treeName, handle);
  }

  function getSavedHandle(treeName) {
    return _config.savedHandles.get(treeName) || null;
  }

  function clearSavedHandle(treeName) {
    _config.savedHandles.delete(treeName);
  }

  return {
    get,
    getOutputDirHandle,
    getLabelsDirHandle,
    pickOutputDirectory,
    pickLabelsDirectory,
    clearLabelsDirectory,
    isFileSystemAccessSupported,
    markSaved,
    isSaved,
    getSavedCount,
    setSavedHandle,
    getSavedHandle,
    clearSavedHandle,
    reset,
  };
})();

window.ProjectConfig = ProjectConfig;
