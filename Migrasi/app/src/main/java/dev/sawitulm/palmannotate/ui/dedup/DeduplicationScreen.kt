package dev.sawitulm.palmannotate.ui.dedup

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.sawitulm.palmannotate.data.storage.ExportFolderRepository
import dev.sawitulm.palmannotate.data.storage.SessionRepository
import dev.sawitulm.palmannotate.domain.dedup.SuggestionEngine
import dev.sawitulm.palmannotate.domain.model.*
import dev.sawitulm.palmannotate.domain.usecase.SessionUseCases
import dev.sawitulm.palmannotate.ui.common.AnnotationCanvas
import dev.sawitulm.palmannotate.ui.common.CanvasTool
import dev.sawitulm.palmannotate.ui.common.MismatchResolveModal
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

// ════════════════════════════════════════════════════════════════════════════════
// ViewModel
// ════════════════════════════════════════════════════════════════════════════════

@HiltViewModel
class DedupViewModel @Inject constructor(
    private val repo: SessionRepository,
    private val exportFolder: ExportFolderRepository,
) : ViewModel() {

    var session by mutableStateOf<ActiveSession?>(null)
        private set
    var currentPairIndex by mutableIntStateOf(0)
        private set
    var suggestions by mutableStateOf<List<SuggestedPair>>(emptyList())
        private set
    var showSuggestions by mutableStateOf(true)
    var isLoading by mutableStateOf(true)
        private set
    var selectedSideB by mutableStateOf<String?>(null) // bboxId on right canvas (sideA)
    var selectedSideA by mutableStateOf<String?>(null) // bboxId on left canvas (sideB)
    var pendingBboxId by mutableStateOf<String?>(null)
    var pendingSide by mutableIntStateOf(-1)

    val adjacentPairs: List<Pair<Int, Int>>
        get() = session?.adjacentPairs ?: emptyList()

    val currentPair: Pair<Int, Int>?
        get() = adjacentPairs.getOrNull(currentPairIndex)

    val leftSideIndex: Int get() = currentPair?.second ?: 0  // sideB
    val rightSideIndex: Int get() = currentPair?.first ?: 1  // sideA

    val leftSide: TreeSide? get() = session?.sides?.getOrNull(leftSideIndex)
    val rightSide: TreeSide? get() = session?.sides?.getOrNull(rightSideIndex)

    /** Links relevant to current pair */
    val pairLinks: List<CrossSideLink>
        get() = session?.confirmedLinks?.filter {
            (it.sideA == rightSideIndex && it.sideB == leftSideIndex) ||
            (it.sideA == leftSideIndex && it.sideB == rightSideIndex)
        } ?: emptyList()

    /** Boxes on sideB that are linked from sideA's perspective */
    fun linkedBboxIdForSideB(bboxId: String): String? {
        for (link in pairLinks) {
            if (link.bboxIdB == bboxId) return link.bboxIdA
            if (link.bboxIdA == bboxId) return link.bboxIdB
        }
        return null
    }

    fun linkedBboxIdForSideA(bboxId: String): String? {
        for (link in pairLinks) {
            if (link.bboxIdA == bboxId) return link.bboxIdB
            if (link.bboxIdB == bboxId) return link.bboxIdA
        }
        return null
    }

    fun load(sessionId: String) {
        viewModelScope.launch {
            isLoading = true
            session = repo.loadActiveSession(sessionId)
            isLoading = false
        }
    }

    fun nextPair() {
        if (currentPairIndex < adjacentPairs.size - 1) {
            currentPairIndex++
            clearSelection()
        }
    }

    fun prevPair() {
        if (currentPairIndex > 0) {
            currentPairIndex--
            clearSelection()
        }
    }

    fun selectSideB(bboxId: String?) { selectedSideB = bboxId }
    fun selectSideA(bboxId: String?) { selectedSideA = bboxId }

    fun clearSelection() {
        selectedSideB = null
        selectedSideA = null
        pendingBboxId = null
        pendingSide = -1
    }

    fun runSuggestions() {
        val s = session ?: return
        suggestions = SuggestionEngine.suggestAll(s)
        showSuggestions = true
    }

    fun onBboxTap(sideIndex: Int, bboxId: String) {
        val s = session ?: return
        val isLeft = sideIndex == leftSideIndex
        val isRight = sideIndex == rightSideIndex
        if (!isLeft && !isRight) return

        if (pendingBboxId != null) {
            val a = if (pendingSide == leftSideIndex) leftSideIndex else rightSideIndex
            val aId = pendingBboxId!!
            val b: Int
            val bId: String
            if (isLeft) { b = leftSideIndex; bId = bboxId }
            else { b = rightSideIndex; bId = bboxId }

            if (a != b) {
                s.addManualLink(a, aId, b, bId).let { session = it }
                suggestions = suggestions.filterNot {
                    (it.sideA == a && it.bboxIdA == aId && it.sideB == b && it.bboxIdB == bId) ||
                    (it.sideA == b && it.bboxIdA == bId && it.sideB == a && it.bboxIdB == aId)
                }
            }
            if (isLeft) { selectedSideB = bboxId; selectedSideA = aId }
            else { selectedSideA = bboxId; selectedSideB = aId }
            pendingBboxId = null
            pendingSide = -1
        } else {
            if (isLeft) {
                val partner = linkedBboxIdForSideB(bboxId)
                if (partner != null) {
                    pendingBboxId = partner
                    pendingSide = rightSideIndex
                    selectedSideB = bboxId
                    selectedSideA = partner
                } else {
                    pendingBboxId = bboxId
                    pendingSide = leftSideIndex
                    selectedSideB = bboxId
                    selectedSideA = null
                }
            } else {
                val partner = linkedBboxIdForSideA(bboxId)
                if (partner != null) {
                    pendingBboxId = partner
                    pendingSide = leftSideIndex
                    selectedSideA = bboxId
                    selectedSideB = partner
                } else {
                    pendingBboxId = bboxId
                    pendingSide = rightSideIndex
                    selectedSideA = bboxId
                    selectedSideB = null
                }
            }
        }
    }

    fun removeLink(linkId: String) {
        val s = session ?: return
        session = s.copy(confirmedLinks = s.confirmedLinks.filter { it.linkId != linkId })
    }

    fun confirmSuggestion(sug: SuggestedPair) {
        val s = session ?: return
        SessionUseCases.addManualLink(s, sug.sideA, sug.bboxIdA, sug.sideB, sug.bboxIdB).let { session = it }
        suggestions = suggestions - sug
    }

    fun rejectSuggestion(sug: SuggestedPair) {
        suggestions = suggestions - sug
    }

    fun acceptAllAuto() {
        val auto = suggestions.filter { it.category == "auto" }
        for (sug in auto) confirmSuggestion(sug)
    }

    fun save() {
        val s = session ?: return
        viewModelScope.launch {
            val safTreeUri = exportFolder.folderUri.first()
            repo.saveSession(s, safTreeUri)
        }
    }

    fun currentMismatches(): List<SessionUseCases.MismatchCluster> {
        val s = session ?: return emptyList()
        return SessionUseCases.getMismatchedClusters(s)
    }

    fun saveAndContinue(onDone: () -> Unit) {
        val s = session ?: return
        viewModelScope.launch {
            val safTreeUri = exportFolder.folderUri.first()
            repo.saveSession(s, safTreeUri)
            onDone()
        }
    }

    fun resolveAllMismatchesAndSave(onDone: () -> Unit) {
        val s = session ?: return
        val resolved = SessionUseCases.resolveAllMismatches(s)
        session = resolved
        viewModelScope.launch {
            val safTreeUri = exportFolder.folderUri.first()
            repo.saveSession(resolved, safTreeUri)
            onDone()
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// Extensions
// ════════════════════════════════════════════════════════════════════════════════

private fun ActiveSession.addManualLink(sA: Int, bA: String, sB: Int, bB: String): ActiveSession {
    return SessionUseCases.addManualLink(this, sA, bA, sB, bB)
}

// ════════════════════════════════════════════════════════════════════════════════
// UI — Two-canvas dedup surface (matches JS DedupUI + index.html #panel-dedup)
// ════════════════════════════════════════════════════════════════════════════════

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeduplicationScreen(
    sessionId: String,
    onBack: () -> Unit,
    onCompute: () -> Unit,
    viewModel: DedupViewModel = hiltViewModel(),
) {
    LaunchedEffect(sessionId) { viewModel.load(sessionId) }

    val session = viewModel.session
    val leftSide = viewModel.leftSide
    val rightSide = viewModel.rightSide
    val isPortrait = LocalConfiguration.current.screenWidthDp < 600

    var showMismatch by remember { mutableStateOf(false) }
    val mismatches = remember(session) { viewModel.currentMismatches() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(session?.treeName ?: "Deduplication") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = {
                    IconButton(onClick = { viewModel.runSuggestions() }) {
                        Icon(Icons.Default.AutoAwesome, "Suggest")
                    }
                    IconButton(onClick = {
                        if (mismatches.isNotEmpty()) showMismatch = true
                        else viewModel.resolveAllMismatchesAndSave { onCompute() }
                    }) {
                        Icon(Icons.Default.CheckCircle, "Compute")
                    }
                },
            )
        },
    ) { padding ->
        if (viewModel.isLoading || leftSide == null || rightSide == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
            Column(Modifier.fillMaxSize().padding(padding)) {
                // Pair navigation bar
                PairNav(
                    pairIndex = viewModel.currentPairIndex,
                    totalPairs = viewModel.adjacentPairs.size,
                    leftLabel = "Side ${viewModel.leftSideIndex + 1}",
                    rightLabel = "Side ${viewModel.rightSideIndex + 1}",
                    onPrev = { viewModel.prevPair() },
                    onNext = { viewModel.nextPair() },
                )

                // Two canvases
                if (isPortrait) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.Top) {
                        DedupHalfCanvas(
                            label = "Side ${viewModel.leftSideIndex + 1}",
                            side = leftSide,
                            linkedIds = viewModel.pairLinks.flatMap { listOf(it.bboxIdA, it.bboxIdB) }.toSet(),
                            selectedId = viewModel.selectedSideB,
                            pending = viewModel.pendingBboxId.takeIf { viewModel.pendingSide == viewModel.leftSideIndex },
                            onTap = { viewModel.onBboxTap(viewModel.leftSideIndex, it) },
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                        )
                        HorizontalDivider(color = Color(0xFFB8E04A), thickness = 2.dp)
                        DedupHalfCanvas(
                            label = "Side ${viewModel.rightSideIndex + 1}",
                            side = rightSide,
                            linkedIds = viewModel.pairLinks.flatMap { listOf(it.bboxIdA, it.bboxIdB) }.toSet(),
                            selectedId = viewModel.selectedSideA,
                            pending = viewModel.pendingBboxId.takeIf { viewModel.pendingSide == viewModel.rightSideIndex },
                            onTap = { viewModel.onBboxTap(viewModel.rightSideIndex, it) },
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                        )
                    }
                } else {
                    Row(modifier = Modifier.weight(1f)) {
                        DedupHalfCanvas(
                            label = "Side ${viewModel.leftSideIndex + 1}",
                            side = leftSide,
                            linkedIds = viewModel.pairLinks.flatMap { listOf(it.bboxIdA, it.bboxIdB) }.toSet(),
                            selectedId = viewModel.selectedSideB,
                            pending = viewModel.pendingBboxId.takeIf { viewModel.pendingSide == viewModel.leftSideIndex },
                            onTap = { viewModel.onBboxTap(viewModel.leftSideIndex, it) },
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                        )
                        VerticalDivider(color = Color(0xFFB8E04A), thickness = 2.dp)
                        DedupHalfCanvas(
                            label = "Side ${viewModel.rightSideIndex + 1}",
                            side = rightSide,
                            linkedIds = viewModel.pairLinks.flatMap { listOf(it.bboxIdA, it.bboxIdB) }.toSet(),
                            selectedId = viewModel.selectedSideA,
                            pending = viewModel.pendingBboxId.takeIf { viewModel.pendingSide == viewModel.rightSideIndex },
                            onTap = { viewModel.onBboxTap(viewModel.rightSideIndex, it) },
                            modifier = Modifier.weight(1f).fillMaxHeight(),
                        )
                    }
                }

                // Bottom panels: Suggestions + Confirmed Links
                BottomPanels(
                    suggestions = viewModel.suggestions,
                    showSuggestions = viewModel.showSuggestions,
                    confirmedLinks = viewModel.pairLinks,
                    session = session,
                    onToggleSuggestions = { viewModel.showSuggestions = !viewModel.showSuggestions },
                    onConfirm = { viewModel.confirmSuggestion(it) },
                    onReject = { viewModel.rejectSuggestion(it) },
                    onAcceptAll = { viewModel.acceptAllAuto() },
                    onRemoveLink = { viewModel.removeLink(it) },
                )
            }
        }
    }

    // Mismatch resolve modal
    if (showMismatch && mismatches.isNotEmpty()) {
        MismatchResolveModal(
            mismatches = mismatches,
            onResolveAll = {
                viewModel.resolveAllMismatchesAndSave { onCompute() }
                showMismatch = false
            },
            onCancel = { showMismatch = false },
        )
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// Sub-composables
// ════════════════════════════════════════════════════════════════════════════════

@Composable
private fun PairNav(
    pairIndex: Int,
    totalPairs: Int,
    leftLabel: String,
    rightLabel: String,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    Surface(tonalElevation = 1.dp) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrev, enabled = pairIndex > 0) {
                Icon(Icons.Default.ChevronLeft, "Previous pair")
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("$leftLabel  ↔  $rightLabel", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text("Pair ${pairIndex + 1} / $totalPairs", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onNext, enabled = pairIndex < totalPairs - 1) {
                Icon(Icons.Default.ChevronRight, "Next pair")
            }
        }
    }
}

@Composable
private fun DedupHalfCanvas(
    label: String,
    side: TreeSide,
    linkedIds: Set<String>,
    selectedId: String?,
    pending: String?,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier) {
        AnnotationCanvas(
            imageUriString = side.imageUri?.toString(),
            bboxes = side.bboxes,
            selectedBboxId = selectedId,
            imageWidth = side.imageWidth.coerceAtLeast(1),
            imageHeight = side.imageHeight.coerceAtLeast(1),
            tool = CanvasTool.SELECT,
            showBoxes = true,
            onBboxTap = { id -> if (id != null) onTap(id) },
            modifier = Modifier.fillMaxSize(),
        )

        // Side label overhead
        Surface(
            modifier = Modifier.align(Alignment.TopStart).padding(4.dp),
            shape = RoundedCornerShape(4.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
        ) {
            Text(
                label,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
        }

        // Pending indicator
        if (pending != null) {
            Surface(
                modifier = Modifier.align(Alignment.Center).padding(8.dp),
                shape = RoundedCornerShape(8.dp),
                color = Color(0xFFB8E04A).copy(alpha = 0.9f),
            ) {
                Text(
                    "← Tap matching box →",
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF0C120C),
                )
            }
        }
    }
}

@Composable
private fun BottomPanels(
    suggestions: List<SuggestedPair>,
    showSuggestions: Boolean,
    confirmedLinks: List<CrossSideLink>,
    session: ActiveSession?,
    onToggleSuggestions: () -> Unit,
    onConfirm: (SuggestedPair) -> Unit,
    onReject: (SuggestedPair) -> Unit,
    onAcceptAll: () -> Unit,
    onRemoveLink: (String) -> Unit,
) {
    Surface(tonalElevation = 3.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(8.dp).heightIn(max = 200.dp)) {
            // Suggestions header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onToggleSuggestions) {
                    Icon(
                        if (showSuggestions) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                        "Toggle",
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text("Suggestions (${suggestions.size})", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                }
                val autoCount = suggestions.count { it.category == "auto" }
                if (autoCount > 0) {
                    TextButton(onClick = onAcceptAll) {
                        Text("Accept All Auto ($autoCount)", fontSize = 12.sp)
                    }
                }
            }

            if (showSuggestions) {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (sug in suggestions.take(20)) {
                        SuggestionChip(sug, onConfirm, onReject)
                    }
                }
            }

            // Confirmed links
            if (confirmedLinks.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text("Confirmed Links (${confirmedLinks.size})", fontWeight = FontWeight.Bold, fontSize = 13.sp, modifier = Modifier.padding(start = 8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    for (link in confirmedLinks) {
                        InputChip(
                            selected = true,
                            onClick = { onRemoveLink(link.linkId) },
                            label = { Text("${link.bboxIdA}↔${link.bboxIdB}", fontSize = 11.sp) },
                            trailingIcon = { Icon(Icons.Default.Close, "Remove", modifier = Modifier.size(14.dp)) },
                            modifier = Modifier.height(28.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SuggestionChip(
    sug: SuggestedPair,
    onConfirm: (SuggestedPair) -> Unit,
    onReject: (SuggestedPair) -> Unit,
) {
    val scorePct = (sug.score * 100).toInt()
    val tint = when {
        sug.category == "auto" -> Color(0xFF2DD47B)
        scorePct >= 50 -> Color(0xFFE4B84A)
        else -> MaterialTheme.colorScheme.error
    }
    Surface(
        shape = RoundedCornerShape(8.dp),
        border = ButtonDefaults.outlinedButtonBorder(enabled = true),
        modifier = Modifier.widthIn(max = 200.dp),
    ) {
        Column(Modifier.padding(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${sug.bboxIdA} ↔ ${sug.bboxIdB}",
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f),
                )
                Text("$scorePct%", fontSize = 11.sp, color = tint, fontWeight = FontWeight.Bold)
            }
            Text(
                sug.category.uppercase(),
                fontSize = 9.sp,
                color = tint,
            )
            // Signal badges
            sug.signals?.let { sig ->
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    SignalBadge("S", sig.seam)
                    SignalBadge("V", sig.vert)
                    SignalBadge("Z", sig.size)
                    SignalBadge("C", sig.cls)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                    onClick = { onConfirm(sug) },
                    modifier = Modifier.height(24.dp),
                    contentPadding = PaddingValues(horizontal = 6.dp),
                ) { Text("Accept", fontSize = 10.sp) }
                TextButton(
                    onClick = { onReject(sug) },
                    modifier = Modifier.height(24.dp),
                    contentPadding = PaddingValues(horizontal = 6.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text("Reject", fontSize = 10.sp) }
            }
        }
    }
}

@Composable
private fun SignalBadge(label: String, value: Float) {
    val c = when {
        value >= 0.75f -> Color(0xFF2DD47B)
        value >= 0.5f -> Color(0xFFE4B84A)
        else -> Color(0xFFF06060)
    }
    Surface(
        shape = RoundedCornerShape(3.dp),
        color = c.copy(alpha = 0.2f),
    ) {
        Text(
            "$label ${(value * 100).toInt()}",
            fontSize = 8.sp,
            color = c,
            modifier = Modifier.padding(horizontal = 2.dp),
            fontWeight = FontWeight.Bold,
        )
    }
}

