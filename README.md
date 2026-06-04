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

1. Start or resume a locked **Session** (variety + block), then add a tree.
2. **Capture 4 views** with the **in-app camera** — a live preview embedded in
   the page (no OS camera screen / page change). The capture button sits on the
   **right** on tablets (landscape) and along the **bottom** on phones
   (portrait). Tap once per side and the surface advances to the next side
   immediately — no per-shot confirmation. After the last side, **one swipe
   review** lets you retake any side, then **Save**.
3. The on-device **YOLO detector** auto **over-detects** bunches across the views
   (generous, all-`B2`, detect-only). It runs fully offline through
   onnxruntime-web's `wasm` execution provider.
4. **Annotate** on the single swipe **carousel** screen: set each bunch's class,
   **delete** false positives, **cross-link** duplicate detections on adjacent
   views, and **re-run detection** when needed. (The Annotation Editor /
   Deduplication / Results tabs stay available behind the **More** button.)
5. Tap **Next tree** to mark the current tree complete and jump straight into
   capturing the next one, or **Save & exit** to store progress and return to the
   session's tree list. Session state, captured registry, and settings persist
   through app restarts.

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
and mirrors captures/saves into the same PalmAnnotate-shaped tree:

```text
<chosen public folder>/PalmAnnotate/
  dataset/images/field/{TREE}_{side}.jpg
  dataset/metadata/{TREE}.json
  Output JSON/{TREE}.json
  Output TXT/field/{TREE}_{side}.txt
```

The SAF export folder is best-effort and additive; the app-storage copy remains
the source of truth. Current Android cleanup semantics are intentionally strong:
**Delete Tree** removes that tree's images, Orbbec depth sidecars, metadata, output JSON, output TXT,
snapshots, registry entries, in-memory tree refs, and SAF mirror copies;
**Delete Session** applies the same cleanup to every tree in the session before
removing the session row. Reusing the same variety/block/tree id is safe because
stale files are deleted and native image URLs are cache-busted.

### On-device detector model

A trained model is **committed** at `models/ffb-detector.onnx` (~38 MB,
Ultralytics YOLO26s, classes B1–B4), so a fresh clone builds a working,
fully-offline detector with no extra downloads. Tuning lives in
`models/detector.config.json` (`confThreshold`, `iouThreshold`, …).

To swap in a different model, **replace that file keeping the name**
`models/ffb-detector.onnx` (or point `modelFile` in `detector.config.json` at a
new filename; see [models/README.md](models/README.md) for export flags). The
next `npm run sync` copies `models/` into `www/` and the detector picks it up
automatically — no native-code rebuild needed unless Android sources changed.

### Camera sources

The **built-in device camera is still the default** capture source, and on
Android it streams **inside the app** via the WebView's `getUserMedia`
(the manifest declares `android.permission.CAMERA`) — there is no jump to the OS
camera activity. If getUserMedia is ever denied/unavailable the flow degrades to
a one-shot file picker (web) or the Capacitor Camera plugin (native), so capture
never breaks.

The native **Orbbec USB (RGB-D) camera** plugin is wired to the Orbbec Android
SDK wrapper AAR (`android/app/libs/obsensor_v2.0.6_2026031801_release.aar`) and
renders an in-app RGB preview with a colorized-depth PiP. The capture flow uses
the same side-to-side surface as the device camera:

- Android USB-host enumeration and runtime USB permission are real.
- `startPreview()` starts an Orbbec `OBContext`/`Pipeline` RGB-D stream and pumps
  throttled preview frames to the WebView.
- `capture()` returns a full-resolution color frame as base64 JPEG plus depth
  sidecar metadata when depth is available.
- `stopPreview()`/`close()` serialize the preview pump before releasing SDK
  objects, so sudden USB detach/PD renegotiation should not crash the app.

When plugged in, Orbbec appears as an optional **Camera** choice during side
capture; the device camera remains the fallback. Orbbec capture annotates the
RGB JPEG but also saves the depth sidecar with the same tree/side stem:
`dataset/images/field/{TREE}_{side}.jpg`,
`dataset/depth/field/{TREE}_{side}.raw`, and
`dataset/depth/field/{TREE}_{side}.json`.

**USB-C charging caveat:** Orbbec needs the Android device to stay in USB
host/data role. Some tablets (verified: Xiaomi Pad 6) switch to
`power_role=sink + data_role=device` when a charger is connected to a USB-C hub's
PD pass-through port; Android then detaches the Orbbec and the Camera dropdown
will remove it until the USB bus is re-enumerated. Use wireless ADB for debugging
and, if charging is required, a hub/tablet combination that supports host data
while sinking power, or power only the hub/Orbbec while the tablet remains host.
For the full Android build, signing, SAF, and Orbbec notes, see
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
