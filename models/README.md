# On-device detector model

PalmAnnotate runs an optional **on-device YOLO detector** inside the WebView via
[onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/). It works on both
targets from a single model path:

- **Web** — the ORT runtime is pulled from a CDN at runtime.
- **Android** — the ORT runtime + wasm are vendored into `www/vendor/onnxruntime`
  by `scripts/build-www.mjs`, so detection runs **fully offline**.

The detector is **detect-only** and tuned to **over-detect**: it proposes boxes
(all defaulted to class `B2`) that the expert then deletes/keeps and re-labels.
It is easier to delete a spurious box than to draw a missed one.

## Swapping in your model

The expert exports a **single-class** detector (one "object" class — the FFB /
fruit bunch). Class is intentionally ignored downstream; the expert assigns the
real class in the editor.

With [Ultralytics](https://docs.ultralytics.com/modes/export/) YOLOv8 / YOLO11:

```bash
yolo export model=best.pt format=onnx imgsz=640 opset=12
```

Then place the exported file here:

```
models/ffb-detector.onnx
```

That filename must match `modelFile` in `detector.config.json` (below). On the
next `npm run build:www` (or `npm run sync`) the `models/` folder is copied into
`www/`, and the detector picks it up automatically.

### Notes on the export

- `imgsz=640` should match `inputSize` in the config (the app letterboxes the
  source image to a square of this size, keeping aspect ratio and padding).
- `opset=12` is broadly compatible with onnxruntime-web 1.19. Newer opsets often
  work too; lower it only if you hit an unsupported-op error in the console.
- The exporter emits an output tensor shaped `[1, 4+nc, N]` or `[1, N, 4+nc]`
  (`nc` = number of classes). The detector auto-detects the orientation, so a
  single-class export (`nc = 1`, i.e. `[1, 5, N]`) works without changes.
- Box coordinates are decoded as `cx, cy, w, h` in input space, then the
  letterbox is undone to recover original image pixel coordinates.

## Gitignore

The `.onnx` weights are large and should **not** be committed. The integrator
adds `models/*.onnx` to `.gitignore`. The **folder, `.gitkeep`, this README, and
`detector.config.json` ARE committed** so the swap-in is a single file drop.

## `detector.config.json` fields

| Field           | Default              | Meaning |
|-----------------|----------------------|---------|
| `modelFile`     | `ffb-detector.onnx`  | Filename under `models/` to load. |
| `inputSize`     | `640`                | Square letterbox size fed to the model; match the export `imgsz`. |
| `confThreshold` | `0.05`               | **Minimum** score to keep a box. **Lower → more boxes (over-detect).** |
| `iouThreshold`  | `0.35`               | Class-agnostic NMS IoU. **Lower → suppresses more overlapping/tumpang-tindih boxes.** |
| `maxBoxes`      | `300`                | Hard cap on returned boxes after NMS. |
| `classAware`    | `false`              | Keep `false` for detect-only. When `true` and the model has >1 class, the per-class max probability is used as the score (still relabeled to `B2`). |

### Tuning over-detection

To propose **more** candidate boxes (recall over precision):

- **Lower** `confThreshold` (e.g. `0.10` or `0.05`) — admits weaker detections.
- **Lower** `iouThreshold` (e.g. `0.35`) — NMS suppresses more overlapping duplicate boxes.

To propose **fewer** boxes overall, raise `confThreshold`. To allow more clustered/overlapping fruit boxes, raise `iouThreshold` slightly.
