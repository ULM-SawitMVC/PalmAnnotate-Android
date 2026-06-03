# PalmAnnotate User Manual

## 1. Open The App

Serve the folder with any static server, then open it in Chrome or Edge:

```bash
python -m http.server 4173
```

## 2. Load A Dataset

On web, click **Load Folder** and choose a dataset root containing `images/` and `labels/`.

On Android, use the Sessions home flow to start/resume a locked variety+block session and capture trees into the app's PalmAnnotate working store. The optional **Export folder** row lets you choose a public folder via Android's SAF picker so captures are mirrored into a browsable location.

PalmAnnotate groups files by tree name and side number. A tree named `DAMIMAS_A21B_0001` should have files such as:

```text
DAMIMAS_A21B_0001_1.jpg
DAMIMAS_A21B_0001_2.jpg
DAMIMAS_A21B_0001_3.jpg
DAMIMAS_A21B_0001_4.jpg
```

## 3. Configure Output

Choose (web):

- **Output JSON Folder**
- optional **YOLO Label Folder (.txt)**

On Android, output JSON/TXT is written under the app-specific PalmAnnotate storage automatically; SAF export is a separate best-effort mirror for user-browsable copies.

PalmAnnotate does not ask for photo date or variety. Variety is derived from the tree name when JSON is generated. Output names stay aligned with the original dataset.

## 4. Correct Annotations

Use the **Annotation Editor** tab:

- drag empty area: create bbox
- click bbox: select
- drag bbox: move
- drag corner or edge: resize
- `1` to `4`: change class
- `Delete`: delete bbox
- `Q` / `E`: previous or next side
- `[` / `]`: previous or next tree

## 5. Link Duplicate Bunches

Open the **Deduplication** tab.

- **Run Suggestions** proposes likely adjacent-side duplicate pairs.
- Click one bbox on the left canvas and one bbox on the right canvas to link manually.
- Use **Accept**, **Reject**, or **Accept All Auto** in the suggestion panel.
- Toggle suggestions with `S`.

Only adjacent sides are compared.

## 6. Resolve Class Mismatches

If linked detections disagree on class, PalmAnnotate opens a mismatch modal before saving. Choose the final class for each bunch, then click **Apply & Continue**.

## 7. Save Output

Click **Compute & Mark Complete** to:

- compute unique bunches
- write schema `version: 4` JSON
- write corrected YOLO labels if a label folder is configured
- mark the tree complete in the navigation dropdown

The canonical output filename is:

```text
{TREE_NAME}.json
```

Corrected YOLO labels keep the original per-side label filename and are written under the same split folder.

When moving between trees, PalmAnnotate auto-saves only if the current tree has unsaved edits. Auto-save requires a writable output JSON folder; it does not fall back to browser downloads.

## 8. Resume Work

To resume a previous tree:

- load the same dataset folder
- select the same output JSON folder
- choose the saved tree from the dropdown

You can also click **Load Session** and select one saved output JSON file.
