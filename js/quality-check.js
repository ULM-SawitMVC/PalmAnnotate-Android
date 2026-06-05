'use strict';

/**
 * QualityCheck — compact, deterministic validation used by capture review,
 * annotation status cards, and export-readiness prompts. It is deliberately
 * conservative: raw capture/export is still allowed, but the operator gets clear
 * warnings before leaving the field with incomplete RGB-D pairs or metadata.
 */
const QualityCheck = (() => {
  const LEVEL_RANK = { ok: 0, info: 1, warn: 2, error: 3 };

  function _issue(level, code, message, detail) {
    return { level, code, message, detail: detail || '' };
  }

  function _status(issues) {
    let rank = 0;
    for (const it of issues || []) rank = Math.max(rank, LEVEL_RANK[it.level] || 0);
    return rank >= 3 ? 'error' : (rank >= 2 ? 'warn' : 'ok');
  }

  function _isPresent(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
  }

  function _hasImageSide(side) {
    return !!(side && (side.imageUri || side.imageUrl || side.imageFile || side.blob));
  }

  function _hasDepthSide(side) {
    return !!(side && (side.depthBlob || side.depthUri || side.depthFile || side.depth));
  }

  function _metaIssues(metadata, opts = {}) {
    const issues = [];
    const md = metadata || {};
    if (!metadata) {
      issues.push(_issue('error', 'metadata_missing', 'Metadata tree belum ada.'));
      return issues;
    }
    if (!_isPresent(md.variety)) issues.push(_issue('error', 'metadata_variety_missing', 'Metadata variety belum terisi.'));
    if (opts.requireBlok !== false && !_isPresent(md.blok)) issues.push(_issue('warn', 'metadata_blok_missing', 'Metadata blok belum terisi.'));
    if (opts.requireTreeId !== false && !_isPresent(md.treeId) && !_isPresent(md.tree_id)) issues.push(_issue('warn', 'metadata_tree_id_missing', 'Metadata tree_id belum terisi.'));
    if (!_isPresent(md.timestamp)) issues.push(_issue('error', 'metadata_timestamp_missing', 'Timestamp capture belum tersimpan.'));
    if (!_isPresent(md.operator)) issues.push(_issue('info', 'metadata_operator_missing', 'Operator kosong; isi jika dibutuhkan untuk audit field.'));
    if (!md.gps) {
      issues.push(_issue('warn', 'metadata_gps_missing', 'GPS belum tersimpan; untuk uji outdoor sebaiknya ambil lokasi.'));
    } else if (typeof md.gps.accuracy === 'number' && md.gps.accuracy > 25) {
      issues.push(_issue('warn', 'metadata_gps_low_accuracy', `Akurasi GPS rendah (±${Math.round(md.gps.accuracy)} m).`));
    }
    return issues;
  }

  function analyzeCaptureShots(shots, sideCount, metadata) {
    const expected = Math.max(1, Math.floor(Number(sideCount) || (shots && shots.length) || 0));
    const arr = Array.isArray(shots) ? shots : [];
    const issues = _metaIssues(metadata, { requireBlok: !!(metadata && metadata.blok), requireTreeId: !!(metadata && (metadata.blok || metadata.treeId)) });
    let captured = 0;
    let withDepth = 0;
    const sides = [];

    for (let i = 0; i < expected; i++) {
      const shot = arr[i] || null;
      const hasImage = !!(shot && shot.blob);
      const hasDepth = !!(shot && shot.depthBlob);
      if (hasImage) captured++;
      if (hasDepth) withDepth++;
      if (!hasImage) issues.push(_issue('error', 'capture_view_missing', `View ${i + 1} belum ada foto RGB.`));
      if (shot && (!shot.width || !shot.height)) issues.push(_issue('warn', 'capture_size_missing', `View ${i + 1} tidak punya ukuran image.`));
      if (hasDepth && (!shot.depth || !shot.depth.width || !shot.depth.height)) {
        issues.push(_issue('warn', 'capture_depth_meta_missing', `View ${i + 1} punya raw depth, tapi metadata depth belum lengkap.`));
      }
      sides.push({ side: i + 1, hasImage, hasDepth, width: shot && shot.width || 0, height: shot && shot.height || 0 });
    }

    if (withDepth > 0 && withDepth < captured) {
      issues.push(_issue('warn', 'capture_rgb_depth_incomplete', `Pasangan RGB/depth belum lengkap: ${withDepth}/${captured} view punya depth.`));
    }

    return {
      status: _status(issues),
      issues,
      metrics: { expectedSides: expected, capturedSides: captured, depthSides: withDepth, sides },
    };
  }

  function analyzeTree(tree, session, opts = {}) {
    const issues = [];
    const sides = (tree && Array.isArray(tree.sides)) ? tree.sides : [];
    const sessionSides = (session && Array.isArray(session.sides)) ? session.sides : [];
    const expected = Math.max(1, Math.floor(Number(opts.expectedSideCount || tree && tree.sideCount || session && session.sideCount || sides.length || sessionSides.length || 0)));
    const metadata = (tree && tree.metadata) || (session && session.metadata) || {};
    issues.push(..._metaIssues(metadata, { requireBlok: !!(metadata && metadata.blok), requireTreeId: !!(metadata && (metadata.blok || metadata.treeId)) }));

    let imageSides = 0;
    let depthSides = 0;
    let totalBoxes = 0;
    const emptyAnnotationSides = [];
    const sideMetrics = [];

    for (let i = 0; i < expected; i++) {
      const dSide = sides[i] || null;
      const sSide = sessionSides[i] || null;
      const hasImage = _hasImageSide(dSide) || _hasImageSide(sSide);
      const hasDepth = _hasDepthSide(dSide) || _hasDepthSide(sSide);
      const boxes = sSide && Array.isArray(sSide.bboxes) ? sSide.bboxes.length : 0;
      if (hasImage) imageSides++;
      if (hasDepth) depthSides++;
      totalBoxes += boxes;
      if (!hasImage) issues.push(_issue('error', 'tree_view_missing', `View ${i + 1}/${expected} belum punya RGB image.`));
      if (sessionSides.length && boxes === 0) emptyAnnotationSides.push(i + 1);
      if (hasDepth && dSide && dSide.depth && (!dSide.depth.width || !dSide.depth.height)) {
        issues.push(_issue('warn', 'tree_depth_meta_incomplete', `Depth metadata View ${i + 1} belum lengkap.`));
      }
      sideMetrics.push({ side: i + 1, hasImage, hasDepth, boxes });
    }

    if (sides.length && sides.length < expected) {
      issues.push(_issue('error', 'tree_side_count_short', `Jumlah view tersimpan ${sides.length}/${expected}.`));
    }
    if (depthSides > 0 && depthSides < imageSides) {
      issues.push(_issue('warn', 'tree_rgb_depth_incomplete', `Pasangan RGB/depth tidak lengkap: ${depthSides}/${imageSides} view punya depth.`));
    }
    if (sessionSides.length) {
      if (totalBoxes === 0) {
        issues.push(_issue('warn', 'annotation_empty_tree', 'Belum ada bbox di tree ini.'));
      } else if (emptyAnnotationSides.length) {
        issues.push(_issue('info', 'annotation_empty_side', `View tanpa bbox: ${emptyAnnotationSides.join(', ')}.`));
      }
      const links = Array.isArray(session.confirmedLinks) ? session.confirmedLinks.length : 0;
      if (expected > 1 && totalBoxes > 1 && links === 0) {
        issues.push(_issue('warn', 'annotation_no_links', 'Belum ada linking antar view; cek dedup jika objek muncul di beberapa view.'));
      }
      const mismatches = Array.isArray(opts.mismatches) ? opts.mismatches.length : 0;
      if (mismatches > 0) {
        issues.push(_issue('error', 'annotation_class_mismatch', `${mismatches} linked object punya class mismatch.`));
      }
      if (!opts.result) {
        issues.push(_issue('info', 'result_not_computed', 'Result belum dihitung/ditandai complete.'));
      }
    }

    return {
      status: _status(issues),
      issues,
      metrics: {
        expectedSides: expected,
        imageSides,
        depthSides,
        totalBoxes,
        links: session && Array.isArray(session.confirmedLinks) ? session.confirmedLinks.length : 0,
        sideMetrics,
      },
    };
  }

  function summarize(report) {
    const r = report || { status: 'ok', issues: [], metrics: {} };
    const m = r.metrics || {};
    const parts = [];
    if (m.imageSides != null && m.expectedSides != null) parts.push(`${m.imageSides}/${m.expectedSides} views`);
    if (m.capturedSides != null && m.expectedSides != null) parts.push(`${m.capturedSides}/${m.expectedSides} captured`);
    if (m.depthSides != null) parts.push(`${m.depthSides} depth`);
    if (m.totalBoxes != null) parts.push(`${m.totalBoxes} bbox`);
    if (m.links != null) parts.push(`${m.links} links`);
    return parts.join(' · ') || (r.status === 'ok' ? 'Ready' : `${r.issues.length} issue(s)`);
  }

  return { analyzeCaptureShots, analyzeTree, summarize };
})();

if (typeof window !== 'undefined') window.QualityCheck = QualityCheck;
