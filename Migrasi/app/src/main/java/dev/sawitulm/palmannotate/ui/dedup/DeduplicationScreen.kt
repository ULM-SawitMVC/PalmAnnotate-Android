package dev.sawitulm.palmannotate.ui.dedup

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.sawitulm.palmannotate.data.storage.ExportFolderRepository
import dev.sawitulm.palmannotate.data.storage.SessionRepository
import dev.sawitulm.palmannotate.domain.dedup.SuggestionEngine
import dev.sawitulm.palmannotate.domain.model.*
import dev.sawitulm.palmannotate.domain.usecase.SessionUseCases
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
    var isLoading by mutableStateOf(true)
        private set

    val adjacentPairs: List<Pair<Int, Int>>
        get() = session?.adjacentPairs ?: emptyList()

    val currentPair: Pair<Int, Int>?
        get() = adjacentPairs.getOrNull(currentPairIndex)

    fun load(sessionId: String) {
        viewModelScope.launch {
            isLoading = true
            session = repo.loadActiveSession(sessionId)
            isLoading = false
        }
    }

    fun nextPair() {
        if (currentPairIndex < adjacentPairs.size - 1) currentPairIndex++
    }

    fun prevPair() {
        if (currentPairIndex > 0) currentPairIndex--
    }

    fun runSuggestions() {
        val s = session ?: return
        suggestions = SuggestionEngine.suggestAll(s)
    }

    fun confirmLink(sideA: Int, bboxIdA: String, sideB: Int, bboxIdB: String) {
        val s = session ?: return
        val linkId = "L${s.confirmedLinks.size}"
        val newLink = CrossSideLink.create(linkId, sideA, bboxIdA, sideB, bboxIdB)
        // Remove existing links for the same pair of sides with the same bboxes
        val filtered = s.confirmedLinks.filterNot {
            (it.sideA == sideA && it.bboxIdA == bboxIdA) ||
            (it.sideB == sideB && it.bboxIdB == bboxIdB) ||
            (it.sideA == sideA && it.bboxIdA == bboxIdB) ||
            (it.sideB == sideB && it.bboxIdB == bboxIdA)
        }
        session = s.copy(confirmedLinks = filtered + newLink)
    }

    fun removeLink(linkId: String) {
        val s = session ?: return
        session = s.copy(confirmedLinks = s.confirmedLinks.filter { it.linkId != linkId })
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

    /** Save the current links then continue (Compute & Mark Complete path). */
    fun saveAndContinue(onDone: () -> Unit) {
        val s = session ?: return
        viewModelScope.launch {
            val safTreeUri = exportFolder.folderUri.first()
            repo.saveSession(s, safTreeUri)
            onDone()
        }
    }

    /** Resolve all class mismatches by majority vote, save, then continue. */
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
// UI — matches the dedup tab from index.html
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
    val pair = viewModel.currentPair
    var showMismatch by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Deduplication") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = {
                    IconButton(onClick = { viewModel.save() }) { Icon(Icons.Default.Save, "Save") }
                },
            )
        },
        bottomBar = {
            BottomAppBar(
                containerColor = MaterialTheme.colorScheme.surfaceContainer,
                tonalElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    FilledTonalButton(onClick = { viewModel.runSuggestions() }) {
                        Icon(Icons.Default.AutoFixHigh, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Suggest")
                    }
                    FilledTonalButton(onClick = {
                        // Force class-mismatch resolution before completing (JS behaviour).
                        if (viewModel.currentMismatches().isNotEmpty()) showMismatch = true
                        else viewModel.saveAndContinue(onCompute)
                    }) {
                        Icon(Icons.Default.Calculate, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Compute")
                    }
                }
            }
        },
    ) { padding ->
        if (session == null || pair == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                if (viewModel.isLoading) CircularProgressIndicator() else Text("No adjacent pairs")
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Pair navigation
                item {
                    PairNavigationBar(
                        currentIndex = viewModel.currentPairIndex,
                        totalPairs = viewModel.adjacentPairs.size,
                        pairLabel = "Side ${pair.first + 1} ↔ Side ${pair.second + 1}",
                        onPrev = { viewModel.prevPair() },
                        onNext = { viewModel.nextPair() },
                    )
                }

                // Side comparison
                item {
                    SideComparisonCard(
                        session = session!!,
                        sideAIndex = pair.first,
                        sideBIndex = pair.second,
                    )
                }

                // Suggestions for this pair
                val pairSuggestions = viewModel.suggestions.filter {
                    it.sideA == pair.first && it.sideB == pair.second
                }
                if (pairSuggestions.isNotEmpty()) {
                    item {
                        Text("Suggestions", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    }
                    items(pairSuggestions) { suggestion ->
                        SuggestionCard(
                            suggestion = suggestion,
                            onConfirm = { viewModel.confirmLink(suggestion.sideA, suggestion.bboxIdA, suggestion.sideB, suggestion.bboxIdB) },
                        )
                    }
                }

                // Confirmed links for this pair
                val pairLinks = session!!.confirmedLinks.filter {
                    (it.sideA == pair.first && it.sideB == pair.second) ||
                    (it.sideA == pair.second && it.sideB == pair.first)
                }
                if (pairLinks.isNotEmpty()) {
                    item {
                        Text("Confirmed Links", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    }
                    items(pairLinks) { link ->
                        LinkCard(
                            link = link,
                            onRemove = { viewModel.removeLink(link.linkId) },
                        )
                    }
                }
            }
        }
    }

    if (showMismatch) {
        MismatchResolveModal(
            mismatches = viewModel.currentMismatches(),
            onResolveAll = { showMismatch = false; viewModel.resolveAllMismatchesAndSave(onCompute) },
            onCancel = { showMismatch = false },
        )
    }
}

@Composable
private fun PairNavigationBar(
    currentIndex: Int,
    totalPairs: Int,
    pairLabel: String,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onPrev, enabled = currentIndex > 0) {
                Icon(Icons.Default.ChevronLeft, "Prev")
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(pairLabel, fontWeight = FontWeight.Bold)
                Text("${currentIndex + 1} / $totalPairs", style = MaterialTheme.typography.bodySmall)
            }
            IconButton(onClick = onNext, enabled = currentIndex < totalPairs - 1) {
                Icon(Icons.Default.ChevronRight, "Next")
            }
        }
    }
}

@Composable
private fun SideComparisonCard(
    session: ActiveSession,
    sideAIndex: Int,
    sideBIndex: Int,
) {
    val sideA = session.sides.getOrNull(sideAIndex)
    val sideB = session.sides.getOrNull(sideBIndex)

    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        // Side A
        OutlinedCard(modifier = Modifier.weight(1f)) {
            Column(Modifier.padding(12.dp)) {
                Text("Side ${sideAIndex + 1}", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(4.dp))
                if (sideA != null) {
                    for (bbox in sideA.bboxes) {
                        Text(
                            "${bbox.className} [${bbox.id}]",
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (sideA.bboxes.isEmpty()) Text("No bboxes", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        // Side B
        OutlinedCard(modifier = Modifier.weight(1f)) {
            Column(Modifier.padding(12.dp)) {
                Text("Side ${sideBIndex + 1}", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(4.dp))
                if (sideB != null) {
                    for (bbox in sideB.bboxes) {
                        Text(
                            "${bbox.className} [${bbox.id}]",
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (sideB.bboxes.isEmpty()) Text("No bboxes", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun SuggestionCard(
    suggestion: SuggestedPair,
    onConfirm: () -> Unit,
) {
    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "${suggestion.bboxIdA} ↔ ${suggestion.bboxIdB}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    "${(suggestion.score * 100).toInt()}% · ${suggestion.category}",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (suggestion.category == "auto")
                        MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            FilledTonalButton(onClick = onConfirm) {
                Icon(Icons.Default.Link, "Link", Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("Link")
            }
        }
    }
}

@Composable
private fun LinkCard(
    link: CrossSideLink,
    onRemove: () -> Unit,
) {
    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Link, "Linked", tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "S${link.sideA + 1}:${link.bboxIdA} ↔ S${link.sideB + 1}:${link.bboxIdB}",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            IconButton(onClick = onRemove) {
                Icon(Icons.Default.Close, "Remove", tint = MaterialTheme.colorScheme.error)
            }
        }
    }
}
