# PalmAnnotate Native — Honest Migration Status

> **Audited 2026-06-15** by tracing the live JS app (`../js`, `../index.html`,
> `../android/.../*.kt`) against this Kotlin project, screen by screen and
> function by function. This file supersedes the optimistic "Sudah Dibuat ✅"
> table in `README.md`.
> Build state (latest): `:app:assembleDebug` + `:app:testDebugUnitTest` SUCCESSFUL —
> **101.8 MB APK**, 28/28 tests green, JDK = Android Studio JBR
> (`C:\Program Files\Android\Android Studio\jbr`).
>
> **Progress tracker (workstreams the operator requested):**
> | # | Workstream | State |
> |---|---|---|
> | 1 | Multi-tree session model (run → many trees) | ✅ DONE (built green) |
> | 2 | Capture fidelity + lifecycle wiring | ✅ DONE (built green) |
> | 3 | Dedup two-canvas + carousel + depth viewer | ⏳ NOT STARTED |
> | 4 | Orbbec native port | 🟡 IN PROGRESS — `OrbbecManager.kt` + AAR added and compile-green; UI source switch and depth sidecar still needed; device-only verification pending |
> | — | Domain correctness fixes (suggestion/detector/results/export) | ✅ DONE (audit session) |

## Why the previous "✅ everything" report was misleading

Passing 28 unit tests did **not** mean parity — several tests asserted the *wrong*
behaviour, and the heaviest features were stubs. Concretely, before this session:

| Claimed ✅ | Reality found in code | Fixed this session? |
|---|---|---|
| Dedup math | `SuggestionEngine` was plain **IoU ≥ 0.3** — NOT the real seam-band/size-gate/weighted/mutual-best algorithm in `dedup-utils.js` | ✅ rewritten |
| Detection | `OnnxDetector` **stretched** (no letterbox → wrong coords on non-square images) and **assigned a class** instead of UNASSIGNED (detect-only); wrong default thresholds | ✅ rewritten |
| Output JSON v4 (byte-compatible) | THREE divergent generators; `metadata` had extra fields + `generated_at` at top level; `_confirmedLinks` used runtime ids (breaks round-trip); `by_class` missing `other` | ✅ consolidated to one byte-closer generator |
| Results | `linkedCount` counted cluster *members*, not effective merges (JS `duplicates_linked`); class counts dropped unassigned/"other" | ✅ fixed |
| Save lifecycle | `OperationQueue` class exists but is **not wired** into any navigation/save flow | ⚠️ still unwired |
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

Legend: ✅ done & correct · 🟡 partial · 🔶 wrong model / needs rework · ❌ missing

### Domain core (pure logic) — strong
- ✅ `AnnotationClass`, `Bbox`, `TreeSide`, `CrossSideLink`, `generateAdjacentPairs`
- ✅ `UnionFind` (path compression + union by rank)
- ✅ `YoloParser` (parse/serialize, clamp, 6-dp, excludes UNASSIGNED)
- ✅ `SuggestionEngine` (real algorithm — fixed)
- ✅ `ResultsComputer` (clusters, linkedCount, class counts — fixed)
- ✅ `ExportManager` Output JSON v4 / YOLO / CSV / Identity (byte-diff still TODO)
- ✅ `OutputSchema` round-trip reader (fixed)
- ✅ `SessionUseCases` (class propagation, mismatch detect/resolve, link mgmt, bbox CRUD)
- 🟡 `QualityCheck` exists (Indonesian messages) — but not invoked before export/save
- ✅ `OperationQueue`/`LoadSequence` exist — but not wired (see below)

### Data layer — mostly present
- ✅ Room schema + DAOs + cascade delete
- ✅ `AndroidStorageManager` (`PalmAnnotate/` layout + `deleteTree` cascade)
- ✅ `SafMirrorStore` (DocumentFile read/write/delete)
- 🟡 `sessions.json` index: `writeSessionsIndex`/`readSessionsIndex` (now runs+trees);
  **boot-restore not wired** into app start; SAF mirror of the index is a TODO
- ✅ **Session = run with many trees** (reworked in session 2). `SessionEntity` is the
  run (variety/block/autoId/nextId), `TreeEntity` is the tree; auto/manual tree-id +
  groups + Add-Tree loop implemented in Home/Detail/Capture.
- ✅ **SAF export-folder picker UI** wired: DataStore persistence + home card +
  `ACTION_OPEN_DOCUMENT_TREE` grant + SAF mirroring on addTree/save/output/export.
- ❌ Input-cache persistence (Home hardcodes variety suggestions instead of
  DataStore-backed recents).

### Detection
- ✅ `OnnxDetector` correct now. ❌ not wired to an "auto-detect after capture" or a
  per-side "Detect" button in the UI yet.

### Capture (§27.3) — ✅ functional (hotfix added)
- ✅ Run-locked variety/block, auto/manual tree-id, real **image dims loaded on save**
  (NaN bug fixed), background **GPS** wired (`GpsProvider`), images persisted + `addTree`.
- ✅ Robust save: `file://` cache URIs read directly, save errors surfaced in UI.
- ✅ Post-capture review UI: captured photo preview, thumbnail strip, Retake/Continue,
  progress dots.
- ✅ SAF mirroring of captured images / metadata / labels / annot-logs when export folder set.
- 🟡 Still missing vs JS: swipe **review/retake carousel** (thumbnails jump to side works),
  **pre-save QA panel**, **Orbbec** source + live RGB-D preview, depth sidecar,
  per-capture cache-bust.

### Annotation editor (§27.4) — partial
- 🟡 `AnnotationScreen` + `AnnotationCanvas`: draw/select/move/resize/class picker/side
  nav present; cluster class-propagation via `SessionUseCases`. Verify pinch-zoom/pan,
  ≥44dp handle hit, and unassigned-count UI on device.
- ✅ Keyboard shortcuts (`KeyboardShortcuts.kt`) for hardware keyboards.

### Carousel (§27.5) — ❌ MISSING (no touch swipe-annotate screen)

### Deduplication (§27.6) — 🔶 rework
- 🟡 `DeduplicationScreen` is a **text-list** linker (pick from lists), not the JS
  **two-canvas seam-anchored** surface (click box on image A → box on image B), with
  accept-all-auto, per-signal badges, cross-pair indicators, guideline.

### Results & export (§27.9) — ✅
- ✅ Results compute + display + `saveOutputJson`; **Export Output JSON / YOLO / CSV /
  Identity buttons wired** to `ExportManager`; **quality-gate dialog** before export.
- ✅ All export paths mirror to the configured SAF export folder when one is set.

### Save lifecycle & navigation (§27.11) — 🟡 (session 2)
- ✅ Compute → forces mismatch resolution → save → marks tree complete; export gating.
- 🟡 The `OperationQueue` debounced serialization + auto-save-on-navigate are still not
  wired (screens save explicitly per action — adequate, not 1-on-1 with the JS queue).

### Orbbec RGB-D (§27.14) — 🟡 PARTIAL
- ✅ `OrbbecManager.kt` created and compile-green; AAR in `app/libs/`.
- ✅ USB enumeration/permission, open/close, profile selection, frame pump, flapping
  guard, D2C align, color conversion, depth Y16 capture, depth jet preview — all
  ported from the Capacitor plugin.
- ❌ Not wired into `CaptureFlowScreen` as a selectable source; no live RGB-D preview
  surface; no depth sidecar persistence. Device-only verification (Pad 6/Pad 8) pending.
- ✅ Manifest USB intent-filter + `res/xml/orbbec_usb_filter.xml` present.

### Depth viewer (§27.x) — ❌ (a `DepthUtil` exists; no viewer screen)

### Theming (§27.15) — ✅ oil-palm green dark + light; verify on-media tokens + portrait reflow on device.

## Remaining work, prioritized

1. ~~Session data model rework~~ — ✅ DONE (session 2).
2. ~~Capture fidelity (dims/GPS) + lifecycle wiring (export/mismatch gate)~~ — ✅ DONE (session 2).
3. **HIGH — Orbbec native:** `OrbbecManager.kt` + AAR now compile-green. Remaining:
    UI source switch in `CaptureFlowScreen` (CameraX ⇄ Orbbec), live RGB-D preview,
    depth sidecar persistence. **Device-only verification (Pad 6/Pad 8).**
4. **MEDIUM — Dedup two-canvas surface** (tap box A → box B on the images) + **carousel**
   touch annotate screen + **depth viewer** screen.
5. **MEDIUM — OperationQueue** debounced serialization + auto-save-on-navigate; capture
   **swipeable review/retake carousel** + pre-save QA panel.
6. **MEDIUM — sessions.json boot restore; DataStore input cache.~~SAF export-folder picker UI~~ ✅ DONE.**
7. **LOW — annot-log baseline from the detector (originalBboxes set at load, not = final).**

## How to build / test (this machine)

The JDK in `../CLAUDE.md` (`C:\tools\jdk17`) does **not** exist here. Use the Android
Studio JBR:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
cd Migrasi
# Faster build: use all cores and Gradle caching
$args = ':app:assembleDebug', '--no-daemon', '--max-workers=4', '-Dorg.gradle.parallel=true', '-Dorg.gradle.caching=true', '--console=plain'
& .\gradlew.bat @args

# Or just unit tests
.\gradlew.bat :app:testDebugUnitTest --no-daemon --console=plain
```
APK: `app/build/outputs/apk/debug/app-debug.apk` (debug applicationId suffix `.debug`).
