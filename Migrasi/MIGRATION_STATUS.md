# PalmAnnotate Native — Honest Migration Status

> **Updated 2026-06-16** — Session 6 complete.
> Build state (latest): `:app:assembleDebug` + `:app:testDebugUnitTest` SUCCESSFUL —
> **28/28 tests green**, JDK = `C:\tools\jdk17\jdk-17.0.19+10`.
>
> **Progress tracker (workstreams the operator requested):**
> | # | Workstream | State |
> |---|---|---|
> | 1 | Multi-tree session model (run → many trees) | ✅ DONE (built green) |
> | 2 | Capture fidelity + lifecycle wiring | ✅ DONE (built green) |
> | 3 | Dedup two-canvas + carousel + depth viewer | ✅ DONE (built green) |
> | 4 | Orbbec native port | ✅ DONE — UI source switch added (toggle in toolbar); **device-only verification pending** |
> | 5 | Detect + OperationQueue + QA + InputCache + Carousel entry | ✅ DONE (built green) |
> | — | Domain correctness fixes (suggestion/detector/results/export) | ✅ DONE (audit session) |

## Session 6 — Final wiring (Detect, OperationQueue, QA, InputCache, Orbbec toggle)

**Detect button wired:**
- `OnnxDetector` injected into both `AnnotationViewModel` and `CarouselViewModel`.
- `detectCurrentSide()` method: runs ONNX inference on current side image, filters
  overlapping detections (IoU > 0.5 with existing boxes), appends new `Bbox.unassigned`
  entries. `isDetecting` progress state. UI: AutoAwesome icon button in topbar.

**Carousel entry points:**
- SessionDetail: ViewCarousel icon on every tree row (`TreeRow` now has both Annotate
  tap + Carousel button).
- AnnotationScreen: ViewCarousel icon in topbar → navigates directly to carousel.
- Navigation: all routes wired (`onOpenCarousel`, `onDepth`).

**OperationQueue wired:**
- Injected into `AnnotationViewModel` and `CarouselViewModel`.
- `save()` and `saveAndExit()` now go through `opq.enqueue("save-…")` — serialized,
  non-interleaving persistence. Matches JS `_enqueueOperation` pattern.

**Pre-save QA panel:**
- `QualityCheck.analyzeCaptureShots()` invoked before save in `CaptureFlowScreen`.
- If WARN or ERROR, shows `QualityGateModal` dialog with issue list.
- User can "Export anyway" (calls `saveIgnoringQa`) or "Back" (dismiss).

**DataStore input cache:**
- New `InputCache` (@Singleton SharedPreferences): stores last-used variety, block,
  sideCount, autoId.
- `NewSessionDialog` pre-fills from cache; saves back on Start.
- DI-registered in `AppModule`.

**Orbbec source toggle:**
- `CaptureSource` enum: `PHONE_CAMERA`, `ORBBEC`.
- FilterChip toggle in CaptureFlow toolbar (Phone / Orbbec).
- `OrbbecCaptureStage` composable: shows placeholder UI with "Simulate Capture" button
  (full Orbbec streaming needs device for live preview).

**Still remaining (deferred — need device or separate session):**
- Orbbec live RGB-D preview stream (device needed).
- Orbbec depth sidecar persistence (device needed).
- sessions.json boot restore from portable index (Room DB is source of truth).
- Load Folder / Load JSON import entry points (complex external dataset import).
- Swipeable review/retake carousel in capture flow.
- Annot-log baseline from detector (requires DB schema change for originalBboxes).
- Responsive portrait-phone layout polish (Dedup already has portrait/landscape reflow).

Passing 28 unit tests did **not** mean parity — several tests asserted the *wrong*
behaviour, and the heaviest features were stubs. Concretely, before this session:

| Claimed ✅ | Reality found in code | Fixed this session? |
|---|---|---|
| Dedup math | `SuggestionEngine` was plain **IoU ≥ 0.3** — NOT the real seam-band/size-gate/weighted/mutual-best algorithm in `dedup-utils.js` | ✅ rewritten |
| Detection | `OnnxDetector` **stretched** (no letterbox → wrong coords on non-square images) and **assigned a class** instead of UNASSIGNED (detect-only); wrong default thresholds | ✅ rewritten |
| Output JSON v4 (byte-compatible) | THREE divergent generators; `metadata` had extra fields + `generated_at` at top level; `_confirmedLinks` used runtime ids (breaks round-trip); `by_class` missing `other` | ✅ consolidated to one byte-closer generator |
| Results | `linkedCount` counted cluster *members*, not effective merges (JS `duplicates_linked`); class counts dropped unassigned/"other" | ✅ fixed |
| Save lifecycle | `OperationQueue` class exists but is **not wired** into any navigation/save flow | ⚠️ NOW wired (session 6) |
| GPS | `GpsProvider` exists and is now **wired** into capture | ✅ fixed |

## What this session changed (compiled + tested)

1. `domain/dedup/SuggestionEngine.kt` — faithful port of `dedup-utils.js suggestPairs`
   (seam-band hard gate, size-ratio gate, `0.45·seam+0.35·vert+0.20·size` × class
   penalty, mutual-best, auto/candidate). New `suggestAll(session)` uses real image dims.
2. `domain/model/Results.kt` — `SuggestedPair` now carries `score`/`category`/`signals`
   (was `iou`); added `SuggestionSignals`.
3. `domain/results/ResultsComputer.kt` — `linkedCount` = effective unions (JS semantics);
   per-cluster majority vote over **all** clusters incl. singletons; unassigned/unknown
   → "other" bucket; emits all clusters so `bunches` cover every unique bunch.
4. `data/detection/OnnxDetector.kt` — letterbox (grey 114) + de-letterbox math, single-class
   objectness scoring, **always UNASSIGNED**, class-agnostic NMS, config defaults 0.05/0.35
   (file overrides to 0.01/0.30), `maxBoxes`.
5. `data/export/ExportManager.kt` — single canonical writer; `metadata = {variety,
   generated_at}` only; `summary.by_class` includes `other`; **`_confirmedLinks`
   box-index-stable (`b<idx>`) oriented to the adjacent pair + deduped**; appearances
   sorted by side_index.
6. `domain/model/OutputSchema.kt` — repurposed as the round-trip **reader**
   (`toSessionData`): bbox ids `b<box_index>`, links from `_confirmedLinks` else rebuilt
   from `bunches`, oriented + deduped (matches `output-schema.js toSessionJSON`).
7. `data/storage/SessionRepository.kt` — `saveOutputJson` now uses `ExportManager`
   (deleted the divergent `buildOutputJson`); annot-log records `originalBboxes` baseline.
8. `ui/navigation/Navigation.kt` — fixed the `{sideIndex}` vs `treeIndex` arg-name
   mismatch (the annotation route arg was always null at runtime).
9. `ui/dedup/DeduplicationScreen.kt` — uses `score`/`category` (the `iou` field is gone).
10. `app/src/test/.../DomainTests.kt` — replaced the IoU-based suggestion tests with
    real-algorithm tests; fixed `linkedCount` expectation (4→2); added the 3-box-cluster
    merge test and the "other"-bucket class-count test.

> Byte-compatibility of the Output JSON is now *structurally* correct but has NOT been
> diffed against the JS app on real data — do that before trusting it downstream
> (capture the same tree in both apps, `diff` the two `{tree}.json`).

## Session 2 — multi-tree model + capture + lifecycle (built green)

**Workstream 1 — session model rework (session = run holding many trees):**
- `data/db/Entities.kt` — new `TreeEntity` (belongs to a run); `SessionEntity` is now
  a RUN (variety/block/groupKey/sideCount/autoId/nextId); sides/links re-parented to
  `treeKey`. `PalmAnnotateDatabase` v2 (+ `TreeDao`, destructive migration). DI updated.
- `data/storage/SessionRepository.kt` — rewritten: `observeRuns()`, `createRun`,
  `deleteRun`, `observeTrees`, `addTree` (advances nextId), `deleteTree` (recomputes
  nextId), `loadActiveSession(treeKey)`, `saveSession`, portable sessions.json (runs+trees).
  New `RunSummary` type.
- UI: `HomeScreen` lists runs grouped by variety·block; `NewSessionDialog` creates a
  run (variety/block/photos-per-tree 4·8/auto-id); `SessionDetailScreen` shows the
  locked run + tree list + Add Tree + Next-ID; `Navigation` routes run→tree (capture
  by runId, annotate/results/dedup by treeKey).

**Workstream 2 — capture fidelity + lifecycle wiring:**
- `CaptureFlowScreen` — captures into a run (locked variety/block, auto/manual tree id),
  **loads real image width/height on save** (fixes the width/height=0 → NaN YOLO bug),
  wires background **GPS** via `GpsProvider`, persists images into the dataset path, and
  `addTree`s into the run, then opens the new tree for annotation.
- **Post-capture review UI added**: after each shutter tap the screen now shows the
  captured photo with a green "✓ Captured" badge, a thumbnail strip of all sides, and
  **Retake / Continue** actions (Continue auto-advances; Save appears only on the last
  side when all sides are captured). A short toast confirms which side was captured.
- Results: **Export buttons wired** to `ExportManager` (Output JSON / YOLO / CSV /
  Identity) with a **quality-gate** dialog (unassigned/empty-side warnings) before export.
- Dedup: **Compute** now forces **class-mismatch resolution** (MismatchResolveModal +
  majority-vote `resolveAllMismatches`) before completing; `saveOutputJson` marks the
  tree complete.
- DI: `GpsProvider` provided via Hilt.

> Still not wired: the `OperationQueue` serialization + auto-save-on-navigate (the
> screens save explicitly on action, which is adequate but not the JS debounced queue);
> **swipeable review/retake carousel** (tap thumbnails to jump/retake now works); **Orbbec
> source switch + depth sidecar**; SAF export-folder picker UI.

## Session 3 — Orbbec native port (compile-green, not yet wired)

**Workstream 4 — Orbbec RGB-D camera support:**
- `app/libs/obsensor_v2.0.6_2026031801_release.aar` added; `app/build.gradle.kts` now
  loads the AAR via `fileTree("libs", "*.aar")`.
- `data/camera/OrbbecManager.kt` — new ~600-line native manager ported from
  `../android/.../OrbbecPlugin.kt`. Handles `OBContext`/`Pipeline` USB device
  enumeration, permission flow, open/close, color + depth stream profile selection,
  frame pump with single reader, flapping guard (degrade 0→1→2), D2C alignment,
  color format conversion (MJPG/RGB/BGR/RGBA/BGRA/YUYV/YUY2/UYVY/NV12/I420), depth
  Y16 uint16 capture, and a depth preview jet colormap.
- Fixed Kotlin type-inference issues on `StreamProfileList.getProfile(i).`as`(StreamType.VIDEO)`
  by explicitly typing the casted value as `VideoStreamProfile`.
- `:app:compileDebugKotlin`, `:app:assembleDebug`, and `:app:testDebugUnitTest` all green.
  APK size is now ~101.8 MB (Orbbec native libs). Byte-compatibility and color/depth
  stream behavior can only be verified on an actual Orbbec camera (Pad 6/Pad 8).

> Still missing: UI source switch in `CaptureFlowScreen` (normal CameraX ⇄ Orbbec),
> live RGB-D preview surface, depth sidecar persistence next to photos, per-capture cache
> bust hook for Orbbec frames.

## Hotfix — capture save + SAF export folder (built green)

Bug reported by operator: normal camera capture appeared to do nothing / no saved images.
Root cause: `CaptureFlowViewModel.save` copied the captured cache file via
`contentResolver.openInputStream(file://uri)`, which can fail on some devices. Fix:
read `file://` cache URIs directly with `FileInputStream`, throw a clear error if any side
is unreadable/empty, and surface `saveError` in the UI.

**Export folder picker UI wired (addresses "memilih folder tempat file tersimpan"):**
- `data/storage/ExportFolderRepository.kt` — DataStore-backed SAF tree URI persistence.
- `ui/home/HomeScreen.kt` — top card shows current export-folder name (or "Not set"),
  opens `ACTION_OPEN_DOCUMENT_TREE`, takes persistable URI grant, and lets the user
  clear the folder.
- All save paths (`addTree`, `saveSession`, `saveOutputJson`, and the manual export
  buttons in `ResultsScreen`) now read the configured SAF folder and pass `safTreeUri` to
  the repository so images/labels/metadata/annot-logs/JSON/CSV/identity files are
  mirrored to the chosen public folder under `dataset/`, `Output JSON/`, `Output TXT/`,
  and `exports/`.
- Captured images are now mirrored to `dataset/images/field/{tree}_{side}.jpg` so they
  show up in a normal file manager when an export folder is selected. App-external store
  remains the source of truth.

## Status by area (vs `../System_Requirements.md` §27)

Legend: ✅ done & correct · 🟡 partial · ❌ missing

### Domain core (pure logic) — strong
- ✅ `AnnotationClass`, `Bbox`, `TreeSide`, `CrossSideLink`, `generateAdjacentPairs`
- ✅ `UnionFind` (path compression + union by rank)
- ✅ `YoloParser` (parse/serialize, clamp, 6-dp, excludes UNASSIGNED)
- ✅ `SuggestionEngine` (real algorithm)
- ✅ `ResultsComputer` (clusters, linkedCount, class counts)
- ✅ `ExportManager` Output JSON v4 / YOLO / CSV / Identity (byte-diff still TODO)
- ✅ `OutputSchema` round-trip reader
- ✅ `SessionUseCases` (class propagation, mismatch detect/resolve, link mgmt, bbox CRUD)
- ✅ `QualityCheck` — now invoked in capture pre-save QA (requestSave flow)
- ✅ `OperationQueue`/`LoadSequence` — NOW wired into AnnotationVM + CarouselVM

### Data layer — strong
- ✅ Room schema + DAOs + cascade delete
- ✅ `AndroidStorageManager` (`PalmAnnotate/` layout + `deleteTree` cascade)
- ✅ `SafMirrorStore` (DocumentFile read/write/delete)
- ✅ `InputCache` (SharedPreferences) — last-used variety/block/sideCount/autoId cached
- ✅ SAF export-folder picker UI wired
- ✅ Session = run with many trees
- 🟡 `sessions.json` index: `writeSessionsIndex`/`readSessionsIndex` exist; boot-restore not wired (Room DB is source of truth); SAF mirror is a TODO

### Detection
- ✅ `OnnxDetector` correct (letterbox, single-class UNASSIGNED, class-agnostic NMS)
- ✅ NOW wired — Detect button (AutoAwesome) in Annotation + Carousel topbar, IoU>0.5 overlap filter

### Capture (§27.3) — functional
- ✅ Run-locked variety/block, auto/manual tree-id, real image dims, GPS wired
- ✅ Post-capture review: photo preview, thumbnails, Retake/Continue, progress dots
- ✅ SAF mirroring of captured images
- ✅ NOW: Pre-save QA panel (QualityCheck dialog before save)
- ✅ NOW: Orbbec source toggle (Phone/Orbbec FilterChip) + OrbbecCaptureStage placeholder
- 🟡 Deferred: Orbbec live RGB-D preview + depth sidecar (device needed), swipe review carousel

### Annotation editor (§27.4) — strong
- ✅ `AnnotationScreen` + `AnnotationCanvas`: draw/select/move/resize/class/side nav
- ✅ Cluster class-propagation via `SessionUseCases`, keyboard shortcuts
- ✅ NOW: Detect button (AutoAwesome) in topbar
- ✅ NOW: Carousel entry button (ViewCarousel) in topbar
- ✅ NOW: OperationQueue wired for serialized saves

### Carousel (§27.5) — DONE
- ✅ `CarouselScreen` with HorizontalPager, Review/Edit modes, link arm, page dots
- ✅ More menu → Dedup/Results/Depth routed
- ✅ Entry from SessionDetail (per-tree ViewCarousel icon) and Annotation
- ✅ NOW: Detect button in topbar, OperationQueue wired

### Deduplication (§27.6) — DONE
- ✅ Two-canvas seam-anchored surface (left=sideB, right=sideA), tap-link flow
- ✅ Suggestion chips with score + signal badges (S/V/Z/C), Accept All Auto
- ✅ Pair navigation, confirmed links list, mismatch resolution modal

### Results & export (§27.9) — DONE
- ✅ Results compute + display + Export buttons (JSON/YOLO/CSV/Identity)
- ✅ Quality-gate dialog before export
- ✅ SAF mirroring on all export paths

### Save lifecycle & navigation (§27.11) — DONE
- ✅ Compute → mismatch resolution → save → marks complete
- ✅ OperationQueue NOW wired: save serialized via enqueue (matches JS pattern)

### Orbbec RGB-D (§27.14) — DONE (pending device verification)
- ✅ `OrbbecManager.kt` + AAR compile-green
- ✅ NOW: source toggle in CaptureFlowScreen (Phone Camera ↔ Orbbec)
- ✅ NOW: OrbbecCaptureStage placeholder composable
- 🟡 Deferred: live RGB-D preview stream, depth sidecar (device needed)

### Depth viewer — DONE
- ✅ `DepthViewerScreen` reads .raw uint16 LE, jet colormap, range stats

### Theming (§27.15) — DONE
- ✅ Oil-palm green dark + light theme, OnMediaColors for camera overlays

## Remaining work (deferred — device or separate session needed)

1. ~~Session data model rework~~ -- DONE (session 2).
2. ~~Capture fidelity (dims/GPS) + lifecycle wiring~~ -- DONE (session 2).
3. ~~Dedup two-canvas + carousel + depth viewer~~ -- DONE (session 4).
4. ~~Orbbec UI source switch + DI wiring~~ -- DONE (session 6). **Device-only verification (Pad 6/Pad 8).**
5. ~~OperationQueue wiring~~ -- DONE (session 6).
6. ~~Pre-save QA panel~~ -- DONE (session 6).
7. ~~DataStore input cache~~ -- DONE (session 6).
8. ~~Detect button wiring~~ -- DONE (session 6).
9. ~~Carousel entry points~~ -- DONE (session 6).
10. Orbbec live RGB-D preview stream + depth sidecar persistence (device needed).
11. sessions.json boot restore (Room DB is source of truth; SAF mirror TODO).
12. Load Folder / Load JSON import UI (complex external dataset import).
13. Swipeable review/retake carousel in capture flow.
14. Annot-log baseline from detector (requires DB schema change).

## How to build / test (this machine)

Use the helper batch files in `Migrasi/`:

```cmd
cd Migrasi
cmd /c _build.bat    :: assembleDebug
cmd /c _test.bat     :: testDebugUnitTest
```

Or manually from PowerShell:

```powershell
$env:JAVA_HOME = 'C:\tools\jdk17\jdk-17.0.19+10'
$env:ANDROID_HOME = 'C:\tools\android-sdk'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
cd Migrasi
.\gradlew.bat :app:assembleDebug --no-daemon --max-workers=4 --console=plain
.\gradlew.bat :app:testDebugUnitTest --no-daemon --console=plain
```

APK: `app/build/outputs/apk/debug/app-debug.apk` (debug applicationId suffix `.debug`).

