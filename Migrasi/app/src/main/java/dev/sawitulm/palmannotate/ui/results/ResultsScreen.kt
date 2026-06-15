package dev.sawitulm.palmannotate.ui.results

import android.net.Uri
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.sawitulm.palmannotate.data.export.ExportManager
import dev.sawitulm.palmannotate.data.storage.ExportFolderRepository
import dev.sawitulm.palmannotate.data.storage.SafMirrorStore
import dev.sawitulm.palmannotate.data.storage.SessionRepository
import dev.sawitulm.palmannotate.data.yolo.YoloParser
import dev.sawitulm.palmannotate.domain.model.*
import dev.sawitulm.palmannotate.domain.quality.QualityCheck
import dev.sawitulm.palmannotate.domain.results.ResultsComputer
import dev.sawitulm.palmannotate.ui.common.QualityGateModal
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

// ════════════════════════════════════════════════════════════════════════════════
// ViewModel
// ════════════════════════════════════════════════════════════════════════════════

@HiltViewModel
class ResultsViewModel @Inject constructor(
    private val repo: SessionRepository,
    private val saf: SafMirrorStore,
    private val exportFolder: ExportFolderRepository,
) : ViewModel() {

    var session by mutableStateOf<ActiveSession?>(null)
        private set
    var results by mutableStateOf<TreeResults?>(null)
        private set
    var isComputing by mutableStateOf(false)
        private set
    var isExporting by mutableStateOf(false)
        private set
    var exportStatus by mutableStateOf<String?>(null)
        private set
    var showQualityGate by mutableStateOf(false)
        private set
    var qualityIssues by mutableStateOf<List<String>>(emptyList())
        private set
    var pendingExportAction by mutableStateOf<(suspend () -> Unit)?>(null)
        private set

    fun load(treeKey: String) {
        viewModelScope.launch {
            session = repo.loadActiveSession(treeKey)
            compute()
        }
    }

    fun compute() {
        val s = session ?: return
        isComputing = true
        try { results = ResultsComputer.compute(s) }
        finally { isComputing = false }
    }

    fun saveOutputJson() {
        val s = session ?: return
        val r = results ?: return
        viewModelScope.launch {
            val safTreeUri = exportFolder.folderUri.first()
            repo.saveOutputJson(s, r, safTreeUri)
            exportStatus = "Output JSON saved"
        }
    }

    // ─── Export with quality gate ────────────────────────────────────────────

    private fun exportGated(actionLabel: String, action: suspend (Uri) -> Unit) {
        viewModelScope.launch {
            val s = session ?: return@launch
            val safUri = exportFolder.folderUri.first() ?: run {
                exportStatus = "Select an export folder first"
                return@launch
            }
            val checks = QualityCheck.analyzeTree(s)
            if (checks.status != QualityCheck.Level.OK) {
                qualityIssues = checks.issues.map { it.message }
                pendingExportAction = {
                    action(safUri)
                    exportStatus = "$actionLabel exported"
                }
                showQualityGate = true
            } else {
                isExporting = true
                try {
                    action(safUri)
                    exportStatus = "$actionLabel exported"
                } finally { isExporting = false }
            }
        }
    }

    fun exportOutputJson() = exportGated("Output JSON") { safUri ->
        val s = session ?: return@exportGated
        val r = results ?: return@exportGated
        val jsonText = ExportManager.generateOutputJson(s, r).toString(2)
        saf.writeText(safUri, "Output JSON/${s.treeName}.json", jsonText)
        repo.saveOutputJson(s, r, safUri)
    }

    fun exportYolo() = exportGated("YOLO") { safUri ->
        val s = session ?: return@exportGated
        for (side in s.sides) {
            val yolo = ExportManager.generateYoloTxt(side)
            if (yolo.isNotBlank()) {
                saf.writeText(safUri, "Output TXT/field/${s.treeName}_${side.sideIndex + 1}.txt", yolo)
            }
        }
    }

    fun exportCsv() = exportGated("CSV") { safUri ->
        val s = session ?: return@exportGated
        val r = results ?: return@exportGated
        val csv = ExportManager.generateCsv(s, r)
        saf.writeText(safUri, "exports/${s.treeName}_result.csv", csv)
    }

    fun exportIdentity() = exportGated("Identity JSON") { safUri ->
        val s = session ?: return@exportGated
        val r = results ?: return@exportGated
        val json = ExportManager.generateIdentityJson(s, r).toString(2)
        saf.writeText(safUri, "exports/${s.treeName}_identity.json", json)
    }

    fun dismissQualityGate(continueExport: Boolean) {
        showQualityGate = false
        if (continueExport && pendingExportAction != null) {
            viewModelScope.launch {
                isExporting = true
                try { pendingExportAction?.invoke() }
                finally { isExporting = false; pendingExportAction = null }
            }
        } else {
            pendingExportAction = null
        }
    }

    fun clearStatus() { exportStatus = null }
}

// ════════════════════════════════════════════════════════════════════════════════
// UI — matches the JS Results panel (#panel-results)
// ════════════════════════════════════════════════════════════════════════════════

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResultsScreen(
    sessionId: String,
    onBack: () -> Unit,
    viewModel: ResultsViewModel = hiltViewModel(),
) {
    LaunchedEffect(sessionId) { viewModel.load(sessionId) }

    val session = viewModel.session
    val results = viewModel.results

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(session?.treeName ?: "Results") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
            )
        },
    ) { padding ->
        if (results == null || session == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // ─── Stat cards ─────────────────────────────────────────
                item {
                    Text("Results", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StatCard("Unique\nBunches", results!!.uniqueCount.toString(), Modifier.weight(1f))
                        StatCard("Total\nDetections", results!!.rawCount.toString(), Modifier.weight(1f))
                        StatCard("Linked\nDuplicates", results!!.linkedCount.toString(), Modifier.weight(1f))
                    }
                }

                // ─── By-Class table ─────────────────────────────────────
                item {
                    Text("By Class", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    for (cls in listOf(AnnotationClass.B1, AnnotationClass.B2, AnnotationClass.B3, AnnotationClass.B4, AnnotationClass.UNASSIGNED)) {
                        val count = results!!.classCounts[cls] ?: 0
                        val label = if (cls == AnnotationClass.UNASSIGNED) "other" else cls.displayName
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(label, modifier = Modifier.padding(start = 8.dp))
                            Text(
                                count.toString(),
                                fontWeight = FontWeight.Bold,
                                color = if (cls == AnnotationClass.UNASSIGNED) MaterialTheme.colorScheme.error
                                        else MaterialTheme.colorScheme.primary,
                            )
                        }
                        HorizontalDivider()
                    }
                }

                // ─── By-Side table ──────────────────────────────────────
                item {
                    Spacer(Modifier.height(4.dp))
                    Text("By Side", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    for ((i, side) in session!!.sides.withIndex()) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text("Side ${i + 1}", modifier = Modifier.padding(start = 8.dp))
                            Text(side.bboxes.size.toString(), fontWeight = FontWeight.Bold)
                        }
                        HorizontalDivider()
                    }
                }

                // ─── Save Output Again ──────────────────────────────────
                item {
                    Spacer(Modifier.height(4.dp))
                    OutlinedButton(
                        onClick = { viewModel.saveOutputJson() },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.Save, "Save", modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Save Output Again")
                    }
                }

                // ─── Export buttons ─────────────────────────────────────
                item {
                    Text("Export", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ExportButton("Output JSON", viewModel.isExporting) { viewModel.exportOutputJson() }
                        ExportButton("YOLO .txt", viewModel.isExporting) { viewModel.exportYolo() }
                        ExportButton("CSV", viewModel.isExporting) { viewModel.exportCsv() }
                        ExportButton("Identity JSON", viewModel.isExporting) { viewModel.exportIdentity() }
                    }
                }

                // ─── Status message ─────────────────────────────────────
                item {
                    viewModel.exportStatus?.let { msg ->
                        Snackbar(
                            modifier = Modifier.fillMaxWidth(),
                            action = { TextButton(onClick = { viewModel.clearStatus() }) { Text("OK") } },
                        ) { Text(msg) }
                    }
                }
            }
        }
    }

    // Quality gate modal
    if (viewModel.showQualityGate) {
        QualityGateModal(
            issues = viewModel.qualityIssues,
            onContinue = { viewModel.dismissQualityGate(true) },
            onBack = { viewModel.dismissQualityGate(false) },
        )
    }
}

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier = Modifier) {
    OutlinedCard(modifier = modifier) {
        Column(
            modifier = Modifier.padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ExportButton(label: String, exporting: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = !exporting, modifier = Modifier.fillMaxWidth()) {
        if (exporting) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        else Text(label)
    }
}
