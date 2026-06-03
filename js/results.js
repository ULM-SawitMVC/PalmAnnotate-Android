'use strict';

/**
 * Results — counting, display, and export for the active session.
 */

const Results = (() => {

  function _bboxKey(sideIndex, bboxId) {
    return `${sideIndex}:${bboxId}`;
  }

  // ── Counting ───────────────────────────────────────────────────────────────

  function compute(session) {
    const allBboxes = [];
    const sideCounts = {};

    for (const side of session.sides) {
      const label = side.label;
      sideCounts[label] = side.bboxes.length;
      for (const b of side.bboxes) {
        allBboxes.push({
          ...b,
          _sideIndex: side.sideIndex,
          _sideLabel: label,
          _nodeId: _bboxKey(side.sideIndex, b.id),
        });
      }
    }

    const rawCount = allBboxes.length;

    // Build union-find from confirmed links
    const allIds = allBboxes.map(b => b._nodeId);
    const allIdSet = new Set(allIds);
    const uf = createUnionFind(allIds);
    let linkedCount = 0;
    for (const link of session.confirmedLinks) {
      const idA = _bboxKey(link.sideA, link.bboxIdA);
      const idB = _bboxKey(link.sideB, link.bboxIdB);
      if (!allIdSet.has(idA) || !allIdSet.has(idB)) continue;
      const ra = uf.find(idA);
      const rb = uf.find(idB);
      if (ra !== rb) {
        uf.union(idA, idB);
        linkedCount++;
      }
    }

    // Group by cluster
    const clusters = new Map(); // root → [bbox, ...]
    for (const b of allBboxes) {
      const root = uf.find(b._nodeId);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(b);
    }

    const uniqueCount = clusters.size;

    // Class breakdown by majority vote per cluster
    const classCounts = { B1: 0, B2: 0, B3: 0, B4: 0, other: 0 };
    for (const members of clusters.values()) {
      const votes = {};
      for (const b of members) {
        votes[b.className] = (votes[b.className] || 0) + 1;
      }
      const dominant = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
      if (classCounts[dominant] !== undefined) classCounts[dominant]++;
      else classCounts.other++;
    }

    return { uniqueCount, rawCount, linkedCount, classCounts, sideCounts, clusters };
  }

  // ── Display ────────────────────────────────────────────────────────────────

  function render(result, container) {
    const { uniqueCount, rawCount, linkedCount, classCounts, sideCounts } = result;

    container.innerHTML = `
      <div class="results-stats">
        <div class="stat-card stat-unique">
          <div class="stat-value">${uniqueCount}</div>
          <div class="stat-label">Unique Bunches</div>
        </div>
        <div class="stat-card stat-raw">
          <div class="stat-value">${rawCount}</div>
          <div class="stat-label">Total Detections</div>
        </div>
        <div class="stat-card stat-linked">
          <div class="stat-value">${linkedCount}</div>
          <div class="stat-label">Linked Duplicates</div>
        </div>
      </div>

      <div class="results-tables">
        <div class="results-table-block">
          <h3>By Class</h3>
          <table class="data-table">
            <thead><tr><th>Class</th><th>Count</th></tr></thead>
            <tbody>
              ${Object.entries(classCounts)
                .filter(([k]) => k !== 'other')
                .map(([k, v]) => `<tr><td><span class="class-chip class-${k.toLowerCase()}">${k}</span></td><td>${v}</td></tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="results-table-block">
          <h3>By Side</h3>
          <table class="data-table">
            <thead><tr><th>Side</th><th>Bbox</th></tr></thead>
            <tbody>
              ${Object.entries(sideCounts)
                .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  function _download(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function exportYolo(session) {
    for (const side of session.sides) {
      if (!side.imageWidth) continue;
      const text = toYoloFormat(side.bboxes, side.imageWidth, side.imageHeight);
      const filename = `${session.treeName}_${side.sideIndex + 1}.txt`;
      _download(filename, text, 'text/plain');
    }
  }

  function exportJSON(session, result) {
    const data = {
      ...ActiveSession.toJSON(),
      result: result ? {
        uniqueCount: result.uniqueCount,
        rawCount: result.rawCount,
        linkedCount: result.linkedCount,
        classCounts: result.classCounts,
        sideCounts: result.sideCounts,
      } : null,
      exportedAt: new Date().toISOString(),
    };
    _download(
      `${session.treeName}_session.json`,
      JSON.stringify(data, null, 2),
      'application/json'
    );
  }

  function exportCSV(session, result) {
    if (!result) return;
    const { uniqueCount, rawCount, classCounts } = result;
    const header = 'tree_name,split,unique,raw,B1,B2,B3,B4';
    const row = [
      session.treeName,
      session.split,
      uniqueCount,
      rawCount,
      classCounts.B1 || 0,
      classCounts.B2 || 0,
      classCounts.B3 || 0,
      classCounts.B4 || 0,
    ].join(',');
    _download(`${session.treeName}_result.csv`, header + '\n' + row, 'text/csv');
  }

  function exportIdentityJSON(session, result) {
    if (!result || !result.clusters) return;

    const bunches = [];
    let bunchId = 1;
    const mismatchBunches = [];

    for (const members of result.clusters.values()) {
      const detections = members.map(b => ({
        side: b._sideIndex,
        sideName: b._sideLabel,
        bboxId: b.id,
        class: b.className,
        coords: [b.x1, b.y1, b.x2, b.y2],
      }));

      // Check class mismatch within cluster
      const classes = new Set(detections.map(d => d.class));
      const hasMismatch = classes.size > 1;

      const bunch = { id: bunchId++, classMismatch: hasMismatch, detections };
      bunches.push(bunch);
      if (hasMismatch) mismatchBunches.push(bunch);
    }

    const data = {
      tree_name: session.treeName,
      exportedAt: new Date().toISOString(),
      totalUniqueBunches: bunches.length,
      classMismatchCount: mismatchBunches.length,
      bunches,
    };

    _download(
      `${session.treeName}_identity.json`,
      JSON.stringify(data, null, 2),
      'application/json'
    );
  }

  function exportYoloWithMismatch(session, result) {
    if (!result || !result.clusters) return;

    // Collect mismatch bbox IDs
    const mismatchIds = new Set();
    for (const members of result.clusters.values()) {
      const classes = new Set(members.map(b => b.className));
      if (classes.size > 1) {
        for (const b of members) mismatchIds.add(b._nodeId || _bboxKey(b._sideIndex, b.id));
      }
    }

    for (const side of session.sides) {
      if (!side.imageWidth) continue;

      const normalBboxes = side.bboxes.filter(b => !mismatchIds.has(_bboxKey(side.sideIndex, b.id)));
      const mismatchBboxes = side.bboxes.filter(b => mismatchIds.has(_bboxKey(side.sideIndex, b.id)));

      // Main annotation file
      const text = toYoloFormat(normalBboxes, side.imageWidth, side.imageHeight);
      _download(`${session.treeName}_${side.sideIndex + 1}.txt`, text, 'text/plain');

      // Mismatch annotation file (separate)
      if (mismatchBboxes.length > 0) {
        const mText = toYoloFormat(mismatchBboxes, side.imageWidth, side.imageHeight);
        _download(`${session.treeName}_${side.sideIndex + 1}_mismatch.txt`, mText, 'text/plain');
      }
    }
  }

  return { compute, render, exportYolo, exportJSON, exportCSV, exportIdentityJSON, exportYoloWithMismatch };
})();

window.Results = Results;
