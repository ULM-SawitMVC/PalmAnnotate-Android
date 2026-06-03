# PalmAnnotate

PalmAnnotate is an offline browser app for correcting YOLO oil-palm bunch annotations, linking duplicate detections across adjacent tree views, and exporting one canonical JSON file per tree.

The app is designed for the SawitMVC dataset and writes schema `version: 4` output only.

## Features

- Load a local dataset folder containing `images/` and `labels/`.
- Correct bounding boxes per side: draw, move, resize, delete, and change class.
- Link duplicate bunch detections across adjacent sides.
- Resolve class mismatches before saving confirmed output.
- Export corrected YOLO labels, session backup JSON, CSV summaries, identity JSON, and SawitMVC output JSON.
- Resume from previously saved output JSON files.

## Android app (Capacitor)

The same vanilla-JS app ships as a native Android app via Capacitor 6, for
field annotation directly on a tablet/phone. Native is detected at runtime
(`window.Capacitor.isNativePlatform()`); no separate codebase.

### Field flow

1. **Capture 4 views** of a tree with the built-in camera (one per side).
2. The on-device **YOLO detector** auto **over-detects** bunches across the
   views (proposes generous, all-`B2` boxes — easier to delete a spurious box
   than to draw a missed one). The model runs fully offline via
   onnxruntime-web's `wasm` execution provider.
3. **Annotate** in the swipe carousel: set each bunch's class and **cross-link**
   duplicate detections that appear on adjacent views, so each physical bunch is
   counted once.
4. Move on to the **next tree** and repeat.

### Dev loop

```bash
npm install              # install Capacitor + onnxruntime-web
npm run sync             # build:www (slim vendor) + cap sync into android/
```

Then either open the project in Android Studio:

```bash
npx cap open android     # or: npm run android
```

…or build from the CLI:

```bash
cd android && ./gradlew assembleDebug
# APK -> android/app/build/outputs/apk/debug/app-debug.apk
```

Re-run `npm run sync` whenever the web app (`js/`, `index.html`, `css/`,
`models/`) changes so the native `www/` and the vendored ORT runtime are
refreshed.

### Where data lives on device

On Android the app reads/writes under the shared Documents directory:

```text
Documents/PalmAnnotate/
  dataset/         input images + labels
  Output JSON/     one canonical {TREE_NAME}.json per tree
  Output TXT/      corrected YOLO label files
```

### On-device detector model

Drop your exported single-class YOLO model at `models/ffb-detector.onnx`
(see [models/README.md](models/README.md) for export flags). The next
`npm run sync` copies it into `www/` and the detector picks it up automatically
— no rebuild of native code required.

### Camera sources

The **built-in device camera is the default** capture source. An **Orbbec USB
(RGB-D) camera** source is present as a **scaffolded native plugin**
(`OrbbecPlugin.kt`): USB enumeration/permission are real, but frame capture is
stubbed until the Orbbec SDK `.aar` is wired in. See
[docs/android-build.md](docs/android-build.md).

For the full Android build, signing, and deferred-work guide, see
[docs/android-build.md](docs/android-build.md).

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
