'use strict';

// Class mapping: YOLO classId → display name (Damimas dataset: 0-indexed, 0=B1…3=B4)
const CLASS_MAP = { 0: 'B1', 1: 'B2', 2: 'B3', 3: 'B4' };

// Display colors per class (matches CanvasRenderer.getClassColor)
const CLASS_COLORS = {
  B1: '#3b82f6',
  B2: '#ef4444',
  B3: '#f59e0b',
  B4: '#8b5cf6',
};

// Valid annotation class IDs (0–3 in this dataset)
const VALID_CLASS_IDS = new Set([0, 1, 2, 3]);

/**
 * Parse a YOLO label file text into pixel-coordinate bbox objects.
 * @param {string} text       - raw .txt file content
 * @param {number} imgW       - image width in pixels
 * @param {number} imgH       - image height in pixels
 * @returns {Array<{id:string, classId:number, className:string, x1:number, y1:number, x2:number, y2:number}>}
 */
function parseYoloLabel(text, imgW, imgH) {
  if (!text || !text.trim()) return [];
  const bboxes = [];
  let idx = 0;
  for (const line of text.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const classId = parseInt(parts[0], 10);
    if (!VALID_CLASS_IDS.has(classId)) continue;
    const cx = parseFloat(parts[1]);
    const cy = parseFloat(parts[2]);
    const w  = parseFloat(parts[3]);
    const h  = parseFloat(parts[4]);
    if ([cx, cy, w, h].some(isNaN)) continue;
    const x1 = (cx - w / 2) * imgW;
    const y1 = (cy - h / 2) * imgH;
    const x2 = (cx + w / 2) * imgW;
    const y2 = (cy + h / 2) * imgH;
    bboxes.push({
      id: 'b' + idx++,
      classId,
      className: CLASS_MAP[classId] || ('C' + classId),
      x1: Math.max(0, x1),
      y1: Math.max(0, y1),
      x2: Math.min(imgW, x2),
      y2: Math.min(imgH, y2),
    });
  }
  return bboxes;
}

/**
 * Serialize pixel-coordinate bboxes back to YOLO normalized format.
 * @param {Array} bboxes   - same shape as parseYoloLabel output
 * @param {number} imgW
 * @param {number} imgH
 * @returns {string}       - YOLO label file content
 */
function toYoloFormat(bboxes, imgW, imgH) {
  return bboxes.map(b => {
    const cx = ((b.x1 + b.x2) / 2) / imgW;
    const cy = ((b.y1 + b.y2) / 2) / imgH;
    const w  = (b.x2 - b.x1) / imgW;
    const h  = (b.y2 - b.y1) / imgH;
    return `${b.classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
  }).join('\n');
}
