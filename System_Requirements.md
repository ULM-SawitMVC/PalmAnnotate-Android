# PalmAnnotate — System Requirements (Native Kotlin Rewrite)

> **Purpose:** Complete specification for rewriting PalmAnnotate from a Capacitor WebView
> hybrid app into a **100% native Kotlin Android application**. This document captures every
> feature, data model, integration point, and non-functional requirement so the rewrite is
> **bug-free and high-performance**.

---

## Table of Contents

1. [Application Overview](#1-application-overview)
2. [Target Platform & Constraints](#2-target-platform--constraints)
3. [Architecture & Design Patterns](#3-architecture--design-patterns)
4. [Module Map](#4-module-map)
5. [Data Models](#5-data-models)
6. [Storage Architecture](#6-storage-architecture)
7. [UI / UX Requirements](#7-ui--ux-requirements)
8. [Capture Flow & Camera Integration](#8-capture-flow--camera-integration)
9. [Orbbec USB RGB-D Camera](#9-orbbec-usb-rgb-d-camera)
10. [On-Device Detection (YOLO / ONNX)](#10-on-device-detection-yolo--onnx)
11. [Annotation Surfaces](#11-annotation-surfaces)
12. [Deduplication & Cross-Side Linking](#12-deduplication--cross-side-linking)
13. [Results, Export & Output Schema](#13-results-export--output-schema)
14. [Session Management & Persistence](#14-session-management--persistence)
15. [GPS / Geolocation Tagging](#15-gps--geolocation-tagging)
16. [Quality Check](#16-quality-check)
17. [Theming & Design Tokens](#17-theming--design-tokens)
18. [Performance Requirements](#18-performance-requirements)
19. [Testing Strategy](#19-testing-strategy)
20. [Build & Toolchain](#20-build--toolchain)
21. [Migration & Compatibility](#21-migration--compatibility)
22. [Screen-by-Screen UI Inventory (1-on-1)](#22-screen-by-screen-ui-inventory-1-on-1)
23. [Navigation, View Shell & State Machines](#23-navigation-view-shell--state-machines)
24. [Detailed Behavior Specifications (per module)](#24-detailed-behavior-specifications-per-module)
25. [Keyboard Shortcuts, Gestures & Message Catalog](#25-keyboard-shortcuts-gestures--message-catalog)
26. [Native Plugin Bridge Reference (Orbbec / SAF)](#26-native-plugin-bridge-reference-orbbec--saf)
27. [Complete Feature & Behavior Checklist](#27-complete-feature--behavior-checklist)
28. [Migration Order & Risk Register](#28-migration-order--risk-register)

> **Accuracy note (2026-06-15):** §§22–28 and the corrections in §§2, 10, 17 were
> reconstructed by tracing the live source (`js/`, `index.html`, `android/.../*.kt`,
> `*.java`). Where this document and a code comment disagree, the **code is
> authoritative**. Several stale claims in the original draft were corrected:
> targetSdk/compileSdk is **34** (not 35); the design tokens are an **oil-palm
> green** palette (not slate/blue); detection emits **UNASSIGNED** boxes (never a
> default B2); and the on-disk detector thresholds differ from the JS defaults.

---

## 1. Application Overview

**PalmAnnotate** is a field-oriented oil-palm Fresh Fruit Bunch (FFB) image annotation tool
for counting and grading fruit bunches on individual palm trees.

### 1.1 Core Workflow

```
Capture (multiple sides per tree)
  → Annotate (draw/assign bounding boxes with class B1–B4)
    → Deduplicate (link same bunch seen on adjacent sides)
      → Count (unique bunches per class)
        → Export (YOLO .txt, Output JSON, CSV, identity exports)
```

### 1.2 Key Features (Must All Be Preserved)

| Feature | Description |
|---|---|
| Multi-side tree capture | 2–N sides per tree, sequential capture with live camera preview |
| Metadata form | Variety, block, tree ID, date, GPS coordinates |
| Bbox annotation | Draw, move, resize, delete bounding boxes; assign class B1–B4 |
| Unassigned boxes | New/detected boxes start as UNASSIGNED (grey) — expert assigns class |
| On-device YOLO detection | Run inference to pre-populate boxes before manual editing |
| Cross-side deduplication | Geometry-based suggestions + manual linking of same bunch across sides |
| Union-Find clustering | Linked boxes form clusters; class propagation across cluster |
| Results & counting | Unique bunch count per class, raw detections, linked duplicates |
| Export formats | YOLO .txt, Output JSON (v4), CSV, identity JSON |
| Session management | Create, save, resume, delete sessions; autosave |
| SAF export folder | Mirror exports to a user-picked public folder |
| Portable session index | `sessions.json` survives app reinstall via SAF folder |
| Orbbec USB RGB-D camera | Full support for Orbbec Gemini 335L with depth sidecar |
| GPS tagging | Optional GPS coordinates on captured tree sets |
| Light/dark theme | System-driven, token-based |
| Portrait phone support | Responsive layout for 6–7″ phones in portrait |

### 1.3 Current Tech Stack (Being Replaced)

| Layer | Current | Native Rewrite |
|---|---|---|
| App logic | ES5/ES2017 IIFEs in `<script>` tags | Kotlin |
| UI | HTML/CSS rendered in Android WebView | Jetpack Compose / XML Views |
| Storage | Capacitor Filesystem plugin | Kotlin `java.io` / `DocumentFile` |
| Camera | WebView `getUserMedia` | CameraX |
| USB Camera | Kotlin Capacitor plugin (OrbbecPlugin.kt) | Native Kotlin service |
| Detection | onnxruntime-web (WASM) in WebView | onnxruntime-android (native) |
| Session state | JavaScript objects + `localStorage` | Room DB / Proto DataStore |
| Capacitor plugins | OrbbecPlugin.kt, SafPlugin.kt | Native code (no bridge) |

---

## 2. Target Platform & Constraints

### 2.1 Device Targets

| Attribute | Value |
|---|---|
| Primary device | Xiaomi Pad 6 (`pipa`, 23043RP34G) |
| Secondary device | Xiaomi Pad 8 (Android 16) |
| Form factor | 11″ tablet (landscape primary) + 6–7″ phone (portrait) |
| Min SDK | 24 (required by Orbbec SDK) — `android/variables.gradle` |
| Target SDK | **34** (`targetSdkVersion = 34`) |
| Compile SDK | **34** (`compileSdkVersion = 34`) |
| ABI | `arm64-v8a` only (`abiFilters 'arm64-v8a'`; `armeabi-v7a` NOT packaged) |
| versionName / versionCode | `2.0` / `1` (both env-overridable: `PA_VERSION_NAME`, `PA_VERSION_CODE`) |
| App id / namespace | `dev.sawitulm.palmannotate` |
| R8 (minify) + resource shrink | **OFF** in BOTH debug and release (`minifyEnabled false`, `shrinkResources false`) — disabling R8 is what restored the Orbbec live preview; see CLAUDE.md |
| Capacitor plugins installed | `@capacitor/filesystem`, `@capacitor/camera`, `@capacitor/preferences` (Geolocation NOT installed — GPS uses WebView `navigator.geolocation`) |

### 2.2 Hardware Requirements

| Feature | Required? | Notes |
|---|---|---|
| Camera (rear) | Required | For field capture |
| USB-OTG host | Optional | For Orbbec camera; app works without it |
| GPS | Optional | Capture degrades to no-GPS if unavailable |
| Internet | Not required | Fully offline capable |

### 2.3 Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-feature android:name="android.hardware.usb.host" android:required="false" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<uses-feature android:name="android.hardware.location.gps" android:required="false" />
```

---

## 3. Architecture & Design Patterns

### 3.1 Recommended Architecture: **MVVM + Clean Architecture**

```
┌──────────────────────────────────────────────────┐
│                  Presentation                     │
│  ┌─────────────┐  ┌─────────────┐               │
│  │   Compose UI │  │   ViewModels│               │
│  └──────┬──────┘  └──────┬──────┘               │
├─────────┼────────────────┼───────────────────────┤
│         │       Domain   │                       │
│  ┌──────┴────────────────┴──────┐                │
│  │        Use Cases              │                │
│  │  (AnnotateTree, RunDetection, │                │
│  │   ComputeResults, ExportData) │                │
│  └──────────────┬───────────────┘                │
│                 │                                 │
├─────────────────┼────────────────────────────────┤
│           Data  │                                 │
│  ┌──────────────┴───────────────┐                │
│  │     Repositories              │                │
│  │  (SessionRepo, DatasetRepo,  │                │
│  │   ExportRepo, SettingsRepo)  │                │
│  └──┬────────┬────────┬─────────┘                │
│     │        │        │                           │
│  ┌──┴──┐ ┌──┴──┐ ┌───┴───┐                      │
│  │ Room│ │File │ │CameraX│                       │
│  │  DB │ │System│ │+ Orbbec│                      │
│  └─────┘ └─────┘ └───────┘                       │
└──────────────────────────────────────────────────┘
```

### 3.2 Key Patterns

| Pattern | Usage |
|---|---|
| **MVVM** | Each screen → ViewModel → UseCase → Repository |
| **Repository** | Abstract data sources (Room, filesystem, SAF) |
| **Use Case** | Single-responsibility business logic (OrbbecPlugin already a good model) |
| **StateFlow/SharedFlow** | Reactive UI updates, camera frame streams |
| **Coroutines** | All I/O on Dispatchers.IO; UI updates on Main |
| **Dependency Injection** | Hilt/Dagger for testability |
| **sealed class** | Model UI states, export results, camera states |

### 3.3 Technology Choices

| Component | Choice | Rationale |
|---|---|---|
| Language | Kotlin 2.0+ | Modern, null-safe, coroutines |
| UI Toolkit | Jetpack Compose | Declarative, Material 3, responsive layouts |
| Navigation | Compose Navigation or NavigationRail + NavHost | Multi-pane on tablet |
| Database | Room | Structured session/tree/bbox data |
| Preferences | DataStore (Proto or Prefs) | Settings, SAF URI, last session |
| File I/O | `java.io` + `DocumentFile` (SAF) | Current approach works, keep it |
| Camera | CameraX | Standard Android camera API, lifecycle-aware |
| USB Camera | Orbbec SDK (keep existing AAR) | `OrbbecPlugin.kt` logic, remove Capacitor bridge |
| ML Inference | onnxruntime-android (native) | Much faster than WASM, GPU delegate available |
| Image loading | Coil | Efficient image loading for Compose |
| DI | Hilt | Compile-time DI, ViewModel integration |
| Testing | JUnit 5 + Turbine + Mockk + Compose UI Test | Full coverage |

---

## 4. Module Map

Each current JS module maps to a Kotlin package/class. The mapping is:

### 4.1 Feature Modules

| Current JS File | Kotlin Package / Class | Responsibility |
|---|---|---|
| `js/app.js` | `ui.home`, `ui.sessiondetail`, Main Activity | Tab navigation, tree list, keyboard shortcuts |
| `js/yolo-io.js` | `domain.model.AnnotationClass`, `data.yolo.YoloParser` | Class map (B1–B4, U), YOLO parse/serialize |
| `js/dataset.js` | `data.dataset.DatasetRepository` | Group image/label files into per-tree sides |
| `js/session.js` | `domain.model.ActiveSession`, `domain.usecase.*` | In-memory tree state, bbox CRUD, links, clustering |
| `js/dedup-utils.js` | `domain.dedup.SuggestionEngine` | Pure geometry cross-side duplicate suggester |
| `js/results.js` | `domain.results.ResultsComputer` | Counting, result computation |
| `js/output-schema.js` | `data.export.OutputSchemaGenerator` | Canonical per-tree output JSON v4 |
| `js/bbox-editor.js` | `ui.annotation.BboxEditorScreen` | Annotation editor surface |
| `js/dedup-ui.js` | `ui.dedup.DedupScreen` | Dedup comparison surface |
| `js/carousel/carousel-ui.js` | `ui.carousel.CarouselScreen` | Touch annotation carousel |
| `js/canvas.js` | `ui.common.CanvasRenderer` | Class colours + bbox drawing on Canvas |
| `js/capture/capture-flow.js` | `ui.capture.CaptureFlowScreen` | Metadata form, per-side capture, GPS |
| `js/capture/capture-source.js` | `data.camera.BuiltInCameraSource` | Device camera via CameraX |
| `js/capture/orbbec-source.js` | `data.camera.OrbbecCameraSource` | Orbbec USB camera (mirrors OrbbecPlugin logic) |
| `js/detect/detector.js` | `data.detection.OnnxDetector` | On-device YOLO via onnxruntime-android |
| `js/storage/storage-adapter.js` | `data.storage.StorageAdapter` (interface) | Platform-agnostic storage facade |
| `js/storage/capacitor-adapter.js` | `data.storage.AndroidStorageAdapter` | Native filesystem I/O |
| `js/storage/fsa-adapter.js` | **Not needed** (web-only) | Drop from native rewrite |
| `js/storage/saf-store.js` | `data.storage.SafMirrorStore` | SAF folder mirror |
| `js/persist/session-store.js` | `data.storage.SessionPersistence` | Autosave, session index |
| `js/project.js` | `data.project.ProjectConfig` | Thin facade over storage |
| `js/fs-output.js` | `data.export.ExportWriter` | Write exports to filesystem |
| `js/quality-check.js` | `domain.quality.QualityChecker` | Annotation quality checks |
| `js/viewer/depth-viewer.js` | `ui.viewer.DepthViewerScreen` | Depth sidecar visualization |

### 4.2 Simplified Module Dependency Graph

```
ui.*
  ├── domain.usecase.*
  │     ├── domain.model.*
  │     ├── domain.dedup.*
  │     ├── domain.results.*
  │     └── domain.quality.*
  └── data.repository.*
        ├── data.storage.*
        │     ├── Room DB
        │     ├── Filesystem (java.io)
        │     └── SAF (DocumentFile)
        ├── data.camera.*
        │     ├── CameraX
        │     └── Orbbec SDK
        ├── data.detection.*
        │     └── onnxruntime-android
        └── data.export.*
              └── Output JSON, YOLO, CSV writers
```

---

## 5. Data Models

### 5.1 Core Domain Models

```kotlin
// ─── Annotation Class ────────────────────────────────────────────────────────
enum class AnnotationClass(val id: Int, val displayName: String, val color: Long) {
    B1(0, "B1", 0xFF3B82F6),   // Blue
    B2(1, "B2", 0xFFEF4444),   // Red
    B3(2, "B3", 0xFFF59E0B),   // Amber
    B4(3, "B4", 0xFF8B5CF6),   // Purple
    UNASSIGNED(-1, "U", 0xFF9CA3AF); // Grey

    companion object {
        fun fromId(id: Int) = entries.firstOrNull { it.id == id } ?: UNASSIGNED
        val assignableEntries = entries.filter { it != UNASSIGNED }
    }
}

// ─── Bounding Box ────────────────────────────────────────────────────────────
data class Bbox(
    val id: String,            // "b0", "b1", ...
    val classId: Int,          // AnnotationClass.id
    val className: String,     // "B1"–"B4" or "U"
    val x1: Float,             // pixel coords
    val y1: Float,
    val x2: Float,
    val y2: Float,
)

// ─── Side (one photo of a tree) ──────────────────────────────────────────────
data class TreeSide(
    val sideIndex: Int,
    val label: String,         // "Side 1", "Side 2", ...
    val imageUri: Uri?,        // URI of the captured image
    val labelUri: Uri?,        // URI of the .txt label file (may not exist yet)
    val imageWidth: Int,
    val imageHeight: Int,
    val bboxes: List<Bbox>,
    val originalBboxes: List<Bbox>,  // snapshot at load time for annot-log diffing
)

// ─── Cross-Side Link ─────────────────────────────────────────────────────────
data class CrossSideLink(
    val linkId: String,        // "L0", "L1", ...
    val sideA: Int,
    val bboxIdA: String,
    val sideB: Int,
    val bboxIdB: String,
)

// ─── Active Session (in-memory state for one tree) ───────────────────────────
data class ActiveSession(
    val treeName: String,
    val split: String,         // "train", "val", "test", or "field"
    val sides: List<TreeSide>,
    val suggestedLinks: List<CrossSideLink>,
    val confirmedLinks: List<CrossSideLink>,
    val dirty: Boolean = false,
)

// ─── Dataset Tree (file-level grouping) ──────────────────────────────────────
data class DatasetTree(
    val name: String,          // e.g. "DAMIMAS_A21B_0001"
    val split: String,
    val sides: List<DatasetSide>,
    val metadata: TreeMetadata?,
)

data class DatasetSide(
    val sideIndex: Int,
    val imageFile: File?,      // on-disk file
    val labelFile: File?,
    val imageUri: Uri,
    val labelUri: Uri?,
)

data class TreeMetadata(
    val variety: String,
    val block: String,
    val date: String,
    val latitude: Double?,
    val longitude: Double?,
)
```

### 5.2 Room Database Schema

```kotlin
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val sessionId: String,   // UUID
    val treeName: String,
    val split: String,
    val createdAt: Long,
    val updatedAt: Long,
    val isComplete: Boolean = false,
    val exportFolderPath: String?,       // SAF tree URI
)

@Entity(tableName = "sides")
data class SideEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: String,
    val sideIndex: Int,
    val label: String,
    val imageUri: String,
    val imageWidth: Int,
    val imageHeight: Int,
    @ColumnInfo(name = "label_uri") val labelUri: String?,
    foreignKeys = [ForeignKey(
        entity = SessionEntity::class,
        parentColumns = ["sessionId"],
        childColumns = ["sessionId"],
        onDelete = ForeignKey.CASCADE
    )]
)

@Entity(tableName = "bboxes")
data class BboxEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sideId: Long,
    val bboxId: String,           // "b0", "b1"
    val classId: Int,
    val className: String,
    val x1: Float, val y1: Float,
    val x2: Float, val y2: Float,
    foreignKeys = [ForeignKey(
        entity = SideEntity::class,
        parentColumns = ["id"],
        childColumns = ["sideId"],
        onDelete = ForeignKey.CASCADE
    )]
)

@Entity(tableName = "confirmed_links")
data class ConfirmedLinkEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: String,
    val linkId: String,
    val sideA: Int, val bboxIdA: String,
    val sideB: Int, val bboxIdB: String,
    foreignKeys = [ForeignKey(
        entity = SessionEntity::class,
        parentColumns = ["sessionId"],
        childColumns = ["sessionId"],
        onDelete = ForeignKey.CASCADE
    )]
)

@Entity(tableName = "metadata")
data class MetadataEntity(
    @PrimaryKey val sessionId: String,
    val variety: String,
    val block: String,
    val date: String,
    val latitude: Double?,
    val longitude: Double?,
    foreignKeys = [ForeignKey(
        entity = SessionEntity::class,
        parentColumns = ["sessionId"],
        childColumns = ["sessionId"],
        onDelete = ForeignKey.CASCADE
    )]
)
```

### 5.3 Output JSON Schema (v4) — Must Be Byte-Compatible

The native rewrite **MUST** produce identical `Output JSON v4` output. The schema
(generated by `OutputSchema.generate()` in the JS version) is:

```json
{
  "version": 4,
  "tree_id": "DAMIMAS_A21B_0001",
  "tree_name": "DAMIMAS_A21B_0001",
  "split": "field",
  "metadata": {
    "variety": "DAMIMAS",
    "generated_at": "2026-06-15T10:30:00.000Z"
  },
  "images": {
    "side_1": {
      "filename": "DAMIMAS_A21B_0001_1.jpg",
      "label_file": "DAMIMAS_A21B_0001_1.txt",
      "side_index": 0,
      "side_label": "Side 1",
      "width": 3024,
      "height": 4032,
      "bbox_count": 5,
      "annotations": [
        {
          "box_index": 0,
          "class_id": 1,
          "class_name": "B2",
          "bbox_yolo": [0.512345, 0.345678, 0.098765, 0.123456],
          "bbox_pixel": [1399, 1140, 1697, 1637]
        }
      ]
    }
  },
  "bunches": [
    {
      "bunch_id": 1,
      "class": "B2",
      "class_mismatch": false,
      "appearance_count": 2,
      "appearances": [
        { "side": "side_1", "side_index": 0, "box_index": 0, "class_name": "B2", "bbox_pixel": [...] },
        { "side": "side_2", "side_index": 1, "box_index": 2, "class_name": "B2", "bbox_pixel": [...] }
      ]
    }
  ],
  "_confirmedLinks": [
    { "linkId": "L0", "sideA": 0, "bboxIdA": "b0", "sideB": 1, "bboxIdB": "b2" }
  ],
  "summary": {
    "total_unique_bunches": 12,
    "total_detections": 18,
    "duplicates_linked": 6,
    "by_class": { "B1": 3, "B2": 5, "B3": 2, "B4": 2 },
    "by_side": { "side_1": 5, "side_2": 4, "side_3": 5, "side_4": 4 }
  }
}
```

**Critical:** The `_confirmedLinks` array is used to restore cross-side links when
re-loading an output JSON. The rewrite must preserve this round-trip fidelity.

### 5.4 YOLO Label Format

```
<classId> <cx> <cy> <w> <h>
```

- `classId`: integer 0–3 (B1–B4). UNASSIGNED boxes (`-1` / "U") are **excluded**.
- `cx, cy, w, h`: normalized 0–1, 6 decimal places.
- One line per assigned box. The rewrite must produce identical `.txt` output.

---

## 6. Storage Architecture

### 6.1 Storage Root

All app data lives in **app-external storage** (no runtime permission needed):

```
/Android/data/dev.sawitulm.palmannotate/files/PalmAnnotate/
├── images/
│   └── field/
│       ├── DAMIMAS_A21B_0001_1.jpg
│       ├── DAMIMAS_A21B_0001_2.jpg
│       └── ...
├── labels/
│   └── field/
│       ├── DAMIMAS_A21B_0001_1.txt
│       └── ...
├── depth/
│   └── field/
│       ├── DAMIMAS_A21B_0001_1.raw
│       ├── DAMIMAS_A21B_0001_1.json
│       └── ...
├── metadata/
│   ├── DAMIMAS_A21B_0001.json
│   └── ...
├── annotlog/
│   └── field/
│       ├── DAMIMAS_A21B_0001_1.json
│       └── ...
├── Output JSON/
│   ├── DAMIMAS_A21B_0001.json
│   └── ...
├── Output TXT/
│   └── field/
│       ├── DAMIMAS_A21B_0001_1.txt
│       └── ...
├── exports/           (downloadable session ZIP)
├── snapshots/         (session snapshot backups)
└── sessions.json      (portable session index)
```

### 6.2 SAF Export Folder (Mirror)

When configured, files are **also** mirrored to a user-chosen public folder:

```
<UserChosenFolder>/PalmAnnotate/
├── dataset/images/field/
├── dataset/metadata/
├── Output JSON/
└── Output TXT/field/
```

The SAF mirror is **best-effort** — the app-external store is the source of truth.
The chosen tree URI is persisted in DataStore and re-verified on each use.

### 6.3 File Operations

| Operation | Primary (app-external) | Mirror (SAF) |
|---|---|---|
| Write captured image | `java.io.FileOutputStream` | `DocumentFile.createFile()` + `openOutputStream()` |
| Write YOLO .txt | `java.io.File.writeText()` | `DocumentFile` chain |
| Write Output JSON | `java.io.File.writeText()` | `DocumentFile` chain |
| Read image for display | Direct `File` → `Uri.fromFile()` → Coil | N/A |
| Delete tree files | `File.delete()` recursive | `DocumentFile.delete()` |
| Read sessions.json | `File.readText()` | `SafPlugin.readFile()` equivalent |

### 6.4 Image URL Strategy

| Context | URL Type | Notes |
|---|---|---|
| Display captured photo | `Uri.fromFile(file)` | Direct file URI, Coil loads natively |
| After delete+reuse | Force cache-bust query param | Prevent stale WebView/Coil cache |

---

## 7. UI / UX Requirements

### 7.1 Screen Map

| Screen | Description | Orientation |
|---|---|---|
| **Home** | Session list, new session, export folder config | Any |
| **Session Detail** | Tree list for a session, add tree, delete tree | Any |
| **Capture Flow** | Metadata form → per-side camera capture → GPS | Portrait primary |
| **Annotation Editor** | Full-screen canvas + bbox tools sidebar | Landscape tablet / portrait phone |
| **Carousel** | Touch-based swipe annotation (primary on phone) | Portrait |
| **Deduplication** | Side-by-side canvases, link/unlink boxes | Landscape tablet / stacked portrait |
| **Results** | Count tables, export buttons | Any |
| **Depth Viewer** | Orbbec depth sidecar visualization | Any |
| **Settings** | Export folder, theme, detection model config | Any |

### 7.2 Responsive Layout Rules

**Tablet (landscape, ≥768px):**
- Annotation Editor: sidebar (tools) on left, canvas fills rest
- Deduplication: two canvases side-by-side
- Results: multi-column layout

**Phone (portrait, ≤768px):**
- Annotation Editor: canvas fills screen, horizontal control strip at bottom
- Deduplication: canvases stacked top/bottom, horizontal seam
- Results: single column
- Primary annotation surface: Carousel (swipe between sides)
- Toolbar: max 2 primary actions + overflow menu

### 7.3 Touch Targets

- Minimum: 48dp × 48dp
- Spacing: ≥8dp between interactive elements
- Bbox handles: ≥44dp hit area for resize/drag on touch

### 7.4 Navigation

```
Home → Session Detail → Capture Flow → Annotation
                       → Annotation (edit existing)
                       → Deduplication
                       → Results → Export
```

Bottom navigation or navigation rail on tablet. Full-screen immersive for annotation.

### 7.5 Critical UI Behaviors

1. **Annotation class assignment:** Tap bbox → class picker popup → assign. No default class.
2. **Unassigned indicator:** "N unassigned" shown in warn color on editor and carousel.
3. **Class propagation:** Changing class on a clustered bbox propagates to all linked boxes.
4. **Magnifier/loupe:** **DISABLED** (removed by request). Keep toggle API but default OFF.
5. **Orientation lock:** None. Capture is portrait 9:16; all other screens support any orientation.
6. **Global header:** Hidden on home/session-detail views (they have their own headers).

---

## 8. Capture Flow & Camera Integration

### 8.1 Capture Flow Steps

```
1. Metadata Form
   ├── Variety (dropdown or custom)
   ├── Block (text)
   ├── Tree ID (auto-generated or manual)
   ├── Date (default: today)
   └── GPS (optional, auto-acquire)

2. Side Capture (repeat for N sides)
   ├── Show live camera preview
   ├── Capture photo (shutter button)
   ├── Review / retake
   └── Auto-advance to next side

3. Run Detection (optional)
   ├── ONNX YOLO inference on captured images
   └── Pre-populate bounding boxes (UNASSIGNED)

4. Save → Return to Session Detail
```

### 8.2 CameraX Integration

```kotlin
// CameraX use cases needed:
// - Preview: live viewfinder
// - ImageCapture: high-res JPEG capture
// - (No ImageAnalysis needed unless doing real-time detection)

class CameraManager(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
) {
    private var cameraProvider: ProcessCameraProvider? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null

    suspend fun bindCamera(previewView: PreviewView) { ... }
    suspend fun captureImage(outputFile: File): Uri { ... }
    fun switchCamera() { ... } // front/back
    fun release() { ... }
}
```

### 8.3 Image Specifications

| Parameter | Value |
|---|---|
| Capture resolution | Max available (typically 3024×4032 on Xiaomi Pad 6) |
| Format | JPEG, quality 95 |
| Orientation | Respect EXIF rotation |
| Preview resolution | 720p max for display |

---

## 9. Orbbec USB RGB-D Camera

### 9.1 Overview

The Orbbec Gemini 335L is a USB RGB-D camera providing synchronized color + depth frames.
The current `OrbbecPlugin.kt` (1691 lines) contains all the logic — it must be extracted
from the Capacitor plugin wrapper and integrated natively.

### 9.2 SDK Integration

- **AAR:** `obsensor_v2.0.6_2026031801_release.aar` (keep as vendored dependency)
- **USB host filter:** `res/xml/orbbec_usb_filter.xml` (vendor ID 0x2BC5 = 11205)
- **ABI:** arm64-v8a only (slim AAR already generated, 32-bit removed)

### 9.3 USB Host Permission Flow

```
1. BroadcastReceiver for ACTION_USB_DEVICE_ATTACHED/DETACHED
2. Check vendor ID == 0x2BC5
3. Request USB permission via PendingIntent
4. On grant: pre-warm OBContext
5. On open: OBContext → DeviceList → Device → Pipeline → start(config)
```

### 9.4 Frame Pipeline

```
Pipeline.waitForFrameSet(timeout)
  → ColorFrame → encode to JPEG (handle MJPG/RGB/BGR/YUYV/NV12/I420/etc.)
  → DepthFrame → raw uint16 + valueScale
  → Throttled preview (RGB @ ~12.5fps, Depth @ ~6.25fps) via callback
  → Full-res capture via one-shot CaptureWaiter
```

### 9.5 Flapping Guard (USB Power Management)

The Pad 8 (Android 16) can brown out the Orbbec when depth is enabled. The flapping guard:

1. Counts USB detaches in a 20s sliding window
2. After 2 detaches: step down to color-only (disable depth)
3. After 2 more: suppress auto-open entirely
4. Reset on clean replug (30s quiet gap) or explicit "Find camera" button
5. Notify UI of state changes ("needsPower", "unstable")

**This logic MUST be preserved exactly in the rewrite.**

### 9.6 Depth Sidecar

Captured images include optional depth data saved as:

| File | Format | Content |
|---|---|---|
| `{tree}_{side}.raw` | Binary uint16 LE | Raw depth plane, aligned to color (D2C) |
| `{tree}_{side}.json` | JSON | Metadata: width, height, format, valueScale, alignment |

### 9.7 Preview Encoding

| Stream | Max Dimension | Quality | Interval |
|---|---|---|---|
| RGB preview | 720px | JPEG 60 | 80ms (~12.5fps) |
| Depth preview | 288px | JPEG 70 | 160ms (~6.25fps) |

Depth colormap: Jet, auto-ranged via P2–P98 percentiles with EMA smoothing.

---

## 10. On-Device Detection (YOLO / ONNX)

### 10.1 Model

| Property | Value |
|---|---|
| Model file | `ffb-detector.onnx` (~9.8 MB) |
| Architecture | YOLOv8-style |
| Input | RGB image, letterboxed to model size |
| Output | `[1, 4+nc, N]` tensor (cx, cy, w, h + class scores) |
| Classes | 4 (B1–B4) |
| Runtime | onnxruntime-android (native, not WASM) |

### 10.2 Detection Flow

```
1. Load image → drawable (HTMLImageElement / Bitmap)
2. Letterbox into inputSize×inputSize: keep aspect, pad with neutral grey
   rgb(114,114,114) (Ultralytics default); normalize 0–1; pack NCHW Float32
3. Run inference → raw tensor; auto-orient [1,4+nc,N] vs [1,N,4+nc]
4. Decode: score = (single-class → the one class prob, acting as objectness;
   multi-class → max class prob); threshold by confThreshold (LOW, over-detect);
   undo pad+scale back to original image pixels; clamp to bounds; drop <1px boxes
5. Class-agnostic NMS at iouThreshold, cap at maxBoxes
6. Output: List<Bbox> — **every box is UNASSIGNED** (`classId -1` / `className 'U'`),
   `id = 'det'+i`, carrying the raw `score`. DETECT-ONLY: the model class is never
   trusted; the expert assigns a class. (The JS header comment that says "default
   B2" is stale — the code emits UNASSIGNED.)
```

### 10.3 Model Configuration

**Two layers** — `DEFAULT_CONFIG` in `detector.js`, overridden by
`models/detector.config.json` when present (fetched `no-store`). The on-disk file
currently in the repo (authoritative for the build) is:
```json
{ "modelFile": "ffb-detector.onnx", "inputSize": 640,
  "confThreshold": 0.01, "iouThreshold": 0.30, "maxBoxes": 300, "classAware": false }
```
The JS `DEFAULT_CONFIG` fallback (used if the JSON is missing) is
`confThreshold: 0.05, iouThreshold: 0.35, maxBoxes: 300, classAware: false`.
There is **no `classes` array** — the model is treated as single-class detect-only;
`classAware` only matters for a multi-class export (`nc > 1`). The rewrite must read
`detector.config.json` from `assets/` and apply the same merge-over-defaults.

### 10.4 Performance Target

| Metric | Current (WASM) | Target (Native) |
|---|---|---|
| Inference time (640px) | ~2–4 seconds | <500ms |
| Memory usage | ~200MB (WASM heap) | <100MB |
| GPU delegate | Not available | NNAPI/GPU if available |

### 10.5 Graceful Degradation

- Detection never throws — returns empty list `[]` on failure
- Model file bundled in `assets/models/`
- Lazy initialization (don't load model until first detection request)

---

## 11. Annotation Surfaces

### 11.1 Bbox Editor (Tablet Landscape)

**Layout:**
```
┌──────────────────────────────────────────┐
│  [Side selector] [Class] [Detect] [Undo] │  ← toolbar
├────────┬─────────────────────────────────┤
│ Tools  │                                 │
│  ───   │        Canvas                   │
│ Select │     (image + bboxes)            │
│ Draw   │                                 │
│ Delete │                                 │
│ Class  │                                 │
│  ───   │                                 │
│ Zoom   │                                 │
│ Pan    │                                 │
│        │                                 │
├────────┴─────────────────────────────────┤
│  Status: 5 bboxes, 2 unassigned          │  ← status bar
└──────────────────────────────────────────┘
```

### 11.2 Canvas Rendering

```kotlin
class AnnotationCanvas(context: Context) : View(context) {
    // Draw image
    // Draw bboxes with class colors
    // Handle touch: pan, zoom, draw, select, resize, drag
    // Min gesture area: 44dp for handles

    fun setImage(uri: Uri) { ... }
    fun setBboxes(bboxes: List<Bbox>) { ... }
    fun setSelectedBbox(id: String?) { ... }
    fun setTool(tool: AnnotationTool) { ... }
}
```

**Class colors (literal, NOT tokenized):**
```kotlin
object ClassColors {
    val B1 = Color(0xFF3B82F6) // Blue
    val B2 = Color(0xFFEF4444) // Red
    val B3 = Color(0xFFF59E0B) // Amber
    val B4 = Color(0xFF8B5CF6) // Purple
    val UNASSIGNED = Color(0xFF9CA3AF) // Grey
}
```

### 11.3 Touch Gestures

| Gesture | Action |
|---|---|
| Single tap on bbox | Select (show handles, highlight) |
| Single tap on empty | Deselect |
| Drag on empty | Pan canvas |
| Pinch | Zoom canvas |
| Drag handle | Resize bbox |
| Drag bbox body | Move bbox |
| Long press + drag | Draw new bbox |
| Two-finger tap | Undo |

### 11.4 Carousel (Phone Portrait)

Swipeable card-based annotation. Each card is one side:

```
┌──────────────────────┐
│  ← Tree Name (2/4) → │
├──────────────────────┤
│                      │
│    Image             │
│    (full width)      │
│    + Bboxes          │
│                      │
├──────────────────────┤
│ 5 bboxes | 2 unass.  │
│ [B1][B2][B3][B4]     │  ← class buttons
│ [Detect] [Tools...]  │
└──────────────────────┘
  Swipe ← → to change side
```

### 11.5 Deduplication Surface

Two canvases showing adjacent sides. Operator taps a box on each canvas to link:

- **Tablet:** side-by-side canvases
- **Phone:** stacked vertically, seam runs horizontally
- Navigation: prev/next pair arrows
- "Run Suggestions" in overflow menu
- Tap box on left → tap box on right → link created
- Tap linked box → unlink option

---

## 12. Deduplication & Cross-Side Linking

### 12.1 Suggestion Algorithm

Pure geometry cross-side duplicate detection (`dedup-utils.js` → `SuggestionEngine`):

```
For each pair of adjacent sides (i, i+1):
  For each bbox A on side i:
    For each bbox B on side i+1:
      Compute overlap / IoU
      If IoU > threshold → suggest as duplicate pair
```

### 12.2 Union-Find Clustering

Confirmed links form clusters via Union-Find:

```kotlin
class UnionFind(nodes: Collection<String>) {
    private val parent = nodes.associateWith { it }.toMutableMap()
    private val rank = nodes.associateWith { 0 }.toMutableMap()

    fun find(x: String): String { ... } // path compression
    fun union(a: String, b: String) { ... } // union by rank
    fun clusters(): Map<String, List<String>> { ... }
}
```

### 12.3 Class Propagation

When a bbox's class is changed, the change propagates to all bboxes in the same
confirmed cluster (Union-Find root). This is configurable via `propagate` parameter.

### 12.4 Adjacent Pair Rules

- 2 sides: `[[0, 1]]` — single pair, no wraparound
- 3+ sides: `[[0,1], [1,2], ..., [N-1, 0]]` — clockwise with wraparound
- Links are only valid between adjacent pairs
- Links are oriented (lower side index first) for dedup keying

---

## 13. Results, Export & Output Schema

### 13.1 Results Computation

```kotlin
data class TreeResults(
    val rawCount: Int,          // total bboxes (all sides)
    val linkedCount: Int,       // bboxes involved in cross-side links
    val uniqueCount: Int,       // unique bunches (clusters + unlinked singles)
    val unassignedCount: Int,   // bboxes with class UNASSIGNED
    val classCounts: Map<AnnotationClass, Int>, // per-class unique counts
    val clusters: Map<String, List<Bbox>>,       // cluster root → members
)
```

### 13.2 Export Formats

| Format | Description | File |
|---|---|---|
| YOLO .txt | One file per side, assigned classes only | `Output TXT/field/{tree}_{side}.txt` |
| Output JSON v4 | Full tree data (see §5.3) | `Output JSON/{tree}.json` |
| CSV | Flat table of bunches | `{tree}.csv` |
| Identity JSON | Per-box identity with cluster membership | `{tree}_identity.json` |

### 13.3 Export Write Path

1. Write to app-external (`PalmAnnotate/Output JSON/`, etc.)
2. If SAF mirror configured → also write to SAF folder
3. Export is **async** and non-blocking
4. Errors in SAF mirror are logged but don't block the primary export

### 13.4 Annot-Log Sidecar

On save, `_saveAnnotLog` writes per-side sidecar recording:
- `suggestions`: detector baseline (`side.originalBboxes`)
- `final`: expert result (`side.bboxes`)

```json
{
  "treeName": "DAMIMAS_A21B_0001",
  "sideIndex": 0,
  "split": "field",
  "savedAt": "2026-06-15T10:30:00.000Z",
  "suggestions": [...],
  "final": [...]
}
```

---

## 14. Session Management & Persistence

### 14.1 Session Lifecycle

```
Create Session (metadata)
  → Add Trees (capture or import)
    → Annotate (per tree, per side)
      → Deduplicate
        → Results
          → Export
            → Complete
```

### 14.2 Portable Session Index

`sessions.json` (written to app-external + SAF mirror on every mutation):

```json
[
  {
    "id": "uuid-here",
    "treeName": "DAMIMAS_A21B_0001",
    "split": "field",
    "createdAt": 1718445000000,
    "updatedAt": 1718445600000,
    "treeCount": 12,
    "variety": "DAMIMAS",
    "block": "A21B",
    "isComplete": false
  }
]
```

### 14.3 Autosave

- After every mutation (bbox add/remove/update, link confirm/unlink, class change)
- Debounced (don't save more than once per 500ms)
- Write to Room DB (primary) + filesystem export (secondary)

### 14.4 Delete Tree / Delete Session

Must remove:
- App-external images, labels, depth sidecars, metadata
- Output JSON/TXT, annot-log, snapshots
- SAF mirror files
- Room DB records (cascade)
- In-memory state references
- Image cache (Coil)

### 14.5 Session Restore

On app boot:
1. Read Room DB for sessions
2. If Room is empty, try `sessions.json` from app-external
3. If that's empty, try SAF mirror's `sessions.json`
4. Import/merge if found (dedupe by session ID)

---

## 15. GPS / Geolocation Tagging

### 15.1 Implementation

- Use Android's `FusedLocationProviderClient` (Google Play Services) or `LocationManager`
- Acquire on capture flow start, cache for session
- Store as `{latitude, longitude}` in metadata JSON
- Permission required: `ACCESS_COARSE_LOCATION` or `ACCESS_FINE_LOCATION`
- Graceful degradation: if permission denied or GPS unavailable, metadata omits coordinates

### 15.2 Data Flow

```
Capture Flow opens
  → Request location permission (if not granted)
  → Acquire last known location
  → Store in TreeMetadata
  → Write to metadata JSON alongside tree data
```

---

## 16. Quality Check

`quality-check.js` (172 lines) provides annotation quality validation. Preserve as
`domain.quality.QualityChecker`:

- Check for unassigned bboxes
- Check bbox count consistency
- Check for very small or very large bboxes (outliers)
- Check for duplicate annotations (overlapping same-class boxes)
- Report warnings/errors to UI

---

## 17. Theming & Design Tokens

### 17.1 Token System — the REAL palette is oil-palm GREEN, not slate

The actual `:root` tokens in `css/style.css` are a dark green palette (NOT the
slate/blue an earlier draft listed). The dark theme is the default; light mode is a
pure token re-definition in `css/theme-light.css` under
`@media (prefers-color-scheme: light)` (loaded last). Exact dark values:

```
--c-bg:            #0c120c    --c-text:        #f0f5f0
--c-surface:       #141e14    --c-text-muted:  #a3c4a3
--c-surface-raised:#1c2c1c    --c-text-dim:    #6a946a
--c-border:        rgba(255,255,255,.08)   --c-border-hover: rgba(255,255,255,.18)
--c-accent:        #b8e04a    (lime/chartreuse)  --c-on-accent: #0c120c (dark text on accent)
--c-accent-dim:    rgba(184,224,74,.15)
--c-gold:   #e4b84a   --c-emerald: #2dd47b   --c-red: #f06060   --c-warn: #e4b84a
--c-overlay:       rgba(8,14,8,.92)   --c-glass:  rgba(7,12,7,.72)
--c-glass-strong:  rgba(7,12,7,.92)   --c-glass-soft: rgba(7,12,7,.5)
--c-scrim:         rgba(0,0,0,.55)
--c-on-media:      rgba(255,255,255,.9)   --c-on-media-border: rgba(255,255,255,.35)
```

The Kotlin rewrite should mirror these as a Material 3 `ColorScheme` (`background =
0xFF0C120C`, `surface = 0xFF141E14`, `surfaceVariant = 0xFF1C2C1C`, `onBackground =
onSurface = 0xFFF0F5F0`, `onSurfaceVariant = 0xFFA3C4A3`, `primary = 0xFFB8E04A`,
`onPrimary = 0xFF0C120C`, `error = 0xFFF06060`) plus a parallel light scheme from
`theme-light.css`. Note `--c-accent` is a bright lime with **dark** on-accent text —
buttons are lime with near-black labels, not white-on-emerald.

### 17.2 On-Media Controls (do NOT flip in light mode)

The `--c-glass*`, `--c-scrim`, `--c-on-media`, `--c-on-media-border` family stays
light-on-dark in **both** themes (controls layered over the black camera/photo
surface). In Compose, model these as a separate non-theme-flipping object:
`text = White.copy(.9f)`, `border = White.copy(.35f)`, `scrim = Black.copy(.55f)`.
Using the regular `onSurface` there is a bug (it flips dark in light mode and
vanishes over the camera). Guard test: `ui-shell.test.mjs` "over-media capture controls".

### 17.3 Three intentionally-literal colour groups (do NOT tokenize)

1. **Annotation class palette** (must equal `CLASS_COLORS` in `yolo-io.js` and
   `CanvasRenderer.getClassColor`): B1 `#3b82f6` (blue) · B2 `#ef4444` (red) ·
   B3 `#f59e0b` (amber) · B4 `#8b5cf6` (purple) · **U `#9ca3af` (grey, unassigned)**.
   `canvas.js` also defines B0 `#22c55e`, B5 `#06b6d4`, B6 `#ec4899` for forward
   compatibility, and a deterministic hash-to-palette fallback for unknown classes.
2. **Media backdrops** — `#000` behind photos/camera/canvas, `rgba(0,0,0,…)` scrims.
3. **On-colour text** — `#fff` on saturated class/danger buttons and the shutter.

### 17.4 Status colours (route through tokens)

| Token | Value | Usage |
|---|---|---|
| `--c-emerald` | `#2dd47b` | success / confirmed |
| `--c-red` | `#f06060` | error / danger |
| `--c-warn` | `#e4b84a` | warning / **unassigned count** |
| `--c-gold` | `#e4b84a` | highlight (group stat card) |

---

## 18. Performance Requirements

### 18.1 Targets

| Metric | Target | Notes |
|---|---|---|
| Cold start | <2 seconds | From launch to interactive home screen |
| Warm start | <500ms | Resume from background |
| Image capture → display | <500ms | Save JPEG + show preview |
| Detection inference | <500ms per image | Native onnxruntime vs ~3s WASM |
| Canvas render (100 bboxes) | <16ms/frame | 60fps during pan/zoom |
| Session load (12-tree) | <1 second | Room DB + image thumbnails |
| Export (Output JSON) | <500ms per tree | Filesystem write |
| APK size | <60 MB | arm64-v8a only, R8 enabled |
| Memory (idle) | <150 MB | No WebView overhead |
| Memory (detection) | <300 MB | Peak during ONNX inference |

### 18.2 Key Optimizations

1. **No WebView overhead** — eliminates the entire Capacitor/WebView bridge layer
2. **Native Canvas** — direct `android.graphics.Canvas` or Compose `Canvas` (no DOM)
3. **Room DB** — indexed queries vs. full JSON serialization
4. **Coil** — image loading with memory/disk cache, downsampling
5. **onnxruntime-android** — native inference, GPU delegate, NNAPI
6. **R8** — can now safely enable (no Orbbec JNI/reflection issues with proper keep rules)
7. **Coroutines** — structured concurrency, no callback hell
8. **Lazy loading** — model loaded only when detection requested

### 18.3 Memory Management

- Bitmap recycling after display
- Coil memory cache with size limit
- Room DB cursor management
- ONNX session lifecycle (create once, reuse)
- Orbbec frame buffer: process and release immediately

---

## 19. Testing Strategy

### 19.1 Unit Tests

| Module | Test Focus |
|---|---|
| `YoloParser` | Parse/serialize round-trip, edge cases (empty, malformed) |
| `ActiveSession` | Bbox CRUD, cluster computation, class propagation |
| `SuggestionEngine` | Geometry overlap, IoU calculation |
| `UnionFind` | Find, union, clusters, path compression |
| `ResultsComputer` | Counting, unique bunch calculation |
| `OutputSchemaGenerator` | JSON v4 generation, round-trip fidelity |
| `QualityChecker` | Validation rules |
| `SessionPersistence` | Save/load round-trip |

### 19.2 Integration Tests

| Area | Test Focus |
|---|---|
| Storage | Filesystem read/write, SAF mirror, delete cascade |
| Room DB | CRUD, cascade delete, migration |
| CameraX | Capture, preview (requires device/emulator) |
| ONNX Detection | Model load, inference, post-processing |
| Orbbec SDK | Open/close, capture, preview (requires hardware) |

### 19.3 UI Tests (Compose)

| Screen | Test Focus |
|---|---|
| Home | Session list rendering, create session |
| Capture Flow | Metadata form, GPS acquisition |
| Annotation | Canvas rendering, bbox interaction, class assignment |
| Dedup | Link/unlink, suggestion display |
| Results | Count display, export triggers |
| Responsive | Tablet landscape / phone portrait layout |

### 19.4 Guard Tests (Port from Current)

Current `test/*.mjs` guard tests that must have Kotlin equivalents:

| Current Test | Kotlin Equivalent |
|---|---|
| `ui-shell.test.mjs` | Compose UI test for responsive layout |
| `android-config.test.mjs` | Gradle config test (minSdk, targetSdk, permissions) |
| YOLO parse/serialize | `YoloParserTest.kt` |
| Output schema | `OutputSchemaTest.kt` |
| Union-Find | `UnionFindTest.kt` |
| Dedup suggestions | `SuggestionEngineTest.kt` |
| Results computation | `ResultsComputerTest.kt` |

---

## 20. Build & Toolchain

### 20.1 Project Structure

```
PalmAnnotate-Kotlin/
├── app/
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/dev/sawitulm/palmannotate/
│   │   │   │   ├── PalmAnnotateApp.kt          (Application class)
│   │   │   │   ├── MainActivity.kt
│   │   │   │   ├── di/                          (Hilt modules)
│   │   │   │   ├── domain/
│   │   │   │   │   ├── model/                   (ActiveSession, Bbox, etc.)
│   │   │   │   │   ├── usecase/
│   │   │   │   │   ├── dedup/
│   │   │   │   │   ├── results/
│   │   │   │   │   └── quality/
│   │   │   │   ├── data/
│   │   │   │   │   ├── storage/
│   │   │   │   │   ├── camera/
│   │   │   │   │   ├── detection/
│   │   │   │   │   ├── export/
│   │   │   │   │   ├── dataset/
│   │   │   │   │   ├── yolo/
│   │   │   │   │   └── db/                      (Room entities, DAOs)
│   │   │   │   └── ui/
│   │   │   │       ├── home/
│   │   │   │       ├── session/
│   │   │   │       ├── capture/
│   │   │   │       ├── annotation/
│   │   │   │       ├── dedup/
│   │   │   │       ├── results/
│   │   │   │       ├── carousel/
│   │   │   │       ├── viewer/
│   │   │   │       ├── settings/
│   │   │   │       └── common/
│   │   │   ├── res/
│   │   │   └── assets/
│   │   │       └── models/
│   │   │           ├── ffb-detector.onnx
│   │   │           └── detector.config.json
│   │   └── test/           (unit tests)
│   │       └── androidTest/ (instrumented tests)
│   ├── libs/
│   │   └── obsensor_v2.0.6_2026031801_release.aar
│   ├── build.gradle.kts
│   └── proguard-rules.pro
├── build.gradle.kts         (root)
├── settings.gradle.kts
├── gradle/
│   └── libs.versions.toml   (version catalog)
└── gradle.properties
```

### 20.2 Gradle Configuration

> The current Capacitor app builds at **compile/target 34** (§2.1). The block below
> is the **rewrite's recommended forward config** — a deliberate bump to 35 for the
> fresh project. Keep `minSdk 24`, `arm64-v8a`-only, and the `dev.sawitulm.palmannotate`
> app id so existing on-device data keeps loading; `versionCode`/`versionName` must be
> ≥ the installed build (current `2.0` / code `1`).

```kotlin
// app/build.gradle.kts
android {
    namespace = "dev.sawitulm.palmannotate"
    compileSdk = 35  // current Capacitor app is 34; rewrite may move forward to 35

    defaultConfig {
        applicationId = "dev.sawitulm.palmannotate"
        minSdk = 24
        targetSdk = 35  // current app: 34
        versionCode = 3
        versionName = "3.0.0"

        ndk {
            abiFilters += listOf("arm64-v8a") // no armeabi-v7a
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(...)
        }
        debug {
            isMinifyEnabled = false // match current behavior
        }
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // Compose
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.8.5")

    // CameraX
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    // Room
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // ONNX Runtime
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")

    // Coil (image loading)
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Hilt
    implementation("com.google.dagger:hilt-android:2.53.1")
    ksp("com.google.dagger:hilt-compiler:2.53.1")

    // Orbbec SDK (vendored AAR)
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.aar"))))
}
```

### 20.3 ProGuard Rules (for Orbbec)

```proguard
# Keep Orbbec SDK classes (reflection, JNI)
-keep class com.orbbec.** { *; }
-keepclassmembers class com.orbbec.** { *; }
-dontwarn com.orbbec.**

# Keep ONNX Runtime
-keep class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**
```

### 20.4 Build Commands

```bash
# Debug build
./gradlew assembleDebug

# Release build (with signing)
./gradlew assembleRelease

# Unit tests
./gradlew test

# Instrumented tests
./gradlew connectedAndroidTest

# Install to device
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 21. Migration & Compatibility

### 21.1 Data Migration

The native app must be able to read data created by the Capacitor version:

| Data | Migration Strategy |
|---|---|
| `sessions.json` | Direct JSON parse (same format) |
| Output JSON v4 | Direct JSON parse (same schema) |
| YOLO .txt labels | Direct text parse (same format) |
| Image files | Same paths in app-external storage |
| Depth sidecars | Same paths, same format |
| Metadata JSON | Same schema |
| SAF tree URI | Same format, re-verify grant |

### 21.2 Package Identity

Keep `dev.sawitulm.palmannotate` as the application ID so:
- App-external storage paths remain valid
- SAF URI grants remain valid
- Users see it as an update, not a new app

### 21.3 Feature Parity Checklist

> High-level rollup. The **granular, behavior-level** checklist (every flow, gesture,
> edge case, file, and message) lives in **§27 — Complete Feature & Behavior Checklist**.
> Use §27 for sign-off; this table is the at-a-glance dashboard.

| Feature | Status | Notes |
|---|---|---|
| Session CRUD | ☐ | |
| Tree capture (built-in camera) | ☐ | CameraX |
| Tree capture (Orbbec) | ☐ | Native Orbbec integration |
| Metadata form + GPS | ☐ | |
| Bbox annotation (draw/move/resize/delete) | ☐ | |
| Class assignment (B1–B4 + UNASSIGNED) | ☐ | |
| ONNX detection | ☐ | onnxruntime-android |
| Dedup suggestions | ☐ | |
| Manual cross-side linking | ☐ | |
| Union-Find clustering | ☐ | |
| Class propagation | ☐ | |
| Results & counting | ☐ | |
| Export: YOLO .txt | ☐ | |
| Export: Output JSON v4 | ☐ | |
| Export: CSV | ☐ | |
| Export: Identity JSON | ☐ | |
| SAF mirror | ☐ | |
| Session autosave | ☐ | |
| Session restore from sessions.json | ☐ | |
| Delete tree/session (full cleanup) | ☐ | |
| Carousel annotation | ☐ | |
| Depth viewer | ☐ | |
| Quality check | ☐ | |
| Light/dark theme | ☐ | |
| Portrait phone layout | ☐ | |
| Tablet landscape layout | ☐ | |
| Annot-log sidecar | ☐ | |
| Orbbec flapping guard | ☐ | |
| Orbbec depth sidecar save | ☐ | |
| Portable session index (SAF) | ☐ | |

### 21.4 What to Drop (Not Needed in Native)

| Item | Reason |
|---|---|
| `fsa-adapter.js` | Web File System Access API — web-only |
| `cordova.js`, `cordova_plugins.js` | Capacitor bridge — eliminated |
| `onnxruntime-web` WASM | Replaced by native onnxruntime-android |
| WebView bridge code | No WebView in native |
| CSS files | Replaced by Compose theming |
| `scripts/build-www.mjs` | No web asset pipeline needed |

### 21.5 What to Keep (Extract from Capacitor)

| Current Code | Destination |
|---|---|
| `OrbbecPlugin.kt` (1691 lines) | `data.camera.OrbbecNativeManager` — strip Capacitor `Plugin` wrapper, keep all USB/SDK/preview/capture/flapping logic |
| `SafPlugin.kt` (272 lines) | `data.storage.SafWriter` — strip Capacitor wrapper, keep DocumentFile I/O |
| `MainActivity.java` | Replace with Kotlin `MainActivity` using Compose |
| `AndroidManifest.xml` | Merge permissions/intent-filters into new manifest |
| `res/xml/orbbec_usb_filter.xml` | Keep as-is |
| `models/ffb-detector.onnx` | Move to `assets/models/` |
| `models/detector.config.json` | Move to `assets/models/` |

---

## 22. Screen-by-Screen UI Inventory (1-on-1)

This section catalogs **every screen, every interactive element, and every visible
state** so the Kotlin UI can be rebuilt 1-on-1. Element ids are the current DOM ids;
keep the same logical grouping and copy. The web app is a single `index.html` with
the load order at the bottom of that file (`yolo-io → storage → canvas → dedup-utils
→ session → dataset → bbox-editor → dedup-ui → results → project → output-schema →
quality-check → fs-output → session-store → capture-source → orbbec-source →
capture-flow → detector → carousel-ui → depth-viewer → sessions → app`).

### 22.0 Global chrome & body state classes

- **`.header`** (id `header`): logo + "PalmAnnotate / Oil Palm - Offline" wordmark,
  and the **dataset toolbar** (`#dataset-toolbar`): Home button (`#btn-home`), Load
  Folder (`#btn-load-folder`), Load Session (`#btn-load-session`), **Capture**
  (`#btn-capture-tree`), and the hidden **tree-nav** (`#tree-nav`).
  - The header is **hidden on `body.is-home`** (home/start/session-detail carry
    their own header) — otherwise it would be an orphaned lone logo.
- **`#tree-nav`** (shown only in the editor): prev (`#btn-prev-tree`), tree `<select>`
  (`#tree-select`, options prefixed `✓ ` when saved), split label (`#tree-split`),
  sides label (`#tree-sides`, "N views"), save status (`#tree-save-status` →
  "Complete"/"Not confirmed"/busy label), next (`#btn-next-tree`), counter
  (`#tree-counter`, "i / N"), and saved counter (`#save-counter`, "k/N complete").
- Two hidden file inputs: `#input-folder` (`webkitdirectory`, web-only) and
  `#input-session` (`.json`).
- **Body state classes** (the Compose equivalent is screen/route state):
  `is-home` (home shell), `crsl-shell` (touch single-screen annotate; hides desktop
  tabs + tree-nav), `crsl-show-tabs` (the carousel "More → Editor tools" reveals the
  classic tabs), `crsl-tab-{carousel|annotation|dedup|results}` (active tab mirror).
- **Safe-area:** `MainActivity` injects `--sat/--sab/--sal/--sar` (real system-bar
  insets in CSS px) onto `documentElement`; CSS folds them into `--pa-safe-*`. The
  rewrite gets this for free from Compose `WindowInsets`.

### 22.1 Sessions Home (`SessionsUI._renderHome`, view = `home`)

Default landing view on boot. Scroll container `home__scroll`:
1. **Hero**: "PalmAnnotate" + subtitle "Fresh fruit bunch documentation — work
   session by session".
2. **Stat cards** (`home__stats`): `Total Trees` (= sum of trees across sessions)
   and `Total Groups` (gold tone; distinct variety·block identities).
   `SessionStore.homeStats()` supplies `{ totalPohon, totalGroups, totalSessions }`.
3. **Primary button** "New Session" (`home__primary`, plus icon) → gates on
   `_ensureExportFolder()` (native), then Start-Session view.
4. **Recent Sessions** list: empty state "No sessions yet…", else `session-list` of
   rows. Each row: title `variety · blok`, meta `"N trees · <date>"` (date format
   `"3 Jun 13:10"`), tap → Session Detail; trash icon → themed confirm → delete
   session (removes index entry + ALL trees' on-disk artefacts + SAF mirror).
5. **Secondary**: "Load Folder" + "Load JSON" link buttons.
6. **Export folder row** (native + SAF supported only): "Export folder: <name|Not set>"
   → opens SAF picker, resumes sessions from a `sessions.json` already in the folder.

### 22.2 Start Session (`_renderStart`, view = `start`)

Header with back arrow + "Start Session"; banner "Variety and Block are locked for
every tree in this session." Form card:
- **Tree Variety** free-text `<input list=pa-varieties>` (datalist = remembered
  varieties ∪ `['DAMIMAS']`, autocapitalize characters).
- **Block** free-text `<input list=pa-bloks>` (datalist = remembered blocks).
- **Photos per Tree** segmented control, fixed choice **4 or 8** (`SIDE_CHOICES`).
- **Auto ID Mode** toggle (default ON): tree id auto-increments 0001, 0002, …
- CTA "Start Documentation" (camera icon): validates variety + block non-empty
  (toasts "Enter the tree variety/block first"), calls
  `SessionStore.createSession({variety, blok, sideCount, autoId})`, opens Session
  Detail.

### 22.3 Session Detail (`_renderDetail`, view = `detail`)

Header: back + "Session" + refresh icon. Then:
- **Lock badge** 🔒 `variety · blok` "Locked for this session".
- **Three stats** (`home__stats--three`): Trees, Photos (emerald; = Σ sideCount),
  Next ID (gold; `_pad4(nextId)` or "—" when not auto-id).
- **Add Tree** CTA (plus): gates on `_ensureExportFolder()`, then `_addPohon()` →
  capture flow → record in session → **open the new tree straight into annotation**
  (carousel) via `openPohon(name, sessionId)`.
- **Trees** list sorted by `treeId`: each row badge `_pad4(treeId)` + name +
  "N sides", tap → `openPohon(name, sessionId)`; trash → confirm → delete tree.
- **Download Session** link → writes `sessions/<groupKey>_<id>.json` (native: app
  storage + SAF mirror; web: blob download).

### 22.4 Capture Flow (`CaptureFlow.start`, full-screen `.capture-overlay`)

Built/torn down in JS, appended to `document.body`. Four phases:

**(a) Metadata** — freeform capture only (session capture SKIPS this and grabs GPS
silently in the background). Form `capture-meta`: Variety `<select>` (`DAMIMAS`,
`Other`→reveals free-text), Operator text, Captured timestamp (read-only ISO-8601),
"Get GPS" (best-effort; shows `lat,lng` or "Unavailable"). Buttons Cancel / Start
Capture.

**(b) Live capture surface** (`_capturePass`, rebuilt per source via `_buildSurface`):
- Degrade banner `capture-live__hint` (hidden until native `orbbecState` arrives).
- Top: "View i / N" progress with `V1..Vn` dots (done/active), subtitle "Same tree,
  next view — not a new tree." Manual-ID sessions add an inline numeric Tree ID field.
- Stage: built-in camera streams into `<video>` (getUserMedia, `previewMode='video'`);
  Orbbec mounts its own RGB + depth-PiP DOM (`previewMode='element'`); otherwise a
  one-shot placeholder "Tap Capture (<source>)" (`previewMode='oneshot'`).
- Controls: **Cancel** (ghost), source switch `<select>` (only when >1 source),
  "Find camera" (native only — re-scan USB), big **Capture** shutter.
- Shutter grabs a frame (`source.grab(video)` / `source.grab()` / `source.capture()`),
  writes `shots[sideIndex]`, advances to next target; **no per-side review popup**.
- Subscribes to `orbbecDeviceChange` (rebuild surface on hotplug) and `orbbecState`
  (show/clear degrade banner).

**(c) Review carousel** (`_reviewAll`, immersive full-bleed): swipe strip of all
shots, per-shot **Retake**, page dots, top "Side x / N", a **Pre-save check**
(`QualityCheck.analyzeCaptureShots`) details panel with metrics (`k/N RGB`, `d depth`,
`GPS set/missing`) and an inline **Get GPS** button if GPS is missing. Bottom bar:
**Cancel** / **Save**. Loops on Retake.

**(d) Saving** — spinner "Saving tree…" while `_persistAndBuild` writes images
(`images/field/{tree}_{n}.jpg`), depth sidecars (`.raw` + `.json` when present),
metadata (`metadata/{tree}.json`), each best-effort SAF-mirrored. Then resolves the
`datasetTree`.

### 22.5 Editor shell & tabs (`#editor-area`)

Tab bar `#tabs` (4 tabs + close "×" `#tabs-close`):
`Annotate` (`carousel`) · `Annotation Editor` (`annotation`, default `active`) ·
`Deduplication` (`dedup`) · `Results` (`results`). On touch devices the first tree
load switches default to **Annotate** (carousel) and enters `crsl-shell`.

**Annotation Editor** (`#panel-annotation`): left sidebar = side pills (`#side-pills`,
rebuilt per tree), class buttons B1–B4 (`.btn-class`, `data-class` 1-based), Delete,
**Detect**, **Boxes** toggle, bbox stats (`#bbox-count` → "N bbox · M unassigned",
warn-coloured when M>0), file info, **Tree QA** card (`#tree-quality-card`, status
badge OK/Check/Fix + metric chips + issues), edit hints. Right = full canvas
(`#editor-canvas`) + placeholder.

**Annotate / Carousel** (`#panel-carousel`, built by `CarouselUI`): topbar with
optional host nav (Home ⌂ / ‹ › browse / tree label / More), Review|Edit segmented
control, selected-bbox readout (`.crsl-sidelabel`, shows "N unassigned"). Stage =
one full-bleed side canvas with edge tap zones + transient hint. Bottom = dots,
thumbnail strip, class bar (B1–B4 chips + Boxes + **Link** + Delete), confirmed-links
list, and host action row (**Detect again** / **Save & exit** / **Next tree**).

**Deduplication** (`#panel-dedup`): pair nav (prev/next + `Side a ↔ Side b`), an
**overflow menu** ("More" → Run Suggestions + Suggestions toggle; inline on
wide/landscape, dropdown on portrait), **Compute & Mark Complete** (`#btn-compute`),
dedup edit toolbar (selected bbox label + B1–B4 + Delete), help "?", a portrait-only
"Rotate to landscape" hint, the two canvases (`#dedup-left-canvas` = sideB,
`#dedup-right-canvas` = sideA), and collapsible Suggestions + Confirmed Links panels.

**Results** (`#panel-results`): Save Output Again (`#btn-save-output`), export buttons
(hidden until computed): Export YOLO / Export Session JSON / Export CSV / Export
Identity JSON; `#results-container` holds the stat cards + By-Class + By-Side tables.

### 22.6 Depth & RAW viewer (`DepthViewer.open`, overlay)

Opened from the carousel "More" menu. Header "Depth & RAW" + tree name + Close; side
tabs `Side 1..N`; stage = colorized heatmap canvas (jet, P2–P98 auto-range, tap to
read mm) + notice; aside = legend (range/median/valid%), depth readout, and the
per-side depth JSON + tree metadata JSON. Sides with no depth show "No depth captured
for this side."

### 22.7 Modals & overlays

- **Project Config** (`#modal-project-config`, web FSA flow): Output JSON folder +
  optional YOLO Label folder pickers, FS-API unsupported warning, "Start Annotation".
  On native both pickers are no-ops (fixed app-external store); on web they call
  `showDirectoryPicker`.
- **Mismatch Resolve** (`#modal-mismatch`): one row per class-inconsistent confirmed
  cluster — "Bunch #i", member list "`<side>: <class>`", and a choice button per
  observed class (pre-seeded to majority vote). Cancel / "Apply & Continue".
- **Themed confirm** (`SessionsUI._confirm`, `.pa-modal`): used for delete confirms
  (window.confirm is suppressed in the WebView). Title/message/confirm/cancel, danger
  styling, backdrop-tap = cancel.
- **Quality gate** (`_confirmQualityBeforeExport`, `.quality-modal`): shown before any
  export when QA status ≠ ok — metrics chips + issues + "Back to fix" / "Continue
  export" (label "Export anyway" when status = error).
- **More menu** (`.more-menu`, carousel): "Depth & RAW viewer" + "Editor tools"
  (toggle classic tabs) + Cancel; backdrop-tap dismisses.
- **Toasts** (`#toast-container`): `info|success|error`, auto-dismiss ~4s.
- **Rotate gate** (`#rotate-gate`): **RETIRED** — markup kept but always hidden; the
  portrait phone layer makes every surface usable in portrait. Do NOT reintroduce a
  rotate lock in the rewrite.

---

## 23. Navigation, View Shell & State Machines

### 23.1 Three top-level views, one container
`app.js` toggles between `#home-view` (SessionsUI), `#empty-state`, and `#editor-area`:
- `_showHome()` → `is-home`, clears `_activeSessionId`, renders SessionsUI home.
- `_showSessionDetail(id)` → `is-home`, renders that session's detail.
- `_enterEditorView()` → hides home + empty-state, shows editor; on touch adds
  `crsl-shell`.
- `_onHomeButton()` (header/carousel Home): returns to the **owning session** when a
  tree was opened from one (`_activeSessionId`), else to the sessions home.

### 23.2 `_activeSessionId` — provenance of the open tree
Set when a tree is opened via `openPohon(name, sessionId)`; **nulled** for Load
Folder / Load Session JSON / freeform capture. It is the single source of truth for
"where Home/Save&Exit returns to."

### 23.3 Android hardware Back chain
`MainActivity` → `window.PalmAnnotateHandleBack()` (return true = consumed, else the
Activity finishes). Priority order: open `.pa-modal` → open `.capture-overlay` (click
its ghost cancel) → project-config modal → mismatch modal → editor (`_onHomeButton`)
→ SessionsUI.handleBack (detail/start → home). This dismissal hierarchy must be
reproduced (Compose `BackHandler` stack / nav back-stack).

### 23.4 Tabs, touch default, `crsl-show-tabs`
`_activateTab` toggles `.tab.active`, panel visibility, and `body.crsl-tab-*`. Dedup
init / editor re-init / carousel rebuild happen on activate. The carousel "More →
Editor tools" sets `crsl-show-tabs` (reveals classic tabs over the carousel);
`#tabs-close` "×" removes it and drops back to the carousel so the operator is never
stranded.

### 23.5 Operation queue + busy gate (CRITICAL to port)
- `_enqueueOperation(fn)` serializes async work on a single promise chain
  (`_opQueue = _opQueue.catch(()=>{}).then(fn)`), so navigation/save/compute/next-tree
  never interleave. Port as a single-threaded `Mutex`/`actor`/serialized coroutine.
- `_setBusy(flag, label)` disables nav/select/compute/save and shows a busy label;
  `_busy` short-circuits re-entrant `_navigateTree`.
- `_loadSeq` is a monotonic token: `_loadCurrentTree` bumps it and bails if the token
  or current tree changed mid-await (prevents a slow image/resume load from clobbering
  a newer selection). The rewrite needs the same stale-load guard (job cancellation).

### 23.6 Save lifecycle — four distinct write paths
1. **Auto-save on navigate** (`_autoSaveCurrentTree`): writes only when dirty OR a
   prior signature exists and changed; requires an output dir (toast if not); forces
   mismatch resolution first (postpones if cancelled); silent; never sets the green
   "Complete" checkmark.
2. **Compute & Mark Complete** (`#btn-compute`): resolve mismatches → compute →
   render results → `_saveCurrentTreeOutput({markConfirmed:true})` → flips the green
   checkmark + saved counter + `✓` in the select.
3. **Save & exit** (carousel): saves WITHOUT forcing mismatch resolution (tired
   operator), then returns to owning session/home.
4. **Manual "Save Output Again"** (`#btn-save-output`): re-saves without recompute.
- All paths route through `_saveCurrentTreeOutput`: compute (if needed) → generate
  Output JSON v4 → `_validateOutputAgainstTree` (tree/side/count integrity; blocks on
  mismatch) → `FsOutput.saveJSON` (filename `{treeName}.json`, overwrites) → SAF
  mirror → write corrected YOLO `.txt` per side (`_saveCorrectedLabels`, counts must
  match assigned boxes) → annot-log sidecar (best-effort) → cache saved-handle for
  lazy resume → update signature + markClean.

### 23.7 Boot & restore (`_bootView`)
`_restoreCapturedTrees()` (native: repopulate DatasetManager from the captured
registry, then `_scanOutputDirectory()` so saved Output JSON resumes instead of raw
photos) → `_restoreSessionsFromDisk()` (if the key/value sessions index is empty but
`PalmAnnotate/sessions.json` survived, import it) → `_showHome()`.

### 23.8 Capture → annotate loop
- **Next tree** (`_nextTreeFlow`): resolve mismatches → save current (markConfirmed,
  allowDirty) → capture next for the session → open it. Cancel at the camera returns
  to the session tree list (NOT the previous tree).
- **Save & exit** (`_saveAndExit`): save (no mismatch force) → owning session/home.
- First capture in a session opens straight into annotation (carousel), not back to
  the list.

---

## 24. Detailed Behavior Specifications (per module)

### 24.1 `yolo-io.js`
- `CLASS_MAP {0:B1,1:B2,2:B3,3:B4}`; `UNASSIGNED` = id `-1` / name `'U'`;
  `VALID_CLASS_IDS = {0,1,2,3}`; `isAssignedClassId(id)` = membership.
- `parseYoloLabel(text,w,h)`: split lines, need ≥5 tokens, reject classId ∉ {0..3}
  and any NaN; convert normalized cx,cy,w,h → pixel x1,y1,x2,y2 **clamped to image**;
  ids `b0,b1,…`. (Unassigned/other-class lines are dropped on parse.)
- `toYoloFormat(bboxes,w,h)`: **filters out** unassigned boxes (YOLO needs class 0–3),
  serializes `classId cx cy w h` to **6 decimals**. Callers diff counts to know how
  many `U` boxes were dropped.

### 24.2 `ActiveSession` (`session.js`)
- Dynamic side count: `_applySideCount(n)` rebuilds `TREE_SIDE_LABELS = ['Side 1'..]`
  and `ADJACENT_PAIRS` — 2 sides → `[[0,1]]` (no wrap); ≥3 → `[[i,(i+1)%n]]` clockwise
  with wraparound. `loadTree` uses `n = max(2, sides.length || 4)`.
- `loadTree`: revokes only `blob:` URLs (never native `convertFileSrc` URLs); loads
  each side image, measures `naturalWidth/Height`, parses any label text into bboxes,
  snapshots `originalBboxes` (detector baseline for the annot-log). Web sets
  `side.imageUrl`; native derives it lazily.
- Bbox CRUD: `addBbox/removeBbox/updateBbox`; removeBbox also strips suggested +
  confirmed links touching that box. Mutations set `dirty`.
- **Cluster + class** (Union-Find over `confirmedLinks`): `getClusterMembers`,
  `setBboxClass(side,id,classId,{propagate=true})` (propagates to whole cluster),
  `propagateClassFromBox` (push a box's current class to its cluster — used after the
  editor mutates a box directly).
- **Mismatch** (`getMismatchedClusters`): clusters with ≥2 members AND >1 distinct
  classId; returns members, observed classIds, and majority-vote `majorityClassId`.
- **Links**: `addManualLink` only between adjacent sides; idempotent; overrides other
  links on the SAME pair touching either endpoint (but not links on other pairs);
  drops stale suggestions on that pair; ids `lnk-<seq>`. `confirmLink` promotes a
  suggestion; `confirmAllAutoForPair` promotes all `auto`-category suggestions on a
  pair; `rejectLink`/`removeConfirmedLink`.
- **Serialize**: `toJSON` (version 1: treeName, split, sides[bboxes], suggested +
  confirmed links). `fromJSON` reloads the tree, restores bboxes + originalBboxes,
  then **sanitizes** confirmed links (orient to adjacent pair, dedupe by endpoint,
  re-derive transitive adjacent links from non-adjacent legacy links when each side
  has a single node) and suggested links (drop ones already confirmed); resets dirty.

### 24.3 `DatasetManager` (`dataset.js`)
- One grouping core `_buildTrees(entries)` for web (`load(FileList)` from
  `webkitdirectory`) and native (`loadFromAdapter()` from `readDatasetEntries()`).
- Expected layout: `images/{split}/{stem}_{N}.{jpg|jpeg|png|webp}`,
  `labels/{split}/{stem}_{N}.txt`, `Output TXT/{split}/{stem}_{N}.txt`,
  `Output JSON/{tree}.json`. `stem = TREE_{N}`, side N ∈ 1..99.
- **Label priority**: `Output TXT/` (rank 2) overrides `labels/` (rank 1) for the same
  stem — annotator corrections win over original predictions. Non-label `.txt`
  (e.g. `data.yaml`) ignored.
- Side count per tree = max observed side number (so 4- and 8-side trees coexist);
  `n = max(2, maxSide)`; missing sides become empty placeholders.
- Split detection: `/train|val|test/` in the path else `unknown`. Junk skipped:
  `__MACOSX/`, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`.
- `addCapturedTree`: **replace by name** (not append) so recreating the same
  variety/block/id can't be shadowed by a stale in-memory ref. `removeByName`,
  `findByName`, `goTo/next/prev`, `imageUrlForSide`/`labelTextForSide` delegate to the
  active adapter.

### 24.4 `suggestPairs` (`dedup-utils.js`) — the exact dedup algorithm
Geometry assumption: clockwise rotation; **sideA's left edge meets sideB's right
edge**. Defaults: `autoMin 0.75`, `candidateMin 0.50`, `seamBandFraction 0.50`,
`vertTol 0.20`, `sizeRatioMin 0.30`, `mutualBest true`.
1. **Seam-band hard gate**: keep A-boxes whose normalized center-x ≤ band; B-boxes
   whose center-x ≥ 1−band.
2. **Size-ratio hard gate**: drop pairs with `min(area)/max(area) < sizeRatioMin`.
3. **Score** = `(0.45·seam + 0.35·vert + 0.20·size) · classMultiplier`, clamped 0..1;
   seam = average of each side's normalized proximity to the seam; vert = vertical
   centroid proximity within `vertTol`; size = `0.6·areaSim + 0.4·aspectSim`;
   classMultiplier = 1.0 same / 0.85 ±1 grade / 0.5 otherwise (a **penalty**, never a
   reward). Drop scores `< candidateMin`.
4. **Mutual-best** selection (A's best is B AND B's best is A), else greedy fallback.
   Category `auto` if score ≥ autoMin, else `candidate`. Emits per-signal breakdown.
- `createUnionFind(ids)`: path-compression find + union-by-rank.

### 24.5 `Results` (`results.js`)
- `compute(session)`: builds Union-Find over all boxes keyed `side:id`, unions
  confirmed links → `clusters`; returns `{uniqueCount (=cluster count), rawCount,
  linkedCount, unassignedCount, classCounts{B1..B4,other}, sideCounts, clusters}`.
  Per-cluster class = **majority vote** of member class names.
- `render`: 3 stat cards (Unique / Total Detections / Linked Duplicates) + By-Class
  and By-Side tables.
- Exports route through `_emit` (native: `adapter.saveExport` → `PalmAnnotate/exports/`
  + SAF mirror; web: blob download — a blob download is a silent no-op in the WebView).
  `exportYolo` (per-side `.txt`), `exportYoloWithMismatch` (mismatch boxes to a
  separate `_mismatch.txt`), `exportJSON` (session JSON + result summary), `exportCSV`
  (one summary row), `exportIdentityJSON` (per-bunch member detections + classMismatch).

### 24.6 `OutputSchema` (`output-schema.js`) — round-trip fidelity
- `generate(session,result,datasetTree)` → version-4 JSON (see §5.3): per-side
  `images.side_N` with both `bbox_yolo` (6-dp) and `bbox_pixel` (rounded); `bunches`
  with majority class + `class_mismatch` + appearances; **`_confirmedLinks`** persisted
  with **box-index-stable ids** (`b<index>`), oriented to adjacent pair + deduped;
  `summary`. Variety prefers `datasetTree.metadata.variety`, falls back to
  `_deriveVarietyFromTreeName` (leading `[A-Za-z]+`).
- `toSessionJSON(outputJson)`: rebuild sides (bbox ids `b<box_index>` so they line up
  with re-parsed labels), restore confirmed links from `_confirmedLinks` if present,
  else derive from `bunches` appearances (all adjacent pairs within a bunch).
  Suggestions are NOT restored.
- **The `_confirmedLinks` round-trip is load-bearing** — it's how re-opening an Output
  JSON restores cross-side links.

### 24.7 `BBoxEditor` (`bbox-editor.js`)
- Pointer-events unify mouse/touch/pen. `touchAction:'none'`. Auto-fit transform +
  pinch-zoom/pan viewport (zoom 1..8) layered on top; double-tap (touch) resets.
- Single-pointer: handle-resize (8 handles, 4dp visual / 22px touch hit) → bbox move →
  draw new (min 4px). New boxes are **UNASSIGNED** (`nb<seq>`). 2-pointer = pinch/pan
  (aborts any in-flight single drag). `onUpdate` syncs the array back; `onClassChange`
  lets the host propagate class to cluster siblings.
- Keys `1..4` set class (0-indexed), `Delete/Backspace` delete, `Esc` deselect.
- `getBoxesVisible/setBoxesVisibleGlobal` (overlay toggle). **Magnifier is DISABLED**
  (`_magEnabled=false`); the loupe code + public toggle stay but default off — do NOT
  re-enable.
- dpr-aware line widths (≥3.5 CSS px) so boxes aren't hairline on 2× tablets.

### 24.8 `DedupUI` (`dedup-ui.js`)
- Two canvases, **left = sideB, right = sideA**, each anchored toward the shared seam
  (`'right'`/`'left'` anchor) so images meet in the middle. Mouse-only (desktop/tablet
  landscape).
- Click-to-link: click a left box (pending) → click a right box → `addManualLink`.
  Re-clicking an already-linked sideA box resurfaces its partner as pending. Drag on
  empty = draw a new UNASSIGNED box (id `db-…`); drawing on left pre-arms it as a link
  partner.
- Highlights: confirmed (numbered badge) + suggested (after confirmed, only when
  visible) + cross-pair indicator (grey dashed "x") for boxes linked in another pair.
- Suggestion panel: "Accept All Auto (k)", per-row Accept/Reject + signal badges
  (seam/vert/size/cls, green ≥0.75 / amber ≥0.5 / red). Links panel: numbered rows with
  class-mismatch "!" + Delete. Horizontal mouse guideline; magnifier disabled.

### 24.9 `CarouselUI` (`carousel/carousel-ui.js`) — primary touch surface
- Two modes: **Review** (swipe between sides, tap-to-select, class bar sets class) and
  **Edit** (mounts a `BBoxEditor` on the current side; editor owns all gestures).
- Swipe: horizontal-dominant (`>1.2×` vertical) past 60px commits prev/next (wrap);
  rubber-bands live; tap (<10px travel) selects/links. Edge tap zones jump prev/next.
- **Link** action: arm with selected box → swipe to adjacent side → tap target →
  `addManualLink`. Linked boxes get a dashed colored ring + numbered badge (tap badge
  = remove link). Class change uses `propagate:true`.
- Bottom: dots (per-side, has-boxes / has-links markers), thumbnail strip, class bar
  (B1–B4 + Boxes + Link + Delete), links list. Host hooks render the Home/browse/More
  topbar and Detect/Save&exit/Next-tree action row. Releases decoded image cache on
  re-init (field scale: 250 trees / 1000 photos must not pin bitmaps).

### 24.10 `CaptureFlow` (`capture/capture-flow.js`)
- Naming: session mode → `_treeNameFor(variety,blok,id)` = `VARIETY_BLOK_0001` (block
  sanitized, id zero-padded 4); freeform → `VARIETY_YYYYMMDD_NNN` (seq from epoch ms).
- GPS `_getPosition`: native Geolocation plugin if present (request perms, high
  accuracy, 15s timeout), else `navigator.geolocation` with a belt-and-braces guard
  timeout; resolves null on any failure/denial/timeout (never blocks capture).
- `_ensureCameraPermission` (native): pre-grant CAMERA via the Camera plugin BEFORE
  getUserMedia so the WebView's `onPermissionRequest` doesn't crash the Activity
  mid-stream (see MainActivity §26.4). Best-effort.
- `_persistAndBuild`: deletes any stale tree of the same name first (adapter + SAF),
  writes images/depth/metadata with a per-capture `cacheBust` token, returns the
  `datasetTree`. On native, a side with no `imageUri` after persist throws (so the UI
  can warn "photos could not be saved").

### 24.11 `CaptureSource` / `OrbbecSource`
- Registry `CaptureSources` (built-in self-registers as default; Orbbec registers but
  is never default). `_availableSources` filters by `isAvailable()`; remembered
  `_selectedSourceId` sticky across captures.
- **BuiltinCameraSource**: native → Camera plugin `getPhoto({resultType:'uri'})`;
  web → getUserMedia overlay → canvas grab (JPEG 0.92), fallback `<input capture>`.
  `supportsLivePreview` = getUserMedia present; `openPreview(video)`/`grab(video)`.
- **OrbbecSource**: native plugin bridge. `isAvailable` = plugin reports a connected
  device AND not suppressed. `mountPreview(stage)` renders RGB main + tappable depth
  PiP from `orbbecFrame` events; `grab()` pulls a full-res frame from the running pump;
  `capture()` opens + grabs one-shot; `refresh()` re-scans USB. Depth sidecar metadata
  (valueScale, unit mm, alignedTo color, display floor/ceiling) carried through.

### 24.12 `Detector` (`detect/detector.js`)
See §10. Lazy-loads ORT by injecting a `<script>` (native: vendored
`vendor/onnxruntime/ort.min.js` offline, `numThreads=1` — no SharedArrayBuffer in the
WebView; web: CDN). `isAvailable`/`load`/`detect`/`detectForSide` are all
non-throwing (return false / `[]`). In the rewrite this maps to **onnxruntime-android**
(native, no `<script>` injection, NNAPI/GPU delegate).

### 24.13 `QualityCheck` (`quality-check.js`)
Levels `ok<info<warn<error`; status = highest level. `analyzeCaptureShots` (pre-save)
and `analyzeTree` (editor QA card + export gate) check: metadata (variety=error,
blok/treeId=warn, timestamp=error, operator=info, GPS missing=warn / low-accuracy
>25 m=warn), missing RGB views (error), missing image size (warn), incomplete RGB/depth
pairs (warn), empty annotations (warn/info), no links when multi-side + multi-box
(warn), class mismatches (error), result-not-computed (info). **Messages are
Indonesian** (e.g. "Metadata variety belum terisi.") — keep them or localize
consistently.

### 24.14 Storage adapters
- `Storage.active()` → `CapacitorAdapter` (native) or `FsaAdapter` (web). Same
  interface (`storage-adapter.js`).
- **CapacitorAdapter** root `Directory.External` → `PalmAnnotate/` (see §6.1). Reasons
  documented: Documents fails under scoped storage on SDK 34. `_safeSegment` sanitizes
  every path segment; image URLs use `convertFileSrc` + `?v=<cacheBust>` to defeat
  WebView caching of reused filenames. `listOutputFiles` matches canonical
  `{tree}.json` and legacy `prefix__{tree}.json`. `deleteDatasetTree` sweeps images
  (field/train/val/test × jpg/jpeg/png), depth (raw/bin/png/json), labels, Output TXT,
  metadata, Output JSON. `readDatasetEntries` walks `dataset/` + `Output TXT/`.
- **SafStore** (`saf-store.js`) + `SafPlugin.kt`: optional public mirror under
  `<chosen>/PalmAnnotate/`. Stateless plugin; tree URI remembered in SessionStore
  settings (`safFolderUri`/`safFolderName`), re-verified each use. All writes
  best-effort/never-throwing.

### 24.15 `SessionStore` (`persist/session-store.js`)
- Backends: native `@capacitor/preferences`, web `localStorage`. Keys namespaced
  `palmannotate.` (`settings`, `capturedRegistry`, `sessions`, `inputCache`,
  `snapshot.<tree>`). All methods async + non-throwing.
- Session = one capture run locked to variety+blok; group = `(variety,blok)` identity
  (`groupKeyFor` normalizes to `[A-Z0-9]`). `createSession`, `addTreeToSession`
  (dedupe by name, slim sides to persistable refs, advance `nextId` past highest id),
  `removeTreeFromSession` (recompute `nextId = maxRemainingId+1`, resets to 1 when
  empty — safe because the caller unlinks the freed id's files), `homeStats`,
  `importSessions` (dedupe by id). Every mutation mirrors to
  `PalmAnnotate/sessions.json` (app-external + SAF) so a folder alone can resume work.
- Input cache: recents (cap 12, CI-deduped) for variety/block autocomplete.
- Snapshots: optional per-tree autosave (`saveSnapshot/loadSnapshot/clearSnapshot`).

### 24.16 `ProjectConfig` (`project.js`)
Per-session save tracking in memory: `savedTrees` (Set → green checkmark + saved
counter), `savedHandles` (Map tree→handle/path-ref for lazy resume). Delegates dir
ops to the active adapter. Resets per dataset load. In the Kotlin rewrite this becomes
a Room-backed `isComplete` flag + a lookup of the Output JSON path.

### 24.17 `DepthViewer` (`viewer/depth-viewer.js`)
Reads raw little-endian uint16 `.raw` bytes back (`readDatasetBinary` or convertFileSrc
fetch), decodes to `Uint16Array`, robust P2–P98 auto-range over display window
[250 mm, 7000 mm] (0 / 65535 / out-of-range excluded), jet colormap, mm readout on tap
(`raw * valueScale`). Pure helpers exported for tests.

---

## 25. Keyboard Shortcuts, Gestures & Message Catalog

### 25.1 Keyboard (desktop/tablet — `app.js` global handler; ignored with Ctrl/Meta/Alt)
| Key | Context | Action |
|---|---|---|
| `[` / `]` | any (dataset loaded) | previous / next tree (auto-saves first) |
| `Q` / `E` | annotation tab | previous / next side |
| `←` / `→` | dedup tab | previous / next pair (blurs focused field first) |
| `R` | dedup tab | run suggestions |
| `S` | dedup tab | toggle suggestion visibility |
| `1`–`4` | annotation (canvas focus) | set selected bbox class (BBoxEditor) |
| `1`–`4` | dedup tab | set selected bbox class (DedupUI) |
| `Delete`/`Backspace` | annotation / dedup | delete selected bbox |
| `Esc` | annotation canvas | deselect |

### 25.2 Touch gestures
- **BBoxEditor / Carousel-Edit**: 1-finger draw/select/move/resize (22px handle hit),
  2-finger pinch-zoom + pan, double-tap reset zoom, long-press menu suppressed.
- **Carousel-Review**: horizontal swipe (>60px, >1.2× vertical) = change side; tap =
  select/link/badge-remove; edge zones = prev/next.
- **Capture review**: horizontal swipe between shots, dot tap = jump.

### 25.3 Message / toast catalog (representative — keep semantics)
Success: "Captured {tree} ({n} views)", "Saved: {file} ({where})", "Saved {k} label
.txt file(s)…", "Detected {n} bunch(es) — review & re-label", "Tree {name} saved",
"Linked", "Export …: {n} file(s) saved to {dir}". Info: "On-device detection
unavailable (drop a model in models/).", "Tap a box first", "Auto-save skipped: choose
an output JSON folder first.", "Link cancelled/removed", "Swipe to an adjacent side,
then tap the matching bunch". Error: "Photos could not be saved to storage…", "Tree
not found in dataset — capture it again", "Select an Export folder first", "Save
blocked: {validation}". The capture pre-save QA + Tree QA strings are **Indonesian**.

---

## 26. Native Plugin Bridge Reference (Orbbec / SAF)

The rewrite removes the Capacitor bridge but must reproduce these capabilities as
native Kotlin services. Method/event contracts (current JS↔Kotlin):

### 26.1 Orbbec (`OrbbecPlugin.kt`, `window.Capacitor.Plugins.Orbbec`)
Methods: `isAvailable()→{available}` · `listDevices()→{devices[{name,vendorId,
productId,deviceName,hasPermission}]}` · `requestPermission()→{granted}` ·
`open()→{opened,alreadyOpen,uid,name,width,height,fps,sourceFormat,depthEnabled,
depthWidth,depthHeight,depthFps,depthFormat}` · `capture()→{base64,width,height,
format:'jpeg',sourceFormat,hasDepth,depthBase64,depthWidth,depthHeight,depthFormat,
depthValueScale,depthEncoding:'uint16le',depthUnit:'mm',depthAlignedTo:'color',
depthDisplayFloorMm,depthDisplayCeilingMm}` · `startPreview()→{streaming}` ·
`stopPreview()→{stopped}` · `close()→{closed}` · `refresh()→{available,count}`.
Events (`addListener`): **`orbbecFrame`** `{rgb,depth(base64 jpeg),width,height,…}`
(throttled: RGB ~12.5 fps/720px Q60, depth ~6.25 fps/288px Q70, jet P2–P98 EMA
auto-range) · **`orbbecDeviceChange`** `{attached,count}` · **`orbbecState`**
`{state:'needsPower'|'unstable'|…, message}`.

Internals to preserve exactly (see §9 + `OrbbecPlugin.kt`): single camera executor;
one pump thread is the SOLE pipeline reader; `capture()` coordinates via a
`CaptureWaiter` handoff so two threads never read at once; vendor id `0x2BC5`;
USB-host enumeration + `PendingIntent` permission; a plain USB hotplug
`BroadcastReceiver` registered at load (cold-plug detection + SDK pre-warm, no
OBContext needed); color profile pick (prefer MJPG, ~1280 wide, high fps) + depth
(prefer Y16, D2C software align, depthScale); color frame format conversions (MJPG
passthrough; RGB/BGR/RGBA/BGRA; YUYV/YUY2/UYVY; NV12→NV21; I420); depth as raw uint16.
**Flapping guard** (degradeLevel 0 full → 1 color-only → 2 suppress): count detaches
in a 20 s window, step down after 2; reset on a 30 s quiet replug / "Find camera" /
a stream held ≥4 s; reopen retries (3, 400 ms settle) for the close→reopen USB race;
detach teardown stops+joins the pump BEFORE releasing SDK objects (never close under a
live reader — Android 16 races it into a crash otherwise).

### 26.2 SAF (`SafPlugin.kt`, `window.Capacitor.Plugins.Saf`)
`pickFolder()→{uri,name}|{cancelled}` (ACTION_OPEN_DOCUMENT_TREE +
takePersistableUriPermission) · `hasFolder({uri})→{has,name}` · `releaseFolder({uri})`
· `writeFile({treeUri,relPath,data,encoding:'base64'|'utf8'})→{ok}` (creates the dir
chain, overwrites same-named) · `readFile({treeUri,relPath})→{ok,data}` ·
`deletePath({treeUri,relPath})→{ok,removed}`. Stateless. In native Kotlin this stays
`DocumentFile`/`ContentResolver` — the SAF model is unchanged regardless of WebView.

### 26.3 Capacitor core plugins (replace natively)
`@capacitor/filesystem` → `java.io`/`DocumentFile`; `@capacitor/camera` → CameraX;
`@capacitor/preferences` → DataStore/Room. Geolocation NOT installed (WebView
`navigator.geolocation`) → `FusedLocationProviderClient`/`LocationManager`.

### 26.4 `MainActivity` responsibilities (port to the new Activity/Application)
- Register Orbbec + SAF before bridge init (→ native services in the rewrite).
- **Edge-to-edge** + inject real system-bar insets as `--sat/--sab/--sal/--sar` (→
  Compose `WindowInsets`).
- **Camera permission workaround**: take over the camera-only `onPermissionRequest`,
  grant directly when held else request ONCE through the Activity and grant from the
  result — never the buggy mid-stream double-grant path (NOT needed once CameraX
  replaces getUserMedia, but the permission timing lesson carries over).
- Hardware Back → `PalmAnnotateHandleBack` chain (→ Compose BackHandler / nav stack).
- USB attach intent-filter + `res/xml/orbbec_usb_filter.xml` (vendor-id 11205).

---

## 27. Complete Feature & Behavior Checklist

Exhaustive parity list. Check each off only after on-device verification (a green unit
test is not "done" for anything device-facing). Grouped by area.

### 27.1 Sessions home & shell
- [ ] Boot lands on Sessions Home; global header hidden on home/detail/start.
- [ ] Total Trees + Total Groups stats from `homeStats()`.
- [ ] Recent Sessions sorted newest-updated first (tie-break by creation `seq`).
- [ ] Session row: `variety · blok`, "N trees · <date>" (e.g. "3 Jun 13:10").
- [ ] Delete session → themed confirm → removes index + ALL trees' files + SAF mirror.
- [ ] Load Folder / Load JSON entry points present.
- [ ] Export-folder row (native+SAF): shows name/Not set, picks folder, resumes
      sessions from folder `sessions.json`.
- [ ] New Session / Add Tree gated by `_ensureExportFolder()` on native.

### 27.2 Session create & detail
- [ ] Start Session: variety + block free-text with remembered datalists; 4/8 sides;
      Auto-ID toggle (default on); validation toasts.
- [ ] `createSession` persists + caches inputs; group key normalization.
- [ ] Detail: lock badge, Trees/Photos/Next-ID stats, tree list sorted by treeId.
- [ ] Add Tree → capture → record → open straight into annotation.
- [ ] Delete tree → confirm → remove from session + on-disk artefacts + SAF; `nextId`
      recomputed (resets to 0001 when last tree deleted).
- [ ] Download Session JSON (native app-storage + SAF; web blob).

### 27.3 Capture flow
- [ ] Freeform metadata form (variety/Other, operator, timestamp, Get GPS).
- [ ] Session capture skips metadata, grabs GPS silently in background.
- [ ] Live surface: built-in `<video>` preview, Orbbec element preview, one-shot
      fallback; per-side advance with NO review popup; progress dots.
- [ ] Source switch (when >1), "Find camera" (native), Cancel, Capture shutter.
- [ ] Manual-ID inline numeric field for non-auto-id sessions.
- [ ] Orbbec degrade banner from `orbbecState`; rebuild on `orbbecDeviceChange`.
- [ ] Review carousel: swipe, per-shot Retake, dots, pre-save QA panel + inline GPS.
- [ ] Save/Cancel; Retake loop preserves other shots.
- [ ] Persist images/depth/metadata; cacheBust token; SAF mirror; stale-tree wipe
      before write; native "photos not saved" guard toast.
- [ ] Camera permission pre-grant (no Activity crash on first capture).
- [ ] Tree naming: `VARIETY_BLOK_0001` (session) / `VARIETY_YYYYMMDD_NNN` (freeform).

### 27.4 Annotation — Editor tab
- [ ] Side pills rebuilt per tree; Q/E + pill tap switch sides.
- [ ] Draw (long/drag empty → new UNASSIGNED box), select, move, resize (8 handles),
      delete; pinch-zoom + pan; double-tap reset; class 1–4; Esc deselect.
- [ ] Class buttons + Delete + Detect + Boxes toggle wired.
- [ ] `#bbox-count` shows "N bbox · M unassigned" (warn when M>0).
- [ ] Class change propagates to confirmed-cluster siblings.
- [ ] Tree QA card (status badge + metric chips + issues).
- [ ] Magnifier stays DISABLED.

### 27.5 Annotation — Carousel (Annotate)
- [ ] Review/Edit modes; swipe between sides (wrap); edge zones; dots + thumbnails.
- [ ] Tap select; class bar sets class (propagate); Delete; Boxes toggle.
- [ ] Link: arm → swipe adjacent → tap target; badge tap removes link; links list.
- [ ] Host action row Detect again / Save & exit / Next tree; topbar Home/browse/More.
- [ ] More menu: Depth & RAW viewer + Editor tools (reveal classic tabs).
- [ ] Default surface on touch devices; image cache released on tree change.

### 27.6 Deduplication tab
- [ ] Left=sideB / Right=sideA, seam-anchored; pair nav + `←/→` + wraparound.
- [ ] Click-left→click-right link; re-click linked sideA resurfaces partner; draw new.
- [ ] Run Suggestions (R / overflow), suggestion rows Accept/Reject + signal badges,
      "Accept All Auto (k)".
- [ ] Confirmed links list with mismatch "!" + Delete.
- [ ] Cross-pair indicator (grey dashed "x").
- [ ] Suggestions visibility toggle (S); collapsible panels.
- [ ] Compute & Mark Complete (mismatch-resolve → compute → save → green check).

### 27.7 Deduplication math & links
- [ ] `suggestPairs` exact constants + seam/size hard gates + mutual-best.
- [ ] Union-Find clustering; majority-vote class per cluster.
- [ ] `addManualLink` adjacency-only, pair-scoped override, suggestion cleanup.
- [ ] Mismatch detection (≥2 members, >1 class) + majority pre-seed.
- [ ] Class propagation across cluster (configurable).

### 27.8 Detection
- [ ] onnxruntime-android, lazy model load, letterbox(114 grey)+NCHW, auto-orient
      output, single-class objectness scoring, class-agnostic NMS, maxBoxes.
- [ ] Reads `detector.config.json` (conf 0.01 / iou 0.30 in-repo) over defaults.
- [ ] Every detected box UNASSIGNED, carries score; non-throwing (`[]` on failure).
- [ ] Auto-detect empty sides after capture; manual Detect appends (never wipes).
- [ ] "Detection unavailable" info toast once when no model.

### 27.9 Results & export
- [ ] Stat cards (Unique/Total/Linked) + By-Class + By-Side tables.
- [ ] Export YOLO (+ separate `_mismatch.txt`), Session JSON, CSV, Identity JSON.
- [ ] Native exports land in `PalmAnnotate/exports/` + SAF; web downloads.
- [ ] Quality gate modal before export when QA ≠ ok.

### 27.10 Output schema & files
- [ ] Output JSON v4 byte-compatible incl. `_confirmedLinks` round-trip.
- [ ] YOLO `.txt`: assigned classes only, 6-dp, line count == assigned boxes.
- [ ] Annot-log sidecar (`annotlog/{split}/{tree}_{n}.json`: suggestions vs final).
- [ ] Filenames canonical `{tree}.json` (re-save overwrites).
- [ ] Output validation blocks mixed-tree / wrong-side / count-mismatch writes.

### 27.11 Save lifecycle & navigation
- [ ] Operation queue serializes nav/save/compute/next-tree.
- [ ] Busy gate disables controls + shows label; `_loadSeq` stale-load guard.
- [ ] Auto-save on navigate (dirty-aware, needs output dir, mismatch-forced, silent).
- [ ] Compute&Mark = green check + saved counter + `✓` in select.
- [ ] Save & exit (no mismatch force) → owning session/home.
- [ ] Manual Save Output Again (no recompute).
- [ ] Android Back dismissal hierarchy (modal→overlay→config→mismatch→editor→detail→home).

### 27.12 Storage & persistence
- [ ] App-external `PalmAnnotate/` layout (images/labels/depth/metadata/annotlog/
      Output JSON/Output TXT/exports/snapshots/sessions.json).
- [ ] SAF mirror best-effort under `<chosen>/PalmAnnotate/`.
- [ ] Portable `sessions.json` (app-external + SAF) restore on empty store.
- [ ] Captured-tree registry repopulates DatasetManager on boot, then output scan.
- [ ] Image cache-bust query on reused filenames (no stale photo).
- [ ] Delete tree/session full cleanup (files + depth + metadata + Output + SAF +
      registry + saved-handle + in-memory refs).
- [ ] Dataset grouping: side count = max side; Output TXT > labels priority; junk skip.

### 27.13 GPS
- [ ] Permission request; high-accuracy with 15 s timeout + guard; null on
      failure/denial (capture never blocks); low-accuracy >25 m flagged in QA.

### 27.14 Orbbec RGB-D (see §9 + §26.1)
- [ ] USB enumeration/permission (vendor 0x2BC5); hotplug receiver + SDK pre-warm.
- [ ] Live RGB + colorized depth PiP preview; full-res capture via pump handoff.
- [ ] Depth sidecar `.raw` (uint16 LE, D2C) + `.json` (valueScale/unit/align/display).
- [ ] Flapping guard ladder (full → color-only → suppress) + reset rules.
- [ ] Reopen-after-close retry; teardown stops pump before SDK release.
- [ ] All color formats handled (MJPG/RGB/BGR/RGBA/BGRA/YUYV/YUY2/UYVY/NV12/I420).
- [ ] Depth viewer (heatmap, mm readout, JSON inspector).

### 27.15 Theming, layout, a11y
- [ ] Oil-palm green token palette (dark) + light token re-definition (system-driven).
- [ ] On-media controls don't flip in light mode.
- [ ] Class palette literal (B1 blue/B2 red/B3 amber/B4 purple/U grey) == canvas == buttons.
- [ ] Portrait phone reflow: editor strip / dedup stacked / results single column /
      carousel primary; overflow menu; ≥48 dp targets; ≥8 dp spacing.
- [ ] Tablet landscape layouts unchanged.
- [ ] No orientation lock; rotate gate retired.
- [ ] Toasts info/success/error ~4 s.

### 27.16 Non-throwing contracts (preserve)
- [ ] Detector, capture sources, storage adapters, SAF, SessionStore, exports all
      degrade gracefully and never throw into callers.

---

## 28. Migration Order & Risk Register

### 28.1 Recommended build order
1. **Pure domain first** (no UI, port + unit-test against the JS test vectors):
   `AnnotationClass`/YOLO parse-serialize, `UnionFind`, `SuggestionEngine`
   (`suggestPairs`), `ActiveSession` cluster/mismatch/link-sanitize, `ResultsComputer`,
   `OutputSchemaGenerator` round-trip, `QualityChecker`. These are deterministic and
   are where a 1-on-1 rewrite is easiest to verify byte-for-byte.
2. **Data layer**: Room schema + repositories, filesystem layout, SAF writer,
   sessions.json portable index, captured registry, delete cascade.
3. **Capture**: CameraX flow + GPS; then Orbbec native service (port `OrbbecPlugin.kt`
   wholesale — strip only the `Plugin` wrapper; keep the pump/flapping/encoding/depth
   logic verbatim).
4. **Detection**: onnxruntime-android with the same pre/post-processing + config.
5. **UI**: home/detail/capture → annotation (editor + carousel) → dedup → results →
   depth viewer; responsive (tablet landscape + phone portrait).

### 28.2 Highest-risk parity items (verify on a physical device)
- **Orbbec live preview + capture + flapping guard** (Pad 8 brownout; Pad 6 stable).
  This is the single most fragile area; the JS↔Kotlin contract in §26.1 must hold.
- **Output JSON v4 + YOLO `.txt` byte-compatibility** (downstream training depends on
  it) — diff outputs against the JS app for the same annotations.
- **`_confirmedLinks` round-trip** on re-open.
- **Save lifecycle / operation-queue ordering** (no interleaving, no stale-load clobber).
- **Storage cache-bust + delete cascade** (no stale photo, no resurrected tree).
- **Scoped storage** (use app-external + SAF; never public Documents on SDK 34).

### 28.3 Things to drop (web-only)
`fsa-adapter.js`, `cordova*.js`, `onnxruntime-web` WASM, the `<script>`-injection ORT
loader, `scripts/build-www.mjs`, CSS files, the WebView/Capacitor bridge, the
`window.PalmAnnotate*` globals, and the getUserMedia camera-permission workaround
(replaced by CameraX). Keep the Output JSON/YOLO/sessions.json/depth formats and the
`dev.sawitulm.palmannotate` app id so existing on-device data keeps loading (§21).

---

## Appendix A: File Size Estimates

| Component | Estimated Size |
|---|---|
| App code (Kotlin, compiled) | ~5–8 MB |
| ONNX model | ~9.8 MB |
| Orbbec SDK AAR (arm64 only) | ~15–20 MB |
| Android runtime + libs | ~10–15 MB |
| **Total APK** | **~40–55 MB** |

## Appendix B: Known Issues to Avoid

| Issue | Cause | Prevention |
|---|---|---|
| R8 breaks Orbbec | Strips JNI/reflection paths | Proper ProGuard keep rules for Orbbec |
| USB PD role switch | Hub charging detaches camera | Guard in Orbbec manager, notify user |
| Scoped storage failures | Writing to Documents on SDK 34 | Use app-external + SAF mirror |
| Stale image cache | Reused filename shows old photo | Cache-bust query param on URI |
| Depth brownout | Pad 8 USB power insufficient | Flapping guard (color-only step-down) |

## Appendix C: Estimated Implementation Effort

| Phase | Scope | Effort |
|---|---|---|
| 1. Foundation | Project setup, DI, Room, navigation, theming | 3–5 days |
| 2. Data Layer | Storage, session, dataset, export | 5–7 days |
| 3. Camera | CameraX capture flow, GPS | 3–4 days |
| 4. Annotation | Canvas, bbox editor, carousel, class assignment | 7–10 days |
| 5. Detection | ONNX runtime integration, pre/post processing | 3–4 days |
| 6. Dedup | Suggestions, linking, Union-Find, clustering UI | 5–7 days |
| 7. Orbbec | Native SDK integration, flapping guard, depth | 5–7 days |
| 8. Results & Export | Counting, Output JSON, YOLO, CSV | 3–4 days |
| 9. Polish | Responsive layouts, theme, quality checks | 3–5 days |
| 10. Testing | Unit, integration, UI, device verification | 5–7 days |
| **Total** | | **~42–60 days** |
