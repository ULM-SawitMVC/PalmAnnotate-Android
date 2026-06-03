'use strict';

/**
 * FsOutput — output-saving facade. The concrete file I/O lives in the active
 * StorageAdapter (FsaAdapter on web, CapacitorAdapter on Android); FsOutput
 * keeps the SAME public API it has always exposed and simply delegates.
 *
 * Public API (unchanged): saveJSON, saveBatch, saveLabelFile, verifyAccess,
 * listOutputFiles, readJSON.
 */
const FsOutput = (() => {

  /**
   * Save a JSON object to the output directory (or download as fallback on web).
   * @returns {Promise<{ok: boolean, method: string, error?: string}>}
   */
  async function saveJSON(filename, data, opts = {}) {
    return Storage.active().saveJSON(filename, data, opts);
  }

  /**
   * Save a batch of tree outputs. Returns summary of results.
   * @param {Array<{filename: string, data: object}>} items
   * @returns {Promise<{saved: number, failed: number, method: string}>}
   */
  async function saveBatch(items) {
    let saved = 0, failed = 0, method = 'none';
    for (const item of items) {
      const result = await saveJSON(item.filename, item.data);
      if (result.ok) { saved++; method = result.method; }
      else failed++;
    }
    return { saved, failed, method };
  }

  /**
   * Save a corrected YOLO .txt label file into the configured labels directory.
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async function saveLabelFile(filename, content, split, opts = {}) {
    return Storage.active().saveLabelFile(filename, content, split, opts);
  }

  /**
   * Check if we currently have write access to the output directory.
   */
  async function verifyAccess() {
    return Storage.active().verifyAccess();
  }

  /**
   * List all output JSON files and map them by tree name.
   * @returns {Promise<Map<string, *>>}  ref is opaque (handle on web, {uri} native)
   */
  async function listOutputFiles() {
    return Storage.active().listOutputFiles();
  }

  /**
   * Read and parse a previously-listed output JSON file.
   */
  async function readJSON(ref) {
    return Storage.active().readJSON(ref);
  }

  return { saveJSON, saveBatch, saveLabelFile, verifyAccess, listOutputFiles, readJSON };
})();

window.FsOutput = FsOutput;
