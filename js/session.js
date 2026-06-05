'use strict';

// Dynamic side labels + adjacency — regenerated per tree based on number of photos.
// Naming is always numeric ("Side 1".."Side N") so the UI handles any side count
// uniformly and avoids bias toward physical compass directions.
let TREE_SIDE_LABELS = ['Side 1', 'Side 2', 'Side 3', 'Side 4'];

// Adjacent pair definitions: [sideA, sideB] clockwise (right edge of A meets left edge of B)
let ADJACENT_PAIRS = [[0, 1], [1, 2], [2, 3], [3, 0]];

function generateSideLabels(n) {
  return Array.from({ length: n }, (_, i) => `Side ${i + 1}`);
}

function generateAdjacentPairs(n) {
  if (n < 2) return [];
  if (n === 2) return [[0, 1]]; // single pair, no wraparound
  return Array.from({ length: n }, (_, i) => [i, (i + 1) % n]);
}

function _applySideCount(n) {
  TREE_SIDE_LABELS = generateSideLabels(n);
  ADJACENT_PAIRS   = generateAdjacentPairs(n);
  window.TREE_SIDE_LABELS = TREE_SIDE_LABELS;
  window.ADJACENT_PAIRS   = ADJACENT_PAIRS;
}

// ─── Active Session ───────────────────────────────────────────────────────────

const ActiveSession = (() => {
  let _state = null;
  let _linkSeq = 0;

  function _createSide(sideIndex) {
    return {
      sideIndex,
      label: TREE_SIDE_LABELS[sideIndex],
      imageUrl: null,
      bboxes: [],
      originalBboxes: [],
      imageWidth: 0,
      imageHeight: 0,
    };
  }

  function _deepCloneBboxes(bboxes) {
    return bboxes.map(b => ({ ...b }));
  }

  function _loadImageDimensions(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = url;
    });
  }

  async function loadTree(datasetTree) {
    // Revoke old blob URLs. Only web object URLs (blob:) are revocable; native
    // convertFileSrc URLs are not and must be left alone.
    if (_state) {
      for (const s of _state.sides) {
        if (s.imageUrl && s.imageUrl.startsWith('blob:')) URL.revokeObjectURL(s.imageUrl);
      }
    }
    _linkSeq = 0;

    const n = Math.max(2, (datasetTree.sides || []).length || 4);
    _applySideCount(n);

    const sides = Array.from({ length: n }, (_, i) => _createSide(i));
    await Promise.all(datasetTree.sides.map(async (dSide, i) => {
      const side = sides[i];
      // A side may carry a web File (imageFile) or a native uri (imageUri);
      // DatasetManager resolves whichever applies for the active platform.
      if (!dSide || (!dSide.imageFile && !dSide.imageUri)) return;
      side.imageUrl = DatasetManager.imageUrlForSide(dSide);
      if (!side.imageUrl) return;
      const dims = await _loadImageDimensions(side.imageUrl);
      side.imageWidth  = dims.w;
      side.imageHeight = dims.h;
      const labelText = (dSide.labelFile || dSide.labelUri)
        ? await DatasetManager.labelTextForSide(dSide)
        : null;
      side.bboxes = labelText ? parseYoloLabel(labelText, dims.w, dims.h) : [];
      side.originalBboxes = _deepCloneBboxes(side.bboxes);
    }));

    _state = {
      treeName: datasetTree.name,
      split: datasetTree.split,
      sides,
      suggestedLinks: [],
      confirmedLinks: [],
      dirty: false,
    };

    return _state;
  }

  function get() { return _state; }
  function _markDirty() { if (_state) _state.dirty = true; }

  // ── BBox CRUD ──────────────────────────────────────────────────────────────

  function addBbox(sideIndex, bbox) {
    _state.sides[sideIndex].bboxes.push(bbox);
    _markDirty();
  }

  function removeBbox(sideIndex, id) {
    const side = _state.sides[sideIndex];
    side.bboxes = side.bboxes.filter(b => b.id !== id);
    _state.suggestedLinks = _state.suggestedLinks.filter(l =>
      !((l.sideA === sideIndex && l.bboxIdA === id) || (l.sideB === sideIndex && l.bboxIdB === id))
    );
    _state.confirmedLinks = _state.confirmedLinks.filter(l =>
      !((l.sideA === sideIndex && l.bboxIdA === id) || (l.sideB === sideIndex && l.bboxIdB === id))
    );
    _markDirty();
  }

  function updateBbox(sideIndex, id, patch) {
    const side = _state.sides[sideIndex];
    const idx = side.bboxes.findIndex(b => b.id === id);
    if (idx === -1) return;
    side.bboxes[idx] = { ...side.bboxes[idx], ...patch };
    _markDirty();
  }

  /**
   * Return every bbox in the same confirmed cross-side cluster as (sideIndex, bboxId),
   * including the anchor itself. Uses Union-Find over `confirmedLinks`.
   * If the bbox belongs to no cluster, a single-element list with just the anchor
   * is returned.
   *
   * @returns {Array<{sideIndex:number, bboxId:string}>}
   */
  function getClusterMembers(sideIndex, bboxId) {
    if (!_state) return [];
    const anchorKey = _bboxNodeKey(sideIndex, bboxId);
    const validNodes = _validNodeSet();
    if (!validNodes.has(anchorKey)) return [];

    const uf = createUnionFind(Array.from(validNodes));
    for (const link of _state.confirmedLinks) {
      const a = _bboxNodeKey(link.sideA, link.bboxIdA);
      const b = _bboxNodeKey(link.sideB, link.bboxIdB);
      if (validNodes.has(a) && validNodes.has(b)) uf.union(a, b);
    }

    const root = uf.find(anchorKey);
    const members = [];
    for (const side of _state.sides) {
      for (const bbox of side.bboxes) {
        const key = _bboxNodeKey(side.sideIndex, bbox.id);
        if (uf.find(key) === root) {
          members.push({ sideIndex: side.sideIndex, bboxId: bbox.id });
        }
      }
    }
    return members;
  }

  /**
   * Change the class of a bbox and (by default) propagate the change to every
   * other bbox in the same confirmed cluster. Returns the list of affected
   * members so callers can refresh the UI.
   *
   * @param {number}  sideIndex
   * @param {string}  bboxId
   * @param {number}  classId
   * @param {object}  [opts]
   * @param {boolean} [opts.propagate=true]
   * @returns {Array<{sideIndex:number, bboxId:string}>}
   */
  function setBboxClass(sideIndex, bboxId, classId, opts = {}) {
    if (!_state) return [];
    const propagate = opts.propagate !== false;
    const className = (typeof CLASS_MAP !== 'undefined' && CLASS_MAP[classId]) || ('C' + classId);
    const targets = propagate
      ? getClusterMembers(sideIndex, bboxId)
      : [{ sideIndex, bboxId }];

    if (targets.length === 0) {
      updateBbox(sideIndex, bboxId, { classId, className });
      return [{ sideIndex, bboxId }];
    }
    for (const t of targets) {
      updateBbox(t.sideIndex, t.bboxId, { classId, className });
    }
    return targets;
  }

  /**
   * Propagate the CURRENT class of a bbox to the rest of its cluster. Useful
   * when a class was mutated outside `setBboxClass` (e.g. by the bbox editor)
   * and we still want cluster-wide consistency.
   */
  function propagateClassFromBox(sideIndex, bboxId) {
    if (!_state) return [];
    const side = _state.sides[sideIndex];
    if (!side) return [];
    const anchor = side.bboxes.find(b => b.id === bboxId);
    if (!anchor) return [];
    return setBboxClass(sideIndex, bboxId, anchor.classId, { propagate: true });
  }

  /**
   * Return clusters whose members disagree on class. Each entry has all member
   * refs, the set of observed classIds, and the majority-vote classId. Used to
   * drive the mismatch-resolve modal before compute / auto-save.
   */
  function getMismatchedClusters() {
    if (!_state) return [];
    const validNodes = _validNodeSet();
    const uf = createUnionFind(Array.from(validNodes));
    for (const link of _state.confirmedLinks) {
      const a = _bboxNodeKey(link.sideA, link.bboxIdA);
      const b = _bboxNodeKey(link.sideB, link.bboxIdB);
      if (validNodes.has(a) && validNodes.has(b)) uf.union(a, b);
    }

    const byRoot = new Map();
    for (const side of _state.sides) {
      for (const bbox of side.bboxes) {
        const key = _bboxNodeKey(side.sideIndex, bbox.id);
        if (!validNodes.has(key)) continue;
        const root = uf.find(key);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push({
          sideIndex: side.sideIndex,
          bboxId: bbox.id,
          classId: bbox.classId,
          className: bbox.className,
        });
      }
    }

    const mismatches = [];
    for (const members of byRoot.values()) {
      if (members.length < 2) continue;
      const classSet = new Set(members.map(m => m.classId));
      if (classSet.size <= 1) continue;

      const votes = {};
      for (const m of members) votes[m.classId] = (votes[m.classId] || 0) + 1;
      const majorityClassId = Number(
        Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0]
      );

      mismatches.push({
        members,
        classIds: Array.from(classSet),
        majorityClassId,
      });
    }
    return mismatches;
  }

  // ── Dedup Links ────────────────────────────────────────────────────────────

  function runSuggestions(opts) {
    if (!_state) return;
    _state.suggestedLinks = [];
    for (const [iA, iB] of ADJACENT_PAIRS) {
      const sA = _state.sides[iA], sB = _state.sides[iB];
      if (!sA.imageWidth || !sB.imageWidth) continue;
      const pairs = suggestPairs(
        sA.bboxes, { w: sA.imageWidth, h: sA.imageHeight },
        sB.bboxes, { w: sB.imageWidth, h: sB.imageHeight },
        opts
      );
      for (const p of pairs) {
        const alreadyConfirmed = _state.confirmedLinks.some(
          l => l.sideA === iA && l.bboxIdA === p.bboxIdA && l.sideB === iB && l.bboxIdB === p.bboxIdB
        );
        if (alreadyConfirmed) continue;
        _state.suggestedLinks.push({
          linkId: 'sug-' + (_linkSeq++),
          sideA: iA, bboxIdA: p.bboxIdA,
          sideB: iB, bboxIdB: p.bboxIdB,
          score: p.score, category: p.category, signals: p.signals,
        });
      }
    }
  }

  function confirmLink(linkId) {
    const idx = _state.suggestedLinks.findIndex(l => l.linkId === linkId);
    if (idx === -1) return;
    const link = _state.suggestedLinks.splice(idx, 1)[0];
    addManualLink(link.sideA, link.bboxIdA, link.sideB, link.bboxIdB);
  }

  function confirmAllAutoForPair(sideA, sideB) {
    if (!_state) return;
    const autos = _state.suggestedLinks.filter(
      l => l.category === 'auto' && _isSameSidePair(l, sideA, sideB)
    );
    for (const l of autos) {
      addManualLink(l.sideA, l.bboxIdA, l.sideB, l.bboxIdB);
    }
    _state.suggestedLinks = _state.suggestedLinks.filter(
      l => !(l.category === 'auto' && _isSameSidePair(l, sideA, sideB))
    );
  }

  function rejectLink(linkId) {
    _state.suggestedLinks = _state.suggestedLinks.filter(l => l.linkId !== linkId);
  }

  function _linkUsesBox(link, sideIdx, bboxId) {
    return (link.sideA === sideIdx && link.bboxIdA === bboxId) ||
           (link.sideB === sideIdx && link.bboxIdB === bboxId);
  }

  function _pairKey(sideA, sideB) {
    return sideA < sideB ? `${sideA}:${sideB}` : `${sideB}:${sideA}`;
  }

  function _bboxNodeKey(sideIdx, bboxId) {
    return `${sideIdx}:${bboxId}`;
  }

  function _endpointDedupKey(sideA, bboxIdA, sideB, bboxIdB) {
    const a = _bboxNodeKey(sideA, bboxIdA);
    const b = _bboxNodeKey(sideB, bboxIdB);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function _buildAdjacentPairSet() {
    const set = new Set();
    for (const [sideA, sideB] of ADJACENT_PAIRS) {
      set.add(_pairKey(sideA, sideB));
    }
    return set;
  }

  function _buildAdjacentPairMap() {
    const map = new Map();
    for (const [sideA, sideB] of ADJACENT_PAIRS) {
      map.set(_pairKey(sideA, sideB), [sideA, sideB]);
    }
    return map;
  }

  function _isAdjacentSidePair(sideA, sideB) {
    return ADJACENT_PAIRS.some(
      ([a, b]) => (a === sideA && b === sideB) || (a === sideB && b === sideA)
    );
  }

  function _isSameSidePair(link, sideA, sideB) {
    return (link.sideA === sideA && link.sideB === sideB) ||
           (link.sideA === sideB && link.sideB === sideA);
  }

  function _isSameLink(link, sideA, bboxIdA, sideB, bboxIdB) {
    return (link.sideA === sideA && link.bboxIdA === bboxIdA && link.sideB === sideB && link.bboxIdB === bboxIdB) ||
           (link.sideA === sideB && link.bboxIdA === bboxIdB && link.sideB === sideA && link.bboxIdB === bboxIdA);
  }

  function _orientToAdjacentPair(sideA, bboxIdA, sideB, bboxIdB, pairMap) {
    const oriented = pairMap.get(_pairKey(sideA, sideB));
    if (!oriented) return { sideA, bboxIdA, sideB, bboxIdB };

    if (sideA === oriented[0] && sideB === oriented[1]) {
      return { sideA, bboxIdA, sideB, bboxIdB };
    }
    if (sideA === oriented[1] && sideB === oriented[0]) {
      return { sideA: sideB, bboxIdA: bboxIdB, sideB: sideA, bboxIdB: bboxIdA };
    }
    return { sideA, bboxIdA, sideB, bboxIdB };
  }

  function addManualLink(sideA, bboxIdA, sideB, bboxIdB) {
    if (!_isAdjacentSidePair(sideA, sideB)) return null;

    const existing = _state.confirmedLinks.find(l => _isSameLink(l, sideA, bboxIdA, sideB, bboxIdB));
    if (existing) return existing;

    // Manual linking should be override-able within the active side pair,
    // but must not remove links from other adjacent pairs.
    _state.confirmedLinks = _state.confirmedLinks.filter(l =>
      !(_isSameSidePair(l, sideA, sideB) && (
        _linkUsesBox(l, sideA, bboxIdA) ||
        _linkUsesBox(l, sideB, bboxIdB)
      ))
    );

    // Drop stale suggestions touching either endpoint in this pair only.
    _state.suggestedLinks = _state.suggestedLinks.filter(l =>
      !(_isSameSidePair(l, sideA, sideB) && (
        _linkUsesBox(l, sideA, bboxIdA) ||
        _linkUsesBox(l, sideB, bboxIdB)
      ))
    );

    const link = {
      linkId: 'lnk-' + (_linkSeq++),
      sideA, bboxIdA, sideB, bboxIdB,
    };
    _state.confirmedLinks.push(link);
    _markDirty();
    return link;
  }

  function removeConfirmedLink(linkId) {
    _state.confirmedLinks = _state.confirmedLinks.filter(l => l.linkId !== linkId);
    _markDirty();
  }

  function isDirty() { return _state ? _state.dirty : false; }
  function markClean() { if (_state) _state.dirty = false; }

  function _validNodeSet() {
    const set = new Set();
    if (!_state) return set;
    for (const side of _state.sides) {
      for (const bbox of side.bboxes) {
        set.add(_bboxNodeKey(side.sideIndex, bbox.id));
      }
    }
    return set;
  }

  function _normalizeRawLink(raw) {
    if (!raw) return null;
    const sideA = Number(raw.sideA);
    const sideB = Number(raw.sideB);
    const bboxIdA = typeof raw.bboxIdA === 'string' ? raw.bboxIdA : null;
    const bboxIdB = typeof raw.bboxIdB === 'string' ? raw.bboxIdB : null;
    if (!Number.isInteger(sideA) || !Number.isInteger(sideB)) return null;
    if (!bboxIdA || !bboxIdB) return null;
    if (sideA === sideB) return null;
    return { sideA, bboxIdA, sideB, bboxIdB };
  }

  function _sanitizeConfirmedLinks(rawLinks) {
    if (!_state || !Array.isArray(rawLinks) || rawLinks.length === 0) return [];

    const validNodes = _validNodeSet();
    const pairSet = _buildAdjacentPairSet();
    const pairMap = _buildAdjacentPairMap();
    const links = [];
    const nodeKeys = new Set();
    const nodeMeta = new Map();

    for (const raw of rawLinks) {
      const link = _normalizeRawLink(raw);
      if (!link) continue;

      const nodeA = _bboxNodeKey(link.sideA, link.bboxIdA);
      const nodeB = _bboxNodeKey(link.sideB, link.bboxIdB);
      if (!validNodes.has(nodeA) || !validNodes.has(nodeB)) continue;

      links.push({ ...link, nodeA, nodeB });
      nodeKeys.add(nodeA);
      nodeKeys.add(nodeB);
      nodeMeta.set(nodeA, { sideIndex: link.sideA, bboxId: link.bboxIdA });
      nodeMeta.set(nodeB, { sideIndex: link.sideB, bboxId: link.bboxIdB });
    }

    if (links.length === 0) return [];

    const uf = createUnionFind(Array.from(nodeKeys));
    for (const link of links) {
      uf.union(link.nodeA, link.nodeB);
    }

    const clusterLinks = new Map();
    const clusterNodes = new Map();
    for (const link of links) {
      const root = uf.find(link.nodeA);
      if (!clusterLinks.has(root)) clusterLinks.set(root, []);
      if (!clusterNodes.has(root)) clusterNodes.set(root, new Set());
      clusterLinks.get(root).push(link);
      clusterNodes.get(root).add(link.nodeA);
      clusterNodes.get(root).add(link.nodeB);
    }

    const out = [];
    const seen = new Set();

    function pushLink(sideA, bboxIdA, sideB, bboxIdB) {
      if (!pairSet.has(_pairKey(sideA, sideB))) return;
      const oriented = _orientToAdjacentPair(sideA, bboxIdA, sideB, bboxIdB, pairMap);
      const dedupKey = _endpointDedupKey(
        oriented.sideA,
        oriented.bboxIdA,
        oriented.sideB,
        oriented.bboxIdB
      );
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      out.push({
        sideA: oriented.sideA,
        bboxIdA: oriented.bboxIdA,
        sideB: oriented.sideB,
        bboxIdB: oriented.bboxIdB,
      });
    }

    for (const [root, compLinks] of clusterLinks.entries()) {
      for (const link of compLinks) {
        if (pairSet.has(_pairKey(link.sideA, link.sideB))) {
          pushLink(link.sideA, link.bboxIdA, link.sideB, link.bboxIdB);
        }
      }

      const hasNonAdjacent = compLinks.some(link => !pairSet.has(_pairKey(link.sideA, link.sideB)));
      if (!hasNonAdjacent) continue;

      const sideToNodes = new Map();
      for (const nodeKey of clusterNodes.get(root)) {
        const meta = nodeMeta.get(nodeKey);
        if (!meta) continue;
        if (!sideToNodes.has(meta.sideIndex)) sideToNodes.set(meta.sideIndex, []);
        sideToNodes.get(meta.sideIndex).push(meta);
      }

      const singleNodePerSide = Array.from(sideToNodes.values()).every(nodes => nodes.length === 1);
      if (!singleNodePerSide) continue;

      for (const [sideA, sideB] of ADJACENT_PAIRS) {
        const nodeA = sideToNodes.get(sideA);
        const nodeB = sideToNodes.get(sideB);
        if (!nodeA || !nodeB) continue;
        pushLink(sideA, nodeA[0].bboxId, sideB, nodeB[0].bboxId);
      }
    }

    return out.map((l, idx) => ({
      linkId: 'lnk-' + idx,
      sideA: l.sideA,
      bboxIdA: l.bboxIdA,
      sideB: l.sideB,
      bboxIdB: l.bboxIdB,
    }));
  }

  function _sanitizeSuggestedLinks(rawLinks, confirmedLinks) {
    if (!_state || !Array.isArray(rawLinks) || rawLinks.length === 0) return [];

    const validNodes = _validNodeSet();
    const pairSet = _buildAdjacentPairSet();
    const pairMap = _buildAdjacentPairMap();
    const confirmedSet = new Set(
      (confirmedLinks || []).map(l => _endpointDedupKey(l.sideA, l.bboxIdA, l.sideB, l.bboxIdB))
    );
    const seen = new Set();
    const out = [];

    for (const raw of rawLinks) {
      const link = _normalizeRawLink(raw);
      if (!link) continue;

      const nodeA = _bboxNodeKey(link.sideA, link.bboxIdA);
      const nodeB = _bboxNodeKey(link.sideB, link.bboxIdB);
      if (!validNodes.has(nodeA) || !validNodes.has(nodeB)) continue;
      if (!pairSet.has(_pairKey(link.sideA, link.sideB))) continue;

      const oriented = _orientToAdjacentPair(link.sideA, link.bboxIdA, link.sideB, link.bboxIdB, pairMap);
      const dedupKey = _endpointDedupKey(
        oriented.sideA,
        oriented.bboxIdA,
        oriented.sideB,
        oriented.bboxIdB
      );
      if (confirmedSet.has(dedupKey) || seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const score = Number(raw.score);
      out.push({
        linkId: 'sug-' + out.length,
        sideA: oriented.sideA,
        bboxIdA: oriented.bboxIdA,
        sideB: oriented.sideB,
        bboxIdB: oriented.bboxIdB,
        score: Number.isFinite(score) ? score : 0,
        category: raw.category === 'auto' ? 'auto' : 'candidate',
        signals: raw.signals,
      });
    }

    return out;
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  function toJSON() {
    if (!_state) return null;
    return {
      version: 1,
      treeName: _state.treeName,
      split: _state.split,
      sides: _state.sides.map(s => ({
        sideIndex: s.sideIndex,
        label: s.label,
        imageWidth: s.imageWidth,
        imageHeight: s.imageHeight,
        bboxes: _deepCloneBboxes(s.bboxes),
      })),
      suggestedLinks: [..._state.suggestedLinks],
      confirmedLinks: [..._state.confirmedLinks],
    };
  }

  async function fromJSON(saved, datasetTree) {
    await loadTree(datasetTree);
    for (const ss of saved.sides) {
      const side = _state.sides[ss.sideIndex];
      if (!side) continue;
      side.bboxes = _deepCloneBboxes(ss.bboxes);
      side.originalBboxes = _deepCloneBboxes(ss.bboxes);
      // Restore saved dimensions in case image wasn't loaded
      if (!side.imageWidth && ss.imageWidth) side.imageWidth = ss.imageWidth;
      if (!side.imageHeight && ss.imageHeight) side.imageHeight = ss.imageHeight;
    }

    const sanitizedConfirmed = _sanitizeConfirmedLinks(saved.confirmedLinks || []);
    const sanitizedSuggested = _sanitizeSuggestedLinks(saved.suggestedLinks || [], sanitizedConfirmed);

    _state.confirmedLinks = sanitizedConfirmed;
    _state.suggestedLinks = sanitizedSuggested;
    _linkSeq = _state.confirmedLinks.length + _state.suggestedLinks.length;
    _state.dirty = false;
    return _state;
  }

  return {
    loadTree, fromJSON, get,
    addBbox, removeBbox, updateBbox,
    setBboxClass, propagateClassFromBox, getClusterMembers, getMismatchedClusters,
    runSuggestions, confirmLink, confirmAllAutoForPair,
    rejectLink, addManualLink, removeConfirmedLink,
    isDirty, markClean, toJSON,
    get ADJACENT_PAIRS() { return ADJACENT_PAIRS; },
    get TREE_SIDE_LABELS() { return TREE_SIDE_LABELS; },
    get sideCount() { return _state ? _state.sides.length : TREE_SIDE_LABELS.length; },
  };
})();

window.ActiveSession = ActiveSession;
window.TREE_SIDE_LABELS = TREE_SIDE_LABELS;
window.ADJACENT_PAIRS = ADJACENT_PAIRS;
window.generateSideLabels = generateSideLabels;
window.generateAdjacentPairs = generateAdjacentPairs;
