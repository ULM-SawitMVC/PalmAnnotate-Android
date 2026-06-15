package dev.sawitulm.palmannotate.domain.util

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Depth data processing utilities.
 * Ported from js/viewer/depth-viewer.js (DepthViewer._toUint16, _range, _depthColor).
 */
object DepthUtil {

    /**
     * Decode raw little-endian bytes into uint16 values.
     */
    fun toUint16(raw: ByteArray): IntArray {
        val out = IntArray(raw.size / 2)
        for (i in out.indices) {
            out[i] = (raw[i * 2].toInt() and 0xFF) or ((raw[i * 2 + 1].toInt() and 0xFF) shl 8)
        }
        return out
    }

    /**
     * Compute depth range statistics, ignoring invalid (0) and out-of-range values.
     * Uses robust P2–P98 instead of raw min/max.
     *
     * @param depths Array of depth values in mm.
     * @param displayMaxMm Maximum display range in mm (values above are out-of-range).
     * @param displayMinMm Minimum display range in mm (values below are out-of-range).
     * @return Triple of (minMm, maxMm, validCount) for the robust range.
     */
    data class DepthRange(
        val minMm: Int,
        val maxMm: Int,
        val valid: Int,
        val displayFloorMm: Int,
        val displayCeilingMm: Int,
        val observedMinMm: Int,
        val observedMaxMm: Int,
    )

    fun range(depths: IntArray, displayMaxMm: Int = 8000, displayMinMm: Int = 250): DepthRange {
        val valid = depths.filter { it in 1 until displayMaxMm }
        if (valid.isEmpty()) {
            return DepthRange(0, 0, 0, displayMinMm, displayMaxMm, 0, 0)
        }

        val sorted = valid.sorted()
        val observedMin = sorted.first()
        val observedMax = sorted.last()

        // Robust P2–P98
        val p2Idx = max(0, (sorted.size * 0.02).roundToInt() - 1)
        val p98Idx = min(sorted.size - 1, (sorted.size * 0.98).roundToInt() - 1)
        val robustMin = sorted[max(0, p2Idx)]
        val robustMax = sorted[min(sorted.size - 1, p98Idx)]

        val floor = max(displayMinMm, robustMin - 250)
        val ceiling = min(displayMaxMm, robustMax + (robustMax - robustMin))

        return DepthRange(
            minMm = robustMin,
            maxMm = robustMax.coerceAtLeast(robustMin + 1),
            valid = valid.size,
            displayFloorMm = floor,
            displayCeilingMm = ceiling,
            observedMinMm = observedMin,
            observedMaxMm = observedMax,
        )
    }

    /**
     * Map a depth value to an RGB color.
     * Invalid (0) or out-of-range values map to black.
     */
    fun depthColor(depthMm: Int, floorMm: Int, ceilingMm: Int): Triple<Int, Int, Int> {
        if (depthMm <= 0 || depthMm < floorMm || depthMm > ceilingMm) {
            return Triple(0, 0, 0)
        }
        val t = (depthMm - floorMm).toFloat() / (ceilingMm - floorMm).coerceAtLeast(1)
        // Simple cool-to-warm colormap
        val r = (t * 255).toInt().coerceIn(0, 255)
        val b = ((1 - t) * 255).toInt().coerceIn(0, 255)
        val g = (128 - kotlin.math.abs(t - 0.5f) * 256).toInt().coerceIn(0, 255)
        return Triple(r, g, b)
    }
}
