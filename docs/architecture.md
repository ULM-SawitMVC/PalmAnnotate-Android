# PalmAnnotate Architecture

PalmAnnotate is a static single-page app. It has no backend and no app-logic bundler: the root `index.html`, `js/`, `css/`, `assets/`, and `models/` are copied into `www/` for Android. On-device YOLO inference is optional and runs fully offline when a local ONNX model is present.

## Main Modules

| File | Role |
| --- | --- |
| `index.html` | Three-tab app shell, modals, toolbar, and static controls. |
| `css/style.css` | Visual system and responsive layout. |
| `js/dataset.js` | Local folder parsing, tree grouping, split detection, and label precedence. |
| `js/session.js` | Active tree state, side labels, bbox edits, confirmed links, and mismatch detection. |
| `js/canvas.js` | Single-side bbox editor. |
| `js/dedup-utils.js` | Cross-side scoring and candidate generation. |
| `js/dedup-ui.js` | Two-canvas linking surface and suggestion panels. |
| `js/results.js` | Counting, result rendering, and auxiliary exports. |
| `js/output-schema.js` | SawitMVC schema `version: 4` output and legacy output loading. |
| `js/fs-output.js` | Output facade over web/native storage writes and download fallback. |
| `js/project.js` | Output folders and save tracking. |
| `js/storage/*` | Web File System Access adapter, Android Capacitor Filesystem adapter, and optional native SAF export mirror. |
| `js/capture/*` | Built-in camera capture, session capture flow, and optional Orbbec USB capture source. |
| `js/detect/detector.js` | Optional offline YOLO detector via onnxruntime-web wasm. |

## Flow

1. User clicks **Load Folder** and selects a dataset root.
2. `DatasetManager` groups files into trees by `{TREE_NAME}_{side_number}`.
3. The output modal sets the JSON output folder and optional corrected-label folder.
4. `ActiveSession.loadTree()` loads one tree, side images, and YOLO labels.
5. The annotation editor updates bbox geometry and class labels.
6. The dedup tab proposes and confirms adjacent-side duplicate links.
7. **Compute & Mark Complete** resolves class mismatches, runs clustering, renders results, and saves JSON.

## Canonical JSON

The public output schema is English-only:

- `version: 4`
- `metadata.variety`
- `images.side_N`
- `bunches[].appearances[].side: "side_N"`
- `summary.by_side.side_N`

The following compatibility fields remain unchanged because downstream tools use them as stable IDs:

- `_confirmedLinks`
- `box_index`
- `side_index`
- `sideA`
- `sideB`
- `bboxIdA`
- `bboxIdB`

## Deduplication Model

PalmAnnotate only compares adjacent views:

```text
Side 1 <-> Side 2
Side 2 <-> Side 3
...
Side N <-> Side 1
```

The scoring pipeline uses:

- seam proximity
- vertical centroid similarity
- size and aspect-ratio similarity
- class-distance multiplier
- mutual best-pair selection

Opposite sides are not scored because the perspective difference is too large for reliable bbox matching.

## Persistence

Project configuration is in memory on the web; Android session/settings state is persisted through `SessionStore` (Capacitor Preferences). Saved status comes from output scans plus the current session registry.

If the browser supports the File System Access API, output JSON and corrected labels are written directly to selected folders. On Android, the working store is app-specific external storage under `/Android/data/dev.sawitulm.palmannotate/files/PalmAnnotate`; the optional SAF export folder mirrors captures, metadata, Output JSON, and Output TXT into a user-picked public folder. Manual JSON save can fall back to downloads on web; auto-save requires a writable output JSON target and never downloads silently.

Android deletion is intentionally full-lifecycle: Delete Tree removes app-storage images, Orbbec depth sidecars, metadata, output JSON/TXT, autosave snapshot, captured registry entry, saved handle, in-memory tree entry, and SAF mirror files. Delete Session repeats that cleanup for every tree. Capture also pre-cleans stale artefacts before reusing the same tree id and appends cache-busting tokens to native image URLs to avoid stale WebView file-cache renders.

Navigation, loading, compute, and save operations run through a single queue. Saves use an immutable session snapshot and validate tree names, image filenames, label filenames, and per-side annotation counts before writing.

Saved output filenames are dataset-driven:

- JSON: `{TREE_NAME}.json`
- labels: original per-side label filename, under the same split folder

## Known Limits

- YOLO inference is optional; if `models/<modelFile>` is absent, detection is disabled without throwing.
- No visual embeddings, tracking, or image hashing are used for deduplication.
- One bbox can be linked to only one counterpart per adjacent side pair.
- Folder handles must be selected again after a browser refresh.
