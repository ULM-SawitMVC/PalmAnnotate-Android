# PalmAnnotate

PalmAnnotate is an offline browser app for correcting YOLO oil-palm bunch annotations, linking duplicate detections across adjacent tree views, and exporting one canonical JSON file per tree.

The app is designed for the SawitMVC dataset and writes schema `version: 4` output only.

## Features

- Load a local dataset folder containing `images/` and `labels/` (web) or capture trees in locked Android field sessions.
- Correct bounding boxes per side: draw, move, resize, delete, and change class.
- Link duplicate bunch detections across adjacent sides.
- Resolve class mismatches before saving confirmed output.
- Run optional offline YOLO over-detection when an ONNX model is present.
- Export corrected YOLO labels, session backup JSON, CSV summaries, identity JSON, and SawitMVC output JSON.
- Mirror Android captures to a user-picked public SAF export folder.
- Resume from previously saved output JSON files and persisted Android sessions.

## Android app (Capacitor)

The same vanilla-JS app ships as a native Android app via Capacitor 6 for field
annotation directly on a tablet/phone. Native is detected at runtime
(`window.Capacitor.isNativePlatform()`); there is no separate app codebase.

### Field flow

1. Start or resume a locked **Session** (variety + block), then add one tree at a
   time.
2. **Capture 4 views** of the tree (one per side). The built-in device camera is
   the default capture source.
3. The on-device **YOLO detector** can auto **over-detect** bunches across the
   views (generous, all-`B2` suggestions). The model runs fully offline through
   onnxruntime-web's `wasm` execution provider.
4. **Annotate** in the swipe carousel: set each bunch's class and **cross-link**
   duplicate detections on adjacent views so each physical bunch is counted once.
5. Move on to the **next tree**. Session state, captured registry, and settings
   persist through app restarts.

### Dev loop

```bash
npm install              # install Capacitor + onnxruntime-web
npm test                 # Node test suite
npm run sync             # build:www (slim vendor) + cap sync into android/
```

Then either open the project in Android Studio:

```bash
npx cap open android     # or: npm run android
```

…or build from the CLI (JDK 17 required):

```bash
cd android && ./gradlew assembleDebug
# APK -> android/app/build/outputs/apk/debug/app-debug.apk
```

Re-run `npm run sync` whenever the web app (`js/`, `index.html`, `css/`,
`assets/`, `models/`) changes so the native `www/` and the vendored ORT runtime
are refreshed. Android's `minSdk` is **24** because the Orbbec SDK requires it.

### Where data lives on device

Android keeps the reliable working store in app-specific external storage:

```text
/Android/data/dev.sawitulm.palmannotate/files/PalmAnnotate/
  dataset/         captured/input images + labels + metadata
  Output JSON/     one canonical {TREE_NAME}.json per tree
  Output TXT/      corrected YOLO label files
```

This path is readable by the app/WebView without scoped-storage permission
failures. For operator-browsable copies, use the **Export folder** row on the
Sessions home screen: it opens Android's Storage Access Framework folder picker
and mirrors captures/downloaded session JSON into:

```text
<chosen public folder>/PalmAnnotate/dataset/...
```

The SAF export folder is best-effort and additive; the app-storage copy remains
the source of truth.

### On-device detector model

Drop your exported single-class YOLO model at `models/ffb-detector.onnx` (or set
`modelFile` in `models/detector.config.json` to your filename; see
[models/README.md](models/README.md) for export flags). The next `npm run sync`
copies `models/` into `www/` and the detector picks it up automatically — no
native-code rebuild required unless Android sources changed.

### Camera sources

The **built-in device camera is still the default** capture source. The native
**Orbbec USB (RGB-D) camera** plugin is now wired to the Orbbec Android SDK
wrapper AAR (`android/app/libs/obsensor_v2.0.6_2026031801_release.aar`):

- Android USB-host enumeration and runtime USB permission are real.
- `open()` starts an Orbbec `OBContext`/`Pipeline` color stream.
- `capture()` returns one color frame as base64 JPEG (`{base64,width,height}`).
- `close()` releases the pipeline/device/context.

Runtime Orbbec capture still needs testing on a physical Android device with the
Gemini/Orbbec hardware attached. For the full Android build, signing, SAF, and
Orbbec notes, see [docs/android-build.md](docs/android-build.md).

## Output Schema

New exports use the English SawitMVC schema:

```json
{
  "version": 4,
  "tree_id": "DAMIMAS_A21B_0001",
  "tree_name": "DAMIMAS_A21B_0001",
  "split": "train",
  "metadata": {
    "variety": "DAMIMAS",
    "generated_at": "2026-05-16T00:00:00.000Z"
  },
  "images": {
    "side_1": {
      "filename": "DAMIMAS_A21B_0001_1.jpg",
      "label_file": "DAMIMAS_A21B_0001_1.txt",
      "side_index": 0,
      "side_label": "Side 1",
      "width": 1280,
      "height": 720,
      "bbox_count": 3,
      "annotations": []
    }
  },
  "bunches": [],
  "_confirmedLinks": [],
  "summary": {
    "total_unique_bunches": 0,
    "total_detections": 0,
    "duplicates_linked": 0,
    "by_class": {"B1": 0, "B2": 0, "B3": 0, "B4": 0, "other": 0},
    "by_side": {"side_1": 0}
  }
}
```

Legacy output files can be loaded for convenience, but PalmAnnotate never writes Indonesian keys in new exports.

## Dataset Layout

Expected input:

```text
dataset-root/
  images/{split}/{TREE_NAME}_{N}.jpg
  labels/{split}/{TREE_NAME}_{N}.txt
```

Optional resume/output folders:

```text
dataset-root/Output JSON/{TREE_NAME}.json
dataset-root/Output TXT/{split}/{ORIGINAL_LABEL_FILENAME}.txt
```

`N` is the 1-based side number used by the original dataset filenames. PalmAnnotate preserves original JSON and label filenames when saving corrected output.

## Run Locally

Any static file server works:

```bash
python -m http.server 4173
```

Then open `http://localhost:4173`.

Chrome or Edge is recommended because the File System Access API can write JSON and corrected labels directly to selected folders. Other browsers fall back to downloads.

Auto-save on tree navigation only runs for changed trees and requires a writable output JSON folder. It never silently downloads files.

## Documentation

- [User Manual](docs/manual.md)
- [Architecture](docs/architecture.md)
- [Deduplication Tuning Guide](docs/tuning-guide.md)

## License

MIT. See [LICENSE.txt](LICENSE.txt).
