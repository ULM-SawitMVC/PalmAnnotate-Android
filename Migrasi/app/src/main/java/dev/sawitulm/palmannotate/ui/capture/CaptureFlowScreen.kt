package dev.sawitulm.palmannotate.ui.capture

import android.Manifest
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.compose.rememberAsyncImagePainter
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.sawitulm.palmannotate.data.camera.OrbbecManager
import dev.sawitulm.palmannotate.data.db.SessionEntity
import dev.sawitulm.palmannotate.data.location.GpsProvider
import dev.sawitulm.palmannotate.data.storage.AndroidStorageManager
import dev.sawitulm.palmannotate.data.storage.ExportFolderRepository
import dev.sawitulm.palmannotate.data.storage.SessionRepository
import dev.sawitulm.palmannotate.domain.model.*
import dev.sawitulm.palmannotate.domain.quality.QualityCheck
import dev.sawitulm.palmannotate.ui.common.QualityGateModal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.*
import javax.inject.Inject

enum class SideStep { PREVIEW, REVIEW }
enum class CaptureSource { PHONE_CAMERA, ORBBEC }

// Capture has two macro-phases: SIDES (sequential per-side capture/review) and
// REVIEW_ALL (one swipe carousel over every captured shot before save).
enum class CapturePhase { SIDES, REVIEW_ALL }

@HiltViewModel
class CaptureFlowViewModel @Inject constructor(
    private val repo: SessionRepository,
    private val storage: AndroidStorageManager,
    private val gps: GpsProvider,
    private val exportFolder: ExportFolderRepository,
    private val orbbec: OrbbecManager,
) : ViewModel() {

    var run by mutableStateOf<SessionEntity?>(null)
        private set
    var sideCount by mutableIntStateOf(4)
    var currentSide by mutableIntStateOf(0)
    val capturedImages = mutableStateListOf<Uri?>()
    var manualId by mutableStateOf("")
    var gpsStatus by mutableStateOf<String?>(null)
    var currentStep by mutableStateOf(SideStep.PREVIEW)
        private set
    var phase by mutableStateOf(CapturePhase.SIDES)
        private set
    // True while re-shooting a single side that was launched from the REVIEW_ALL
    // carousel — so confirming that side returns to the carousel instead of
    // walking forward through the remaining sides.
    var retakingFromReview by mutableStateOf(false)
        private set
    private var latitude: Double? = null
    private var longitude: Double? = null
    var isSaving by mutableStateOf(false)
        private set
    var saveError by mutableStateOf<String?>(null)
        private set
    var captureSource by mutableStateOf(CaptureSource.PHONE_CAMERA)
        private set
    var showQaDialog by mutableStateOf(false)
        private set
    var qaReport by mutableStateOf<QualityCheck.CaptureReport?>(null)
        private set

    fun selectSource(src: CaptureSource) { captureSource = src }
    fun dismissQa() { showQaDialog = false }

    fun requestSave(runId: String, context: Context, onDone: (String) -> Unit) {
        val r = run ?: return
        val capturedCount = capturedImages.count { it != null }
        val hasGps = latitude != null && longitude != null
        val report = QualityCheck.analyzeCaptureShots(
            capturedSides = capturedCount,
            expectedSides = sideCount,
            depthSides = 0,
            hasGps = hasGps,
            hasVariety = r.variety.isNotBlank(),
            hasBlock = r.block.isNotBlank(),
        )
        if (report.status == QualityCheck.Level.ERROR || report.status == QualityCheck.Level.WARN) {
            qaReport = report
            showQaDialog = true
        } else {
            save(runId, context, onDone)
        }
    }

    fun saveIgnoringQa(runId: String, context: Context, onDone: (String) -> Unit) {
        showQaDialog = false
        save(runId, context, onDone)
    }

    fun load(runId: String) {
        viewModelScope.launch {
            val r = repo.getRun(runId) ?: return@launch
            run = r
            sideCount = r.sideCount
            manualId = r.nextId.toString()
            capturedImages.clear()
            repeat(sideCount) { capturedImages.add(null) }
            currentSide = 0
            currentStep = SideStep.PREVIEW
            phase = CapturePhase.SIDES
            runCatching {
                val loc = gps.getBestLocation()
                if (loc != null) {
                    latitude = loc.latitude
                    longitude = loc.longitude
                    gpsStatus = "%.5f, %.5f".format(loc.latitude, loc.longitude)
                } else {
                    gpsStatus = "GPS unavailable"
                }
            }.onFailure { gpsStatus = "GPS unavailable" }
        }
    }

    fun onImageCaptured(uri: Uri) {
        if (currentSide < capturedImages.size) {
            capturedImages[currentSide] = uri
            currentStep = SideStep.REVIEW
        }
    }

    fun goToSide(index: Int) {
        if (index in 0 until sideCount) {
            currentSide = index
            currentStep = if (capturedImages[index] != null) SideStep.REVIEW else SideStep.PREVIEW
        }
    }

    fun retakeCurrent() {
        if (currentSide < capturedImages.size) capturedImages[currentSide] = null
        currentStep = SideStep.PREVIEW
    }

    /**
     * Advance from a per-side REVIEW. On any side but the last, move to the next
     * side's PREVIEW. After the last side, switch to the REVIEW_ALL phase (the
     * swipe carousel over every shot) instead of saving immediately. Returns true
     * when the review-all phase was entered (i.e. all sides done).
     */
    fun continueFromReview(): Boolean {
        return if (currentSide < sideCount - 1) {
            currentSide++
            currentStep = SideStep.PREVIEW
            false
        } else {
            if (allCaptured) phase = CapturePhase.REVIEW_ALL
            true
        }
    }

    /**
     * From the REVIEW_ALL carousel, re-shoot ONE side: drop back into the
     * sequential SIDES phase at that side's PREVIEW with its shot cleared. After
     * the operator re-captures (and confirms in the per-side REVIEW), the screen
     * routes back to REVIEW_ALL via continueFromReview()/returnToReviewAll().
     */
    fun retakeSide(index: Int) {
        if (index in 0 until capturedImages.size) {
            capturedImages[index] = null
            currentSide = index
            currentStep = SideStep.PREVIEW
            phase = CapturePhase.SIDES
            retakingFromReview = true
        }
    }

    /** Return to the review-all carousel (used after a single-side retake). */
    fun returnToReviewAll() {
        retakingFromReview = false
        if (allCaptured) {
            phase = CapturePhase.REVIEW_ALL
            currentStep = SideStep.REVIEW
        }
    }

    val allCaptured: Boolean get() = capturedImages.isNotEmpty() && capturedImages.all { it != null }

    private fun safe(s: String) = s.uppercase().replace(Regex("[^A-Z0-9_]+"), "_").trim('_').ifBlank { "TREE" }
    private fun safeBlock(s: String) = s.uppercase().replace(Regex("[^A-Z0-9]"), "")

    private fun save(runId: String, context: Context, onDone: (String) -> Unit) {
        val r = run ?: return
        saveError = null
        viewModelScope.launch {
            isSaving = true
            try {
                val treeId = if (r.autoId) r.nextId else (manualId.toIntOrNull() ?: r.nextId).coerceAtLeast(1)
                val v = safe(r.variety)
                val b = safeBlock(r.block)
                val treeName = if (b.isNotEmpty()) "${v}_${b}_${"%04d".format(treeId)}" else "${v}_${"%04d".format(treeId)}"

                val sides = withContext(Dispatchers.IO) {
                    val allSides = mutableListOf<TreeSide>()
                    capturedImages.forEachIndexed { index, uri ->
                        if (uri == null) return@forEachIndexed
                        val dest = storage.imageFile(treeName, index)
                        val bytes = try {
                            readBytes(context, uri)
                        } catch (e: Exception) {
                            Log.e("CaptureFlow", "Failed to read captured image for side $index", e)
                            null
                        }
                        if (bytes == null) throw IllegalStateException("Side ${index + 1}: captured image could not be read")
                        storage.writeBytes(dest, bytes)
                        val dims = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeFile(dest.path, dims)
                        if (dims.outWidth <= 0 || dims.outHeight <= 0) {
                            throw IllegalStateException("Side ${index + 1}: captured file has zero dimensions")
                        }
                        allSides.add(
                            TreeSide(
                                sideIndex = index,
                                label = "Side ${index + 1}",
                                imageUri = Uri.fromFile(dest),
                                labelUri = null,
                                imageWidth = dims.outWidth,
                                imageHeight = dims.outHeight,
                                bboxes = emptyList(),
                                originalBboxes = emptyList(),
                            )
                        )
                    }
                    allSides
                }
                if (sides.isEmpty()) {
                    saveError = "No captured images found"
                    return@launch
                }

                val safTreeUri = exportFolder.folderUri.first()

                val treeKey = repo.addTree(
                    sessionId = runId,
                    treeName = treeName,
                    treeId = treeId,
                    split = "field",
                    sides = sides,
                    metadata = TreeMetadata(
                        variety = r.variety,
                        block = r.block,
                        treeId = treeId.toString(),
                        latitude = latitude,
                        longitude = longitude,
                    ),
                    safTreeUri = safTreeUri,
                )
                onDone(treeKey)
            } catch (e: Exception) {
                Log.e("CaptureFlow", "Failed to save tree", e)
                saveError = e.localizedMessage ?: "Save failed"
            } finally {
                isSaving = false
            }
        }
    }

    private fun readBytes(context: Context, uri: Uri): ByteArray {
        return when (uri.scheme?.lowercase(Locale.US)) {
            "file" -> {
                val file = uri.path?.let { File(it) } ?: throw IOException("Invalid file URI")
                FileInputStream(file).use { it.readBytes() }
            }
            else -> context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw IOException("Could not open input stream for $uri")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureFlowScreen(
    sessionId: String,
    onTreeSaved: (String) -> Unit,
    onCancel: () -> Unit,
    viewModel: CaptureFlowViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    var hasCameraPermission by remember { mutableStateOf(false) }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> hasCameraPermission = granted }

    LaunchedEffect(sessionId) {
        viewModel.load(sessionId)
        permLauncher.launch(Manifest.permission.CAMERA)
    }

    val run = viewModel.run

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Capture — View ${viewModel.currentSide + 1}/${viewModel.sideCount}") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Cancel")
                    }
                },
                actions = {
                    val isOrbbec = viewModel.captureSource == CaptureSource.ORBBEC
                    FilterChip(
                        selected = isOrbbec,
                        onClick = { viewModel.selectSource(if (isOrbbec) CaptureSource.PHONE_CAMERA else CaptureSource.ORBBEC) },
                        label = { Text(if (isOrbbec) "Orbbec" else "Phone", fontSize = 12.sp) },
                        leadingIcon = { Icon(if (isOrbbec) Icons.Default.Usb else Icons.Default.CameraAlt, null, Modifier.size(16.dp)) },
                        modifier = Modifier.height(30.dp),
                    )
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 6.dp, vertical = 4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (run == null) {
                CircularProgressIndicator()
                return@Column
            }

            // Locked variety/block + GPS status + optional manual ID.
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("🔒 ${run.variety} · ${run.block}", style = MaterialTheme.typography.titleSmall)
                    Text(
                        viewModel.gpsStatus ?: "Locating…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (!run.autoId) {
                    OutlinedTextField(
                        value = viewModel.manualId,
                        onValueChange = { viewModel.manualId = it.filter { c -> c.isDigit() } },
                        label = { Text("Tree ID") },
                        singleLine = true,
                        modifier = Modifier.width(110.dp),
                    )
                }
            }
            Spacer(Modifier.height(6.dp))

            if (hasCameraPermission) {
                // After all sides are captured the flow switches to ONE swipe
                // review carousel over every shot (per-shot Retake + Save/Cancel),
                // replacing the last-side review. Until then it's the sequential
                // per-side capture/review surface.
                if (viewModel.phase == CapturePhase.REVIEW_ALL) {
                    viewModel.saveError?.let { err ->
                        Text(
                            text = "Save error: $err",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                    ReviewAllPager(
                        sideCount = viewModel.sideCount,
                        capturedImages = viewModel.capturedImages,
                        isSaving = viewModel.isSaving,
                        onRetake = { viewModel.retakeSide(it) },
                        onSave = { viewModel.requestSave(sessionId, context, onTreeSaved) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f),
                    )
                } else {
                // Thumbnail strip of all captured/reviewable sides.
                CapturedThumbnails(
                    sideCount = viewModel.sideCount,
                    currentSide = viewModel.currentSide,
                    capturedImages = viewModel.capturedImages,
                    onSelect = { viewModel.goToSide(it) },
                )
                Spacer(Modifier.height(4.dp))

                viewModel.saveError?.let { err ->
                    Text(
                        text = "Save error: $err",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                }

                // Confirming a per-side REVIEW either walks to the next side, or —
                // after the last side / a single-side retake — returns to the
                // review-all carousel. No direct save happens from here anymore.
                val onSideContinue: () -> Unit = {
                    if (viewModel.retakingFromReview) viewModel.returnToReviewAll()
                    else viewModel.continueFromReview()
                }
                val sideContinueLabel = if (viewModel.retakingFromReview) "Done" else null

                // Main stage.
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .clip(RoundedCornerShape(16.dp))
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)),
                ) {
                    if (viewModel.captureSource == CaptureSource.ORBBEC) {
                        OrbbecCaptureStage(
                            isCaptured = viewModel.capturedImages.getOrNull(viewModel.currentSide) != null,
                            currentStep = viewModel.currentStep,
                            uri = viewModel.capturedImages.getOrNull(viewModel.currentSide),
                            isLastSide = viewModel.currentSide == viewModel.sideCount - 1,
                            allCaptured = viewModel.allCaptured,
                            isSaving = viewModel.isSaving,
                            continueLabel = sideContinueLabel,
                            onCaptured = {
                                viewModel.onImageCaptured(it)
                                Toast.makeText(context, "Side ${viewModel.currentSide + 1} captured via Orbbec", Toast.LENGTH_SHORT).show()
                            },
                            onRetake = { viewModel.retakeCurrent() },
                            onContinue = onSideContinue,
                        )
                    } else {
                    when (viewModel.currentStep) {
                        SideStep.PREVIEW -> {
                            CameraCaptureStage(
                                context = context,
                                onCaptured = {
                                    viewModel.onImageCaptured(it)
                                    Toast.makeText(
                                        context,
                                        "Side ${viewModel.currentSide + 1} captured",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                },
                            )
                        }
                        SideStep.REVIEW -> {
                            CapturedReviewStage(
                                uri = viewModel.capturedImages[viewModel.currentSide],
                                isLastSide = viewModel.currentSide == viewModel.sideCount - 1,
                                allCaptured = viewModel.allCaptured,
                                isSaving = viewModel.isSaving,
                                continueLabel = sideContinueLabel,
                                onRetake = { viewModel.retakeCurrent() },
                                onContinue = onSideContinue,
                            )
                        }
                    }
                    } // end else (phone camera)
                }

                // Bottom progress dots.
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    repeat(viewModel.sideCount) { i ->
                        val captured = viewModel.capturedImages.getOrNull(i) != null
                        val current = i == viewModel.currentSide
                        Box(
                            modifier = Modifier
                                .size(if (current) 14.dp else 10.dp)
                                .clip(CircleShape)
                                .background(
                                    when {
                                        captured -> MaterialTheme.colorScheme.primary
                                        current -> MaterialTheme.colorScheme.outline
                                        else -> MaterialTheme.colorScheme.outlineVariant
                                    },
                                )
                                .border(
                                    width = if (current) 2.dp else 0.dp,
                                    color = if (current) MaterialTheme.colorScheme.onSurface else Color.Transparent,
                                    shape = CircleShape,
                                ),
                        )
                    }
                }
                } // end else (SIDES phase)
            } else {
                Text("Camera permission is required for capture.")
            }
        }
    }

    viewModel.qaReport?.let { report ->
        if (viewModel.showQaDialog) {
            QualityGateModal(
                issues = report.issues.map { "${it.code}: ${it.message}" },
                onContinue = { viewModel.saveIgnoringQa(sessionId, context, onTreeSaved) },
                onBack = { viewModel.dismissQa() },
            )
        }
    }
}

@Composable
private fun CapturedThumbnails(
    sideCount: Int,
    currentSide: Int,
    capturedImages: List<Uri?>,
    onSelect: (Int) -> Unit,
) {
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(List(sideCount) { it }) { index, _ ->
            val uri = capturedImages.getOrNull(index)
            val selected = index == currentSide
            Box(
                modifier = Modifier
                    .size(64.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .border(
                        width = if (selected) 3.dp else 1.dp,
                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                        shape = RoundedCornerShape(8.dp),
                    )
                    .clickable(enabled = uri != null) { onSelect(index) }
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                if (uri != null) {
                    Image(
                        painter = rememberAsyncImagePainter(uri),
                        contentDescription = "Side ${index + 1}",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Text(
                        "${index + 1}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun CapturedReviewStage(
    uri: Uri?,
    isLastSide: Boolean,
    allCaptured: Boolean,
    isSaving: Boolean,
    continueLabel: String? = null,
    onRetake: () -> Unit,
    onContinue: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        if (uri != null) {
            Image(
                painter = rememberAsyncImagePainter(uri),
                contentDescription = "Captured side",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        }

        // Green captured badge.
        Box(
            modifier = Modifier
                .padding(16.dp)
                .align(Alignment.TopEnd)
                .clip(RoundedCornerShape(50))
                .background(Color(0xFF2dd47b))
                .padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Text(
                "✓ Captured",
                color = Color.Black,
                fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.labelLarge,
            )
        }

        // Bottom action bar.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, Color.Black.copy(alpha = 0.6f))
                    )
                )
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = onRetake,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
            ) { Text("Retake") }

            Button(
                onClick = onContinue,
                modifier = Modifier.weight(1f),
                enabled = !isSaving && (if (isLastSide) allCaptured else true),
            ) {
                if (isSaving) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(continueLabel ?: if (isLastSide) "Review all" else "Continue")
                }
            }
        }
    }
}

/**
 * Final review-all stage: a swipe carousel (HorizontalPager) over every captured
 * shot before save. Each page shows the photo full-bleed on a black media
 * background with the side label + "✓ Captured" badge and a per-shot Retake.
 * A single Save commits all sides (routing through the existing QualityGate/QA
 * dialog via onSave) and Cancel/Back is the top-bar nav icon. Page dots show the
 * current index. Non-throwing: missing/unreadable Uris just render an empty page.
 */
@Composable
private fun ReviewAllPager(
    sideCount: Int,
    capturedImages: List<Uri?>,
    isSaving: Boolean,
    onRetake: (Int) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pageCount = sideCount.coerceAtLeast(1)
    val pagerState = rememberPagerState(pageCount = { pageCount })

    Column(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .clip(RoundedCornerShape(16.dp))
                .background(Color.Black)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)),
        ) {
            HorizontalPager(
                state = pagerState,
                modifier = Modifier.fillMaxSize(),
            ) { page ->
                val uri = capturedImages.getOrNull(page)
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (uri != null) {
                        Image(
                            painter = rememberAsyncImagePainter(uri),
                            contentDescription = "Side ${page + 1}",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }

                    // Side label (top-start) + captured badge (top-end) over media.
                    Box(
                        modifier = Modifier
                            .padding(16.dp)
                            .align(Alignment.TopStart)
                            .clip(RoundedCornerShape(50))
                            .background(Color.Black.copy(alpha = 0.55f))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text(
                            "Side ${page + 1} / $sideCount",
                            color = Color.White,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .padding(16.dp)
                            .align(Alignment.TopEnd)
                            .clip(RoundedCornerShape(50))
                            .background(Color(0xFF2dd47b))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text(
                            "✓ Captured",
                            color = Color.Black,
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }

                    // Per-shot Retake — bottom of this page, over a dark scrim.
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .align(Alignment.BottomCenter)
                            .background(
                                Brush.verticalGradient(
                                    listOf(Color.Transparent, Color.Black.copy(alpha = 0.6f))
                                )
                            )
                            .padding(16.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        OutlinedButton(
                            onClick = { onRetake(page) },
                            enabled = !isSaving,
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                        ) {
                            Icon(Icons.Default.CameraAlt, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Retake side ${page + 1}")
                        }
                    }
                }
            }
        }

        // Page dots — current index highlighted.
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
            horizontalArrangement = Arrangement.Center,
        ) {
            repeat(pageCount) { i ->
                val current = i == pagerState.currentPage
                Box(
                    modifier = Modifier
                        .padding(horizontal = 3.dp)
                        .size(if (current) 12.dp else 8.dp)
                        .clip(CircleShape)
                        .background(
                            if (current) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outlineVariant
                        ),
                )
            }
        }

        // Whole-set Save action (Cancel/Back is the top-bar nav icon).
        Button(
            onClick = onSave,
            enabled = !isSaving,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)
                .height(52.dp),
        ) {
            if (isSaving) {
                CircularProgressIndicator(Modifier.size(20.dp), color = MaterialTheme.colorScheme.onPrimary)
            } else {
                Text("Save & Annotate")
            }
        }
    }
}

@Composable
private fun CameraCaptureStage(
    context: Context,
    onCaptured: (Uri) -> Unit,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val imageCapture = remember { ImageCapture.Builder().build() }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        CameraPreview(
            context = context,
            lifecycleOwner = lifecycleOwner,
            imageCapture = imageCapture,
        )
        FloatingActionButton(
            onClick = {
                val ts = SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date())
                val file = File(context.cacheDir, "cap_$ts.jpg")
                val opts = ImageCapture.OutputFileOptions.Builder(file).build()
                imageCapture.takePicture(
                    opts,
                    ContextCompat.getMainExecutor(context),
                    object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                            onCaptured(Uri.fromFile(file))
                        }
                        override fun onError(exc: ImageCaptureException) {
                            Toast.makeText(context, "Capture failed: ${exc.message}", Toast.LENGTH_SHORT).show()
                        }
                    },
                )
            },
            modifier = Modifier.padding(bottom = 32.dp).size(72.dp),
            containerColor = MaterialTheme.colorScheme.primary,
        ) {
            Icon(Icons.Default.CameraAlt, "Capture", Modifier.size(32.dp))
        }
    }
}

@Composable
private fun CameraPreview(
    context: Context,
    lifecycleOwner: androidx.lifecycle.LifecycleOwner,
    imageCapture: ImageCapture,
) {
    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply { implementationMode = PreviewView.ImplementationMode.PERFORMANCE }
            previewView
        },
        update = { previewView ->
            val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
            cameraProviderFuture.addListener({
                val cameraProvider = try { cameraProviderFuture.get() } catch (_: Exception) { return@addListener }
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                try {
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageCapture,
                    )
                } catch (_: Exception) {
                    // Camera binding errors are best-effort surfaced by the blank preview.
                }
            }, ContextCompat.getMainExecutor(context))
        },
        modifier = Modifier.fillMaxSize(),
    )
    DisposableEffect(Unit) {
        onDispose {
            try {
                ProcessCameraProvider.getInstance(context).get().unbindAll()
            } catch (_: Exception) { }
        }
    }
}

@Composable
private fun OrbbecCaptureStage(
    isCaptured: Boolean,
    currentStep: SideStep,
    uri: Uri?,
    isLastSide: Boolean,
    allCaptured: Boolean,
    isSaving: Boolean,
    continueLabel: String? = null,
    onCaptured: (Uri) -> Unit,
    onRetake: () -> Unit,
    onContinue: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (!isCaptured || currentStep == SideStep.PREVIEW) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Default.Usb, "Orbbec", modifier = Modifier.size(64.dp), tint = MaterialTheme.colorScheme.primary)
                Text("Orbbec RGB-D Mode", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text("Connect Orbbec device to capture depth-aligned frames.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Button(onClick = {
                    val fakeUri = Uri.parse("file:///dev/null")
                    onCaptured(fakeUri)
                }) {
                    Icon(Icons.Default.CameraAlt, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Simulate Capture")
                }
            }
        } else {
            CapturedReviewStage(uri = uri, isLastSide = isLastSide, allCaptured = allCaptured, isSaving = isSaving, continueLabel = continueLabel, onRetake = onRetake, onContinue = onContinue)
        }
    }
}
