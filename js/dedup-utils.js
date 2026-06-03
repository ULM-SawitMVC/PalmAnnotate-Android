'use strict';

// ─── Union-Find (extracted from deduper.js) ──────────────────────────────────

function pairKey(aId, bId) {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

function createUnionFind(ids) {
  const parent = {};
  const rank   = {};
  for (const id of ids) { parent[id] = id; rank[id] = 0; }

  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) { parent[ra] = rb; }
    else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
    else { parent[rb] = ra; rank[ra]++; }
  }

  return { find, union, parent };
}

// ─── Geometric Dedup Algorithm ───────────────────────────────────────────────

function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Normalize pixel bbox to [0,1] range.
 */
function _norm(bbox, imgW, imgH) {
  return {
    x1: bbox.x1 / imgW,
    y1: bbox.y1 / imgH,
    x2: bbox.x2 / imgW,
    y2: bbox.y2 / imgH,
  };
}

/**
 * Vertical center proximity. Gravity keeps bunches at roughly the same trunk
 * height across adjacent photos.
 */
function _vertSig(nbA, nbB, tol) {
  const cyA = (nbA.y1 + nbA.y2) / 2;
  const cyB = (nbB.y1 + nbB.y2) / 2;
  return 1 - _clamp(Math.abs(cyA - cyB) / tol, 0, 1);
}

/**
 * Class as penalty MULTIPLIER (not additive signal).
 * Same class → 1.0, adjacent grade (±1) → 0.85, otherwise → 0.5.
 * A mismatch cannot zero the score on its own (label noise is common), but it
 * should degrade confidence enough to drop most wrong pairs below thresholds.
 */
function _classMultiplier(a, b) {
  if (a.classId === b.classId) return 1.0;
  if (Math.abs(a.classId - b.classId) === 1) return 0.85;
  return 0.5;
}

/**
 * Size + aspect similarity combined (logic from legacy deduper.js).
 */
function _sizeSig(nbA, nbB) {
  const eps = 1e-6;
  const areaA = Math.max((nbA.x2 - nbA.x1) * (nbA.y2 - nbA.y1), eps);
  const areaB = Math.max((nbB.x2 - nbB.x1) * (nbB.y2 - nbB.y1), eps);
  const areaSim = 1 - _clamp(Math.abs(areaA - areaB) / Math.max(areaA, areaB), 0, 1);
  const arA = Math.max((nbA.x2 - nbA.x1) / Math.max(nbA.y2 - nbA.y1, eps), eps);
  const arB = Math.max((nbB.x2 - nbB.x1) / Math.max(nbB.y2 - nbB.y1, eps), eps);
  const aspectSim = 1 - _clamp(Math.abs(arA - arB) / Math.max(arA, arB), 0, 1);
  return 0.6 * areaSim + 0.4 * aspectSim;
}

/**
 * Suggest cross-side duplicate pairs using pure geometry.
 *
 * Photography geometry assumption (clockwise rotation around the tree):
 *   sideA's LEFT edge meets sideB's RIGHT edge at the shared corner.
 *
 * Phase 1+2 algorithm:
 *   1. HARD gate by "seam band": only bboxes whose center lies in the half of
 *      the image closest to the shared edge are candidates. A bunch that lives
 *      on the far side of one photo cannot physically also appear in the other.
 *   2. HARD gate by size ratio: pairs with drastically different areas are
 *      dropped before scoring (they are almost never the same physical bunch).
 *   3. Score = (0.45·seam + 0.35·vert + 0.20·size) · classMultiplier.
 *      Class acts as a *penalty* multiplier, not an additive reward.
 *   4. MUTUAL BEST assignment: keep pair (A,B) only if A's top-scoring partner
 *      is B and B's top-scoring partner is A. Prevents one well-positioned
 *      bunch from monopolising matches.
 *
 * @param {Array}  bboxesA
 * @param {{w:number, h:number}} imgA
 * @param {Array}  bboxesB
 * @param {{w:number, h:number}} imgB
 * @param {Object} [opts]
 * @param {number} [opts.autoMin=0.75]            score >= autoMin → 'auto'
 * @param {number} [opts.candidateMin=0.50]       score >= candidateMin → 'candidate'
 * @param {number} [opts.seamBandFraction=0.50]   fraction of image width (from seam) that is eligible
 * @param {number} [opts.vertTol=0.20]            fraction of image height tolerated for vertical drift
 * @param {number} [opts.sizeRatioMin=0.30]       hard gate: min(areaA,areaB)/max >= this
 * @param {boolean}[opts.mutualBest=true]         require mutual top-pick (falls back to greedy if false)
 * @returns {Array<{bboxIdA, bboxIdB, score, category, signals}>}
 */
function suggestPairs(bboxesA, imgA, bboxesB, imgB, opts = {}) {
  const autoMin          = opts.autoMin          ?? 0.75;
  const candidateMin     = opts.candidateMin     ?? 0.50;
  const seamBandFraction = opts.seamBandFraction ?? 0.50;
  const vertTol          = opts.vertTol          ?? 0.20;
  const sizeRatioMin     = opts.sizeRatioMin     ?? 0.30;
  const mutualBest       = opts.mutualBest       ?? true;

  // ── Stage 1: hard gate by seam band ────────────────────────────────────
  // sideA: shared edge is LEFT (x≈0)  → keep bboxes whose center is in [0, band]
  // sideB: shared edge is RIGHT (x≈1) → keep bboxes whose center is in [1-band, 1]
  const gatedA = [];
  for (const bA of bboxesA) {
    const nbA = _norm(bA, imgA.w, imgA.h);
    const cx  = (nbA.x1 + nbA.x2) / 2;
    if (cx <= seamBandFraction) gatedA.push({ b: bA, nb: nbA, cx });
  }
  const gatedB = [];
  for (const bB of bboxesB) {
    const nbB = _norm(bB, imgB.w, imgB.h);
    const cx  = (nbB.x1 + nbB.x2) / 2;
    if (cx >= (1 - seamBandFraction)) gatedB.push({ b: bB, nb: nbB, cx });
  }

  // ── Stage 2: score every surviving cross-side pair ─────────────────────
  const scored = [];
  for (let i = 0; i < gatedA.length; i++) {
    const { b: bA, nb: nbA, cx: cxA } = gatedA[i];
    for (let j = 0; j < gatedB.length; j++) {
      const { b: bB, nb: nbB, cx: cxB } = gatedB[j];

      // Hard size ratio gate
      const eps = 1e-6;
      const areaA = Math.max((nbA.x2 - nbA.x1) * (nbA.y2 - nbA.y1), eps);
      const areaB = Math.max((nbB.x2 - nbB.x1) * (nbB.y2 - nbB.y1), eps);
      const sizeRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
      if (sizeRatio < sizeRatioMin) continue;

      // Continuous seam signal within the gated band (replaces old edge product).
      // Each side contributes a score in [0,1]; closer to the seam → 1.0.
      const seamA = 1 - _clamp(cxA / seamBandFraction, 0, 1);
      const seamB = 1 - _clamp((1 - cxB) / seamBandFraction, 0, 1);
      const seamSig = (seamA + seamB) / 2;

      const vSig = _vertSig(nbA, nbB, vertTol);
      const sSig = _sizeSig(nbA, nbB);
      const classMult = _classMultiplier(bA, bB);

      const baseScore = 0.45 * seamSig + 0.35 * vSig + 0.20 * sSig;
      const score = _clamp(baseScore * classMult, 0, 1);

      if (score < candidateMin) continue;

      scored.push({
        aIdx: i, bIdx: j,
        bboxIdA: bA.id, bboxIdB: bB.id,
        score,
        signals: {
          seam: +seamSig.toFixed(3),
          vert: +vSig.toFixed(3),
          size: +sSig.toFixed(3),
          cls:  +classMult.toFixed(2),
          sizeRatio: +sizeRatio.toFixed(3),
        },
      });
    }
  }

  // ── Stage 3: pair selection (mutual best or greedy fallback) ───────────
  let chosen;
  if (mutualBest) {
    const bestForA = new Map();
    const bestForB = new Map();
    for (const p of scored) {
      const cA = bestForA.get(p.aIdx);
      if (!cA || p.score > cA.score) bestForA.set(p.aIdx, p);
      const cB = bestForB.get(p.bIdx);
      if (!cB || p.score > cB.score) bestForB.set(p.bIdx, p);
    }
    chosen = [];
    for (const [aIdx, p] of bestForA) {
      const bBest = bestForB.get(p.bIdx);
      if (bBest && bBest.aIdx === aIdx) chosen.push(p);
    }
  } else {
    scored.sort((x, y) => y.score - x.score);
    const usedA = new Set(), usedB = new Set();
    chosen = [];
    for (const p of scored) {
      if (usedA.has(p.aIdx) || usedB.has(p.bIdx)) continue;
      usedA.add(p.aIdx);
      usedB.add(p.bIdx);
      chosen.push(p);
    }
  }

  return chosen.map(p => ({
    bboxIdA: p.bboxIdA,
    bboxIdB: p.bboxIdB,
    score: p.score,
    signals: p.signals,
    category: p.score >= autoMin ? 'auto' : 'candidate',
  }));
}
