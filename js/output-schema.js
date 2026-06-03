'use strict';

/**
 * OutputSchema - generates the SawitMVC output JSON for a single tree.
 *
 * Format:
 *   - tree_id:   canonical tree name
 *   - images:    per-side image info + annotations with both YOLO & pixel coords
 *   - bunches:   unique bunches with cross-references to side + box_index
 *   - summary:   counts
 *
 * This JSON is self-contained: bbox coordinates are duplicated into the bunches
 * array so downstream consumers don't need the original label files.
 */
const OutputSchema = (() => {

  function _bboxKey(sideIndex, bboxId) {
    return `${sideIndex}:${bboxId}`;
  }

  function _pairKey(sideA, sideB) {
    return sideA < sideB ? `${sideA}:${sideB}` : `${sideB}:${sideA}`;
  }

  function _buildAdjacentPairs(totalSides) {
    if (totalSides < 2) return [];
    if (totalSides === 2) return [[0, 1]];
    return Array.from({ length: totalSides }, (_, i) => [i, (i + 1) % totalSides]);
  }

  function _buildAdjacentPairSet(totalSides) {
    const set = new Set();
    for (const [sideA, sideB] of _buildAdjacentPairs(totalSides)) {
      set.add(_pairKey(sideA, sideB));
    }
    return set;
  }

  function _buildAdjacentPairMap(totalSides) {
    const map = new Map();
    for (const [sideA, sideB] of _buildAdjacentPairs(totalSides)) {
      map.set(_pairKey(sideA, sideB), [sideA, sideB]);
    }
    return map;
  }

  function _isAdjacentPair(sideA, sideB, pairSet) {
    return pairSet.has(_pairKey(sideA, sideB));
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

  function _linkDedupKey(sideA, bboxIdA, sideB, bboxIdB) {
    const left = _bboxKey(sideA, bboxIdA);
    const right = _bboxKey(sideB, bboxIdB);
    return left < right ? `${left}|${right}` : `${right}|${left}`;
  }

  /**
   * Convert pixel-coord bbox to YOLO normalized format.
   */
  function _toYoloCoords(bbox, imgW, imgH) {
    const cx = ((bbox.x1 + bbox.x2) / 2) / imgW;
    const cy = ((bbox.y1 + bbox.y2) / 2) / imgH;
    const w  = (bbox.x2 - bbox.x1) / imgW;
    const h  = (bbox.y2 - bbox.y1) / imgH;
    return [
      parseFloat(cx.toFixed(6)),
      parseFloat(cy.toFixed(6)),
      parseFloat(w.toFixed(6)),
      parseFloat(h.toFixed(6)),
    ];
  }

  /**
   * Get a stable side key for a given side index.
   * Uniform numeric naming: always "side_N" (1-based) regardless of total sides.
   * The `totalSides` argument is retained for backward-compatibility with
   * existing call sites but is no longer used for key selection.
   */
  function _sideKey(sideIndex /*, totalSides */) {
    return 'side_' + (sideIndex + 1);
  }

  /**
   * Build a map from bbox ID → { sideIndex, boxIndex } for quick lookup.
   */
  function _buildBboxIndexMap(session) {
    const map = new Map();
    for (const side of session.sides) {
      side.bboxes.forEach((bbox, boxIdx) => {
        map.set(_bboxKey(side.sideIndex, bbox.id), { sideIndex: side.sideIndex, boxIndex: boxIdx });
      });
    }
    return map;
  }

  /**
   * Derive variety from a tree_name (e.g. "DAMIMAS_A21B_0001" → "DAMIMAS",
   * "LONSUM_A21A_0099" -> "LONSUM"). The value is derived per tree.
   */
  function _deriveVarietyFromTreeName(treeName) {
    if (typeof treeName === 'string') {
      const m = treeName.match(/^([A-Za-z]+)_/);
      if (m) return m[1].toUpperCase();
    }
    return 'UNKNOWN';
  }

  /**
   * Generate the full output JSON for a tree.
   *
   * @param {object} session      — ActiveSession.get()
   * @param {object} result       — Results.compute(session) output
   * @param {object} datasetTree  — DatasetManager.getTree() (for original filenames)
   * @returns {object}            — the output JSON object
   */
  function generate(session, result, datasetTree) {
    const totalSides = session.sides.length;
    const bboxIndexMap = _buildBboxIndexMap(session);
    const adjacentPairSet = _buildAdjacentPairSet(totalSides);
    const adjacentPairMap = _buildAdjacentPairMap(totalSides);

    // ── Images section ─────────────────────────────────────────────────────
    const images = {};
    for (const side of session.sides) {
      const key = _sideKey(side.sideIndex, totalSides);
      const imgW = side.imageWidth;
      const imgH = side.imageHeight;

      // Get original filenames from dataset tree
      const dSide = datasetTree && datasetTree.sides[side.sideIndex];
      const imageFilename = dSide && dSide.imageFile ? dSide.imageFile.name : `${session.treeName}_${side.sideIndex + 1}.jpg`;
      const labelFilename = dSide && dSide.labelFile
        ? dSide.labelFile.name
        : imageFilename.replace(/\.[^.]+$/, '.txt');

      const annotations = side.bboxes.map((bbox, boxIdx) => ({
        box_index: boxIdx,
        class_id: bbox.classId,
        class_name: bbox.className,
        bbox_yolo: _toYoloCoords(bbox, imgW, imgH),
        bbox_pixel: [
          Math.round(bbox.x1),
          Math.round(bbox.y1),
          Math.round(bbox.x2),
          Math.round(bbox.y2),
        ],
      }));

      images[key] = {
        filename: imageFilename,
        label_file: labelFilename,
        side_index: side.sideIndex,
        side_label: side.label,
        width: imgW,
        height: imgH,
        bbox_count: annotations.length,
        annotations,
      };
    }

    // ── Bunches section ────────────────────────────────────────────────────
    const bunches = [];
    if (result && result.clusters) {
      let bunchId = 1;
      for (const members of result.clusters.values()) {
        // Majority-vote class
        const votes = {};
        for (const b of members) {
          votes[b.className] = (votes[b.className] || 0) + 1;
        }
        const sortedVotes = Object.entries(votes).sort((a, b) => b[1] - a[1]);
        const dominantClass = sortedVotes[0][0];
        const classes = new Set(members.map(b => b.className));

        const appearances = members.map(b => {
          const info = bboxIndexMap.get(_bboxKey(b._sideIndex, b.id));
          const sKey = info ? _sideKey(info.sideIndex, totalSides) : 'unknown';
          return {
            side: sKey,
            side_index: info ? info.sideIndex : -1,
            box_index: info ? info.boxIndex : -1,
            class_name: b.className,
            bbox_pixel: [Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)],
          };
        });

        // Sort appearances by side_index for consistency
        appearances.sort((a, b) => a.side_index - b.side_index);

        bunches.push({
          bunch_id: bunchId++,
          class: dominantClass,
          class_mismatch: classes.size > 1,
          appearance_count: appearances.length,
          appearances,
        });
      }
    }

    // Persist exact confirmed links (adjacent-only) using box-index-stable IDs.
    const persistedConfirmedLinks = [];
    const persistedSeen = new Set();
    for (const link of (session.confirmedLinks || [])) {
      const infoA = bboxIndexMap.get(_bboxKey(link.sideA, link.bboxIdA));
      const infoB = bboxIndexMap.get(_bboxKey(link.sideB, link.bboxIdB));
      if (!infoA || !infoB) continue;
      if (!_isAdjacentPair(infoA.sideIndex, infoB.sideIndex, adjacentPairSet)) continue;

      const oriented = _orientToAdjacentPair(
        infoA.sideIndex,
        'b' + infoA.boxIndex,
        infoB.sideIndex,
        'b' + infoB.boxIndex,
        adjacentPairMap
      );
      const dedupKey = _linkDedupKey(oriented.sideA, oriented.bboxIdA, oriented.sideB, oriented.bboxIdB);
      if (persistedSeen.has(dedupKey)) continue;
      persistedSeen.add(dedupKey);

      persistedConfirmedLinks.push({
        linkId: typeof link.linkId === 'string' ? link.linkId : 'L' + persistedConfirmedLinks.length,
        sideA: oriented.sideA,
        bboxIdA: oriented.bboxIdA,
        sideB: oriented.sideB,
        bboxIdB: oriented.bboxIdB,
      });
    }

    // ── Summary section ────────────────────────────────────────────────────
    const summary = {
      total_unique_bunches: result ? result.uniqueCount : 0,
      total_detections: result ? result.rawCount : 0,
      duplicates_linked: result ? result.linkedCount : 0,
      by_class: result ? { ...result.classCounts } : {},
      by_side: {},
    };

    // Side counts by key name
    for (const side of session.sides) {
      const key = _sideKey(side.sideIndex, totalSides);
      summary.by_side[key] = side.bboxes.length;
    }

    // ── Full output ────────────────────────────────────────────────────────
    const variety = _deriveVarietyFromTreeName(session.treeName);
    return {
      version: 4,
      tree_id: session.treeName,
      tree_name: session.treeName,
      split: session.split,
      metadata: {
        variety,
        generated_at: new Date().toISOString(),
      },
      images,
      bunches,
      _confirmedLinks: persistedConfirmedLinks,
      summary,
    };
  }

  /**
   * Convert an output JSON (produced by `generate`) back into the session JSON
   * shape consumed by `ActiveSession.fromJSON()`.
   *
   * Bbox IDs are reconstructed as `"b" + boxIndex` so they line up with the
   * IDs that `ActiveSession.loadTree()` will assign when it re-parses the
   * label files from disk. This keeps `confirmedLinks` referentially valid.
   *
   * Suggestions are not preserved — the user can re-run them.
   */
  function toSessionJSON(outputJson) {
    if (!outputJson || !outputJson.images) {
      throw new Error('Invalid output JSON: missing "images" field.');
    }

    const sideEntries = Object.entries(outputJson.images)
      .map(([key, img]) => ({ key, img }))
      .sort((a, b) => a.img.side_index - b.img.side_index);

    const sides = sideEntries.map(({ img }) => ({
      sideIndex: img.side_index,
      label: typeof img.side_label === 'string' ? img.side_label.replace(/^Si(?:si)\b/, 'Side') : `Side ${img.side_index + 1}`,
      imageWidth: img.width,
      imageHeight: img.height,
      bboxes: (img.annotations || []).map((ann, i) => ({
        id: 'b' + (typeof ann.box_index === 'number' ? ann.box_index : i),
        classId: ann.class_id,
        className: ann.class_name,
        x1: ann.bbox_pixel[0],
        y1: ann.bbox_pixel[1],
        x2: ann.bbox_pixel[2],
        y2: ann.bbox_pixel[3],
      })),
    }));

    const sideBboxes = new Map(
      sides.map(side => [side.sideIndex, new Set(side.bboxes.map(b => b.id))])
    );
    const adjacentPairSet = _buildAdjacentPairSet(sides.length);
    const adjacentPairMap = _buildAdjacentPairMap(sides.length);

    const confirmedLinks = [];
    const seenLinks = new Set();
    let linkSeq = 0;

    function _pushConfirmedLink(sideA, bboxIdA, sideB, bboxIdB) {
      if (!_isAdjacentPair(sideA, sideB, adjacentPairSet)) return;
      if (!sideBboxes.get(sideA) || !sideBboxes.get(sideA).has(bboxIdA)) return;
      if (!sideBboxes.get(sideB) || !sideBboxes.get(sideB).has(bboxIdB)) return;

      const oriented = _orientToAdjacentPair(sideA, bboxIdA, sideB, bboxIdB, adjacentPairMap);
      const dedupKey = _linkDedupKey(oriented.sideA, oriented.bboxIdA, oriented.sideB, oriented.bboxIdB);
      if (seenLinks.has(dedupKey)) return;
      seenLinks.add(dedupKey);

      confirmedLinks.push({
        linkId: 'L' + (linkSeq++),
        sideA: oriented.sideA,
        bboxIdA: oriented.bboxIdA,
        sideB: oriented.sideB,
        bboxIdB: oriented.bboxIdB,
      });
    }

    if (Array.isArray(outputJson._confirmedLinks) && outputJson._confirmedLinks.length > 0) {
      for (const link of outputJson._confirmedLinks) {
        if (!link) continue;
        const sideA = Number(link.sideA);
        const sideB = Number(link.sideB);
        if (!Number.isInteger(sideA) || !Number.isInteger(sideB)) continue;
        if (typeof link.bboxIdA !== 'string' || typeof link.bboxIdB !== 'string') continue;
        _pushConfirmedLink(sideA, link.bboxIdA, sideB, link.bboxIdB);
      }
    } else {
      for (const bunch of (outputJson.bunches || [])) {
        const apps = (bunch.appearances || [])
          .map(app => ({
            sideIndex: Number(app.side_index),
            boxIndex: Number(app.box_index),
          }))
          .filter(app => Number.isInteger(app.sideIndex) && Number.isInteger(app.boxIndex))
          .sort((a, b) => {
            if (a.sideIndex !== b.sideIndex) return a.sideIndex - b.sideIndex;
            return a.boxIndex - b.boxIndex;
          });

        if (apps.length < 2) continue;
        for (let i = 0; i < apps.length - 1; i++) {
          for (let j = i + 1; j < apps.length; j++) {
            const a = apps[i];
            const b = apps[j];
            _pushConfirmedLink(a.sideIndex, 'b' + a.boxIndex, b.sideIndex, 'b' + b.boxIndex);
          }
        }
      }
    }

    return {
      version: 1,
      treeName: outputJson.tree_name,
      split: outputJson.split,
      sides,
      suggestedLinks: [],
      confirmedLinks,
    };
  }

  return { generate, toSessionJSON };
})();

window.OutputSchema = OutputSchema;
