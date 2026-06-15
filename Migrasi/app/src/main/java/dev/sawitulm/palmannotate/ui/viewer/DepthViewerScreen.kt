package dev.sawitulm.palmannotate.ui.viewer

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.sawitulm.palmannotate.domain.util.DepthUtil
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DepthViewerScreen(
    treeKey: String,
    onBack: () -> Unit,
) {
    val ctx = LocalContext.current
    var currentSide by remember { mutableIntStateOf(0) }
    var depthData by remember { mutableStateOf<DepthData?>(null) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(treeKey, currentSide) {
        depthData = null
        errorMsg = null
        try {
            val treeName = treeKey.substringAfterLast("/").ifEmpty { treeKey.take(20) }
            val dir = File(ctx.getExternalFilesDir(null), "PalmAnnotate/depth/field")
            val rawFile = File(dir, "${treeName}_${currentSide + 1}.raw")
            if (!rawFile.exists()) {
                errorMsg = "No depth captured for Side ${currentSide + 1}."
                return@LaunchedEffect
            }
            val bytes = rawFile.readBytes()
            val depths = DepthUtil.toUint16(bytes)
            val range = DepthUtil.range(depths, 7000, 250)
            if (range.valid == 0) {
                errorMsg = "No valid depth values in file."
                return@LaunchedEffect
            }
            depthData = DepthData(depths, range)
        } catch (e: Exception) {
            errorMsg = e.message ?: "Failed to load depth"
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Depth \u0026 RAW") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            // Side tabs
            Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (i in 1..4) {
                    FilterChip(
                        selected = currentSide == i - 1,
                        onClick = { currentSide = i - 1 },
                        label = { Text("Side $i", fontSize = 12.sp) },
                    )
                }
            }
            if (depthData != null) {
                val data = depthData!!
                val r = data.range
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        val w = size.width.toInt()
                        val h = size.height.toInt()
                        var i = 0
                        for (d in data.depths) {
                            if (i >= w * h) break
                            val x = i % w
                            val y = i / w
                            val (cr, cg, cb) = DepthUtil.depthColor(d, r.displayFloorMm, r.displayCeilingMm)
                            drawRect(Color(cr, cg, cb), Offset(x.toFloat(), y.toFloat()), Size(1f, 1f))
                            i++
                        }
                    }
                }
                Surface(Modifier.fillMaxWidth().padding(8.dp), tonalElevation = 2.dp) {
                    Column(Modifier.padding(8.dp)) {
                        Text("Range: ${r.displayFloorMm} – ${r.displayCeilingMm} mm", fontSize = 12.sp)
                        Text("Observed: ${r.observedMinMm} – ${r.observedMaxMm} mm", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("Valid: ${r.valid} values", fontSize = 12.sp)
                    }
                }
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (errorMsg != null) Text(errorMsg!!, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else CircularProgressIndicator()
                }
            }
        }
    }
}

private data class DepthData(
    val depths: IntArray,
    val range: DepthUtil.DepthRange,
)
