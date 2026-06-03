# Android build guide

PalmAnnotate ships as a native Android app via **Capacitor 6**, wrapping the same
vanilla-JS web app in a WebView. This guide covers prerequisites, debug and
release builds, signing, APK size, and the deferred field-hardening work.

For the high-level field flow and dev loop, see the
[README "Android app (Capacitor)" section](../README.md#android-app-capacitor).

## Prerequisites

- **Node.js** 18+ (LTS) and npm — runs `scripts/build-www.mjs` and the Capacitor CLI.
- **Android Studio** (Hedgehog or newer) with the Android SDK + platform-tools.
  Easiest way to get a matching SDK, build-tools, and an emulator/device bridge.
- **JDK 17** — the Capacitor 6 Android Gradle plugin and this project's
  `kotlinOptions.jvmTarget = "17"` require JDK 17. Android Studio bundles a
  compatible JBR; for CLI builds set `JAVA_HOME` to a JDK 17 install.

One-time setup:

```bash
npm install        # installs @capacitor/* + onnxruntime-web
npm run sync       # build:www (slim ORT vendor) + cap sync -> android/
```

`npm run sync` runs `scripts/build-www.mjs` (assembles `www/` and vendors the
slim onnxruntime-web wasm runtime) and then `cap sync` (copies `www/` into
`android/app/src/main/assets/public` and updates native plugins). **Re-run it
after any change to `js/`, `index.html`, `css/`, or `models/`.**

## Build a debug APK

In Android Studio: open the `android/` folder, let Gradle sync, then **Run** on a
connected device/emulator, or **Build > Build APK(s)**.

From the CLI:

```bash
cd android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

The debug build is signed with the auto-generated Android debug key — fine for
sideloading onto a test tablet, not for distribution.

## Build a release APK / AAB

A release build is **unsigned by default** in this project (the signing config is
a commented template — see below). Once signing is enabled:

```bash
cd android
./gradlew assembleRelease        # APK -> app/build/outputs/apk/release/
./gradlew bundleRelease          # AAB -> app/build/outputs/bundle/release/ (Play)
```

## Generate a keystore and enable signing

`android/app/build.gradle` contains a **commented** `signingConfigs { release { … } }`
template plus a commented `signingConfig signingConfigs.release` line inside
`buildTypes.release`. The template reads credentials from environment variables so
**no secrets are committed**.

### 1. Generate a keystore

Use the JDK's `keytool` (RSA 2048, 10000-day validity). Keep the keystore file
**out of git** and back it up securely — losing it means you can't ship updates
under the same signature.

```bash
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias palmannotate \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

`keytool` prompts for the store password, a distinguished name, and (optionally)
a separate key password.

### 2. Set the environment variables

The template expects these (names match the comments in `build.gradle`):

| Variable           | Meaning                                               |
|--------------------|-------------------------------------------------------|
| `PA_KEYSTORE`      | Absolute path to the `.keystore`/`.jks`. Defaults to `android/app/release.keystore` when unset. |
| `PA_KEYSTORE_PASS` | Keystore (store) password.                            |
| `PA_KEY_ALIAS`     | Key alias (e.g. `palmannotate`).                      |
| `PA_KEY_PASS`      | Key password (often the same as the store password).  |

macOS / Linux:

```bash
export PA_KEYSTORE="$PWD/android/app/release.keystore"
export PA_KEYSTORE_PASS="********"
export PA_KEY_ALIAS="palmannotate"
export PA_KEY_PASS="********"
```

Windows PowerShell:

```powershell
$env:PA_KEYSTORE      = "$PWD\android\app\release.keystore"
$env:PA_KEYSTORE_PASS = "********"
$env:PA_KEY_ALIAS     = "palmannotate"
$env:PA_KEY_PASS      = "********"
```

### 3. Uncomment the signing config

In `android/app/build.gradle`, uncomment:

1. the entire `signingConfigs { release { … } }` block (above `buildTypes`), and
2. the `signingConfig signingConfigs.release` line inside `buildTypes.release`.

Then `./gradlew assembleRelease` produces a signed APK. Verify with:

```bash
$ANDROID_HOME/build-tools/<version>/apksigner verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

## APK size note (onnxruntime wasm)

The on-device detector uses onnxruntime-web's **`wasm` execution provider only**
(`executionProviders: ['wasm']` in `js/detect/detector.js`). The upstream
`onnxruntime-web/dist` is ~70MB because it ships many runtime variants
(jsep / jspi / asyncify / training) the app never loads.

`scripts/build-www.mjs` therefore **vendors a slim subset** into
`www/vendor/onnxruntime` — only:

- `ort.min.js`
- `ort-wasm-simd-threaded.wasm`
- `ort-wasm-simd-threaded.mjs`

This trims roughly **~50MB** from the APK while keeping detection fully offline.
If you change the detector's execution provider (e.g. add WebGPU/JSEP), update
`ORT_WASM_EP_FILES` in `scripts/build-www.mjs` to vendor the matching files.

## Deferred work (concrete approaches)

These are intentionally **not yet implemented**. Each entry below is enough to
start the work without re-deriving the design.

### (a) SAF folder picker for dataset / output location

Today the Android paths are fixed under `Documents/PalmAnnotate/{dataset,Output
JSON,Output TXT}`. Operators should instead **pick** the dataset/output folder
(e.g. an SD card or USB-OTG drive) via the **Storage Access Framework (SAF)**.

Two viable approaches:

- **Capacitor community plugin** — add
  [`@capawesome/capacitor-file-picker`](https://capawesome.io/plugins/file-picker/)
  and call `pickDirectory()` to get a `content://` tree URI. Persist read/write
  permission across reboots with `takePersistableUriPermission`, store the URI
  string in `@capacitor/preferences`, and route reads/writes through
  `@capacitor/filesystem` (or the picker's file APIs) against that tree.
- **Small native SAF intent** — add a `@PluginMethod` to a native plugin that
  fires `Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)` via
  `startActivityForResult`, takes the persistable permission on the returned
  `content://` URI, and resolves the URI to JS. Resolve subfolders/files with
  `DocumentFile.fromTreeUri(...)`.

In both cases, store the chosen tree URI in Preferences and fall back to the
current fixed Documents path when none is selected, so behavior is unchanged
until an operator opts in.

### (b) Orbbec SDK `.aar` integration

`OrbbecPlugin.kt` is a working scaffold: USB device enumeration, vendor-id
filtering (`ORBBEC_VENDOR_ID = 0x2BC5`), and runtime USB permission are real;
`open()`, `capture()`, and `startPreview()` are stubs that reject with
"Orbbec SDK not integrated yet".

To finish it:

1. Drop the Orbbec Android SDK `.aar` into **`android/app/libs/`** (the
   `flatDir` repo in `android/app/build.gradle` already exposes that folder).
2. **Uncomment** the dependency line in `android/app/build.gradle`:
   `// implementation fileTree(dir: 'libs', include: ['*.aar'])`
   (If the SDK ships as a Maven artifact instead, add its repo + a normal
   `implementation "<group>:<artifact>:<version>"` line.)
3. Implement the `TODO(OrbbecSDK)` blocks in `OrbbecPlugin.kt`:
   - **`open()`** — create `OBContext`, query the device, build a `Pipeline`,
     `Config().enableStream(color profile)`, then `pipeline.start(config)`.
     Cache the pipeline as a field. Run off the main thread (Dispatchers.IO).
   - **`capture()`** — `pipeline.waitForFrames(...)`, take the color frame,
     encode to JPEG (the frame may already be MJPG, else `Bitmap.compress`),
     base64-encode, and resolve `{ base64, width, height, format: "jpeg" }`.
   - **`close()`** — `pipeline.stop()/close()` and `obContext.close()`.

The JS layer already chooses the built-in camera by default and only calls into
the Orbbec plugin when explicitly selected, so wiring the SDK does not affect the
default capture path.

### (c) Offline fonts

The web app may reference system/CDN fonts. For a guaranteed-offline field
device, **self-host** the fonts:

1. Add the font files (e.g. `.woff2`) under `assets/fonts/` — that folder is
   already copied verbatim into `www/` by `scripts/build-www.mjs`.
2. Declare them with `@font-face` in the CSS (`src: url('assets/fonts/...')`)
   and remove any external font `<link>`/`@import` so nothing reaches a CDN.
3. Re-run `npm run sync` to bundle them into the APK.

This keeps typography consistent on devices with no network and avoids the brief
fallback-font flash on cold start.
