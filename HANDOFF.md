# HANDOFF — Mobile UI: status-bar dead zone, phone CSS, overlay/popup clipping, v2.0 design system

## Session 12 (2026-06-15) — Orbbec Pad 8 glitch ROOT-CAUSED + FIXED. DEVICE-CONFIRMED via adb logcat.

> **RESOLVED (final, device-confirmed): the cause is POWER, and the fix is to power the hub.**
> A diagnostic build logged the SDK USB link type: `connection=USB3.2` — the Orbbec links at
> SuperSpeed on the Pad 8, so **bandwidth is NOT the bottleneck** (the earlier `super_speed=false`
> read was a red herring). A "lite RGB-D" rung then tried depth at the SMALLEST profile
> (424x240@30 Y16, ≈6 MB/s) and it **still reset the device**, while color-only stays rock-stable.
> Full-depth AND tiny-depth both reset; the only factor absent in color-only is the **depth/IR
> subsystem powering on (IR laser + 2 IR sensors)** — its current draw exceeds what the Pad 8's
> USB-C host supplies, so the camera browns out. **OPERATOR CONFIRMED the fix:** the project's hub
> is a *powered* hub but its **own DC adapter had not been plugged into wall power**; once plugged
> in, **full depth + color + IR all work on the Pad 8.** (The Pad 6 supplies more OTG current, so the
> same hub+cable ran full depth there even unpowered — hence the confusion. Not the hub/cable.)
>
> **Final code (this session):** the proven-useless lite-depth rung was removed (it only added
> glitch); the ladder is now 0 = full color+depth, 1 = color-only **+ emit `orbbecState` "needsPower"
> hint**, 2 = suppress. **`capture-flow.js` now shows that hint as an on-media banner** on the capture
> surface — "Depth needs more USB power… plug in the USB hub's power adapter, then tap Find camera" —
> so an underpowered hub gives a clear, actionable message instead of a silent color-only glitch.
> `css/capture.css` `.capture-live__hint` (on-media tokens). The SDK connection-type log is kept.
> Guard tests updated; `npm test` 211/211. **Operating note for the Pad 8 fleet: the USB hub's power
> adapter MUST be connected for the depth camera** — the app now says so on-screen.

**BUILD SUCCESSFUL** — `app-debug.apk` ≈43.2 MiB, fresh 2026-06-15 17:11. **210/210 tests pass**
(1 new guard test). Installed + verified on the Xiaomi Pad 8 (`25097RP43G` "yupei", Android 16 / SDK
36, **page size 4096** — the 16 KB-page theory is fully dead).

**Session 11's hypothesis (reopen race) was DISPROVEN by device evidence.** adb logcat on the Pad 8
showed the real failure: a relentless **USB attach↔detach storm** (devnum walks `002/005→009→013→…`,
~7 s period, framework logs the external camera `/dev/video9` going `NOT_PRESENT` each cycle — a real
bus-level drop, not a software state issue). The Session-11 retry IS in the APK (stack line numbers
match) but **never engages** here: `Pipeline.start(config)` SUCCEEDS, then the device drops
asynchronously ~150 ms later, so no exception is thrown and the retry loop is never entered (zero
"open attempt N/3" lines in the trace). Not a crash; the app is stable. The loop is sustained by the
auto-reopen feedback path: native pre-warm on USB attach + JS `capture-flow.js` re-mounting the
preview on every `orbbecDeviceChange` → `startPreview()` → `start()` → reset → detach → repeat.

**ROOT CAUSE (device-confirmed):** starting the **depth stream** (IR laser projector + the second
isochronous stream) is the USB power/bandwidth spike that makes the Gemini 335L reset off the bus on
the Pad 8's USB host. Pad 6 (Android 14) tolerates the same start; Pad 8 turns the reset into a full
hotplug storm. NOT a hardware/cable/hub fault (operator was right) — color+depth start simply exceeds
what this port sustains.

**Fix applied (`OrbbecPlugin.kt`, native-only — no JS/UI change needed; JS already handles no-depth):**
a **flapping guard** that counts Orbbec detaches in a 20 s sliding window and steps down:
- `FLAP_DEGRADE_AFTER = 2` detaches → `degradeToColorOnly` → `acquireStreamLocked` skips depth
  (color-only = far lighter USB/power load).
- `FLAP_SUPPRESS_AFTER = 3` further detaches → `unstableSuppressed`: `openSdkLocked()` throws,
  `warmUpSdk()` no-ops, `isAvailable()` reports false → capture UI auto-falls back to the built-in
  camera (loop fully broken, not just hammered).
- Ladder resets on a clean replug (`FLAP_RESET_QUIET_MS = 30 s` quiet since last detach), on a manual
  "Find camera" (`refresh()`) / clean `close()`, and once a stream holds `STABLE_STREAM_MS = 4 s`.
- **Pad 6 / a healthy port never flaps → behaviour byte-for-byte unchanged (full color+depth).**

**DEVICE-CONFIRMED on-device run (Pad 8, this session):** FULL attempt #1 → detach 002/005; FULL
attempt #2 → detach 002/009 → log `Orbbec USB flapping — disabling depth; next open is color-only`;
next open logged `Orbbec color-only mode (depth disabled…)` and then **streamed stably for ~53 s with
zero detaches** until the operator unplugged adb. Operator confirms: live RGB preview works, depth PiP
absent (expected). ~9 s of glitch (2 FULL retries) before it settles — `FLAP_DEGRADE_AFTER` kept at 2
to avoid false-downgrading the healthy Pad 6 on a one-off cable wiggle.

**Trade-off / known limitation:** on the Pad 8, **depth is sacrificed** (color-only) — annotation uses
RGB anyway, so the workflow is intact; only the depth sidecar is lost on this device. Open follow-up
if depth is wanted on Pad 8: try a lighter depth config (lower depth res/fps, or lower color res to
free the USB power/bandwidth budget) and re-test on-device — but if the trigger is the IR-laser power
draw, lowering resolution won't help. Not attempted this session (operator accepted color-only).

**Guard test:** android-config.test.mjs "Orbbec flapping guard: device-confirmed (Pad 8 / Android 16)
open→reset→reopen storm steps down to color-only then suppresses".

## Session 11 (2026-06-15) — Orbbec reopen race on Android 16 (Xiaomi Pad 8). DEVICE-BLIND HYPOTHESIS — later SUPERSEDED.

> **SUPERSEDED by Session 12 (device-confirmed):** the reopen-race hypothesis below was NOT the cause.
> The retry hardening is harmless and stays in (defensive), but the real fix is the Session-12
> flapping guard / color-only downgrade. Keep this entry for history only.

**BUILD SUCCESSFUL** — `app-debug.apk` ≈43.2 MiB, fresh 2026-06-15 16:41. **209/209 tests pass**
(1 new guard test).

**Symptom (operator, Xiaomi Pad 8 / Android 16):** first USB plug of the Orbbec works — camera
loads + streams; the **second attempt fails**, intermittently / hard to reproduce. **Same hub,
cable, camera as the Xiaomi Pad 6 / Android 14 device, where it's smooth.** App does NOT crash;
"Find camera" still detects the device. Operator: not a power issue, not the tablet itself.

**Ruled out this session:** 16 KB page-size / native-lib crash (all `.so` are ELF-16KB-aligned;
app doesn't crash). Raw USB power (powered hub, no charger, identical to Pad 6). USB permission
code is already Android-16-correct (`FLAG_MUTABLE`, `RECEIVER_NOT_EXPORTED`).

**Diagnosis (code-grounded):** the reopen-after-close path had **no retry**. After close/stop,
`closeSdkLocked()` releases Pipeline/Device/OBContext, but the Orbbec native (libusb) handle can
stay briefly busy. On reopen the device is still enumerated (`queryDevices` count > 0, so
`queryDevicesWithRetry` returns immediately — its retry only covers count == 0), but
`getDevice()`/`Pipeline.start()` throws because the old handle isn't fully released. Android 16
reclaims USB FDs on a different schedule than 14, so Pad 8 hits this where Pad 6 never did →
intermittent "second attempt fails".

**Fix applied (`OrbbecPlugin.kt`):** `openSdkLocked()` now wraps the acquire (extracted to
`acquireStreamLocked(ctx)`) in a release-settle-retry loop: `OPEN_RETRIES = 3`,
`OPEN_RETRY_SETTLE_MS = 400`. On a failed attempt it `closeSdkLocked()` (drops the whole context),
sleeps the settle interval, recreates the context, and retries. **Happy path (first attempt
succeeds) is byte-for-byte unchanged** — so the working Pad 6 flow can't regress. Covers all three
entry points (`open`/`startPreview`/`capture`) since they all call `openSdkLocked()`. Single-thread
`cameraExecutor` already serializes these, and open runs while the pump is stopped, so the in-loop
`Thread.sleep` under `stateLock` follows the existing `queryDevicesWithRetry` pattern.

**Guard test:** android-config.test.mjs "open() self-heals a reopen that races a not-yet-released
USB handle".

**VERIFICATION STATUS — DEVICE-BLIND.** This is a hypothesis-driven hardening, not a confirmed fix:
no Pad 8 was connected this session and the bug is intermittent. It should reduce/eliminate the
second-attempt failures, but it is NOT proven on-device. **Next step to confirm:** on the Pad 8 via
wireless adb, `logcat` for tag `PalmAnnotateOrbbec` while reproducing — look for "open attempt
N/3 failed … retrying" lines (proves the race was hit) followed by a successful open (proves the
retry healed it). If it still fails after 3 attempts, capture the underlying SDK/`libusb` exception
to pinpoint the exact failing call.

## Session 10 (2026-06-15) — new machine: fix test suite broken by username spaces + CRLF checkout. APK rebuilt.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, ≈43.2 MiB,
fresh 2026-06-15. **208/208 tests pass** (was 0 of the android-config suite + 1 Orbbec
guard failing before the fix).

Project moved to a new machine whose Windows user folder contains spaces
(`C:\Users\MyBook Z Series\…`) and whose git checks out source as **CRLF** (the old
`Zainal` machine had neither). Two latent bugs in `test/android-config.test.mjs` surfaced:

1. **`%20` in paths** — line 8 derived `root` via `new URL('..', import.meta.url).pathname`,
   which leaves spaces URL-encoded as `%20`, so every `read()` hit `ENOENT`. Fixed to
   `join(dirname(fileURLToPath(import.meta.url)), '..')` — same pattern `_harness.mjs`
   already used.
2. **CRLF vs `\n` markers** — the `sliceBetween` end marker `'/**\n     * Start the live
   preview pump'` couldn't match `\r\n` in the CRLF-checked-out `OrbbecPlugin.kt`. `read()`
   now normalizes `\r\n` → `\n` so guard markers match regardless of checkout EOL.

CLAUDE.md toolchain table was already updated for this machine (JDK
`C:\Users\MyBook Z Series\.jdks\jbr-17.0.14`, SDK in `AppData\Local\Android\Sdk`); build
verified end-to-end with those paths. **No app/source/CSS changes** — only `test/*`; the
APK is byte-equivalent in behaviour to session 9, rebuilt to confirm the toolchain works
on this machine. R8 stays OFF. Device verification still pending (no `adb devices` checked
this session).

_Last updated: 2026-06-15 (session 12 — Orbbec Pad 8 flapping guard, DEVICE-CONFIRMED).
Branch `main`. Sessions 2+3 are COMMITTED (`5f26c34` "Add Better Mobile" + `61e5ded`
"Update Safe-Area"); session-4 through session-12 changes are UNCOMMITTED in the working
tree (the session-8 work may have been committed as `d94aa28` "Update UI fix bug" — verify
with git log)._

## Session 9 (2026-06-10) — v2.0 control-height scale + Orbbec cold-plug detection/pre-warm. DEVICE-BLIND.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, 45,321,011 bytes
(≈43.2 MiB), fresh 2026-06-10 12:57. **205/205 tests pass** (2 guard tests added/updated).
`adb devices` empty — BOTH changes below need device confirmation.

### A. v2.0 control-height scale (operator: "buttons not same size, golden ratio, pixel perfect")

Operator screenshot (Orbbec capture screen) showed the live control cluster at FOUR different
heights: Cancel 56 / camera select 48 / Find camera 48 / Capture 64, plus app-wide drift
(session form 52 vs capture form 56, pa-modal buttons 50, tabs 42, GPS chip 38).

- **`css/style.css :root`** — new tokens (the law for every interactive control's min-height):
  `--phi: 1.618`, `--ctl-h-min: 44px` (HIG floor), `--ctl-h-sm: 40px`, `--ctl-h: 48px`
  (Material target), `--ctl-h-lg: 56px`, `--ctl-h-xl: 64px`. 8px rhythm; sm→xl endpoints in
  the golden ratio (40 × 1.618 ≈ 64).
- **Same-size fixes (visual changes):** capture-live Cancel/select/Find-camera all → 56px;
  shutter min-width 128px → `calc(64px × φ)` ≈ 104px (golden rectangle at minimum; text/padding
  may widen); sessions form fields + seg buttons 52 → 56 (now match the capture form);
  pa-modal buttons 50 → 48; phone tab strip 42 → 44; capture QA GPS chip 38 → 40; reviewall
  retake 44 → 48; inline top-bar select 44 → 48; narrow-phone capture inputs 52 → 48.
- **Token-only swaps (zero visual change):** every other control min-height in `capture.css`,
  `sessions.css`, `carousel.css`, `viewer.css`, `phone.css`, and style.css's
  `@media (pointer: coarse)` touch pass now reads a `--ctl-h-*` token.
- **Deliberately untouched:** `ux-compact.css` (tablet-only, operator-approved), phone.css's
  52px bottom-nav tab (its height feeds the 64px editor-area reservation: 4+52+4=60),
  style.css panel/header min-heights, the 32px `.btn-class--xs`.
- **Guards:** new ui-shell test "v2.0 control heights read the --ctl-h scale" (tokens exist; raw
  px control min-heights banned in the 4 sheets; phone.css allowed exactly one 52px; capture
  cluster equality + golden-rectangle shutter asserted). Two older 56px/44px literal assertions
  updated to the tokens. Also re-verified: all 58 used `var(--*)` tokens across css/ resolve.

### B. Orbbec cold-plug detection (operator: "camera not found until ~2 min of Find-camera spam")

Root cause: **the app was blind to USB attach until the first successful Orbbec open.** The
SDK's `DeviceChangedCallback` only registers when an `OBContext` exists, and the context was
created lazily inside `open()`/`startPreview()`. So a cold plug emitted no event; the only
discovery path was manually pressing "Find camera" — and `refresh()` ALSO tore down a healthy
SDK context on every press (full multi-second re-init each time), which is why spamming
open/close/Find-camera eventually worked.

- **`OrbbecPlugin.kt`** — new USB hotplug `BroadcastReceiver` (vendor 0x2BC5 filtered) registered
  in the plugin's `load()`, no SDK context needed: ATTACH → `warmUpSdk()` (background OBContext
  init on the camera executor, permission-gated, never opens a Pipeline) + `orbbecDeviceChange`
  to JS (capture surface auto-rebuilds its source list — no clicking); DETACH with empty bus →
  the same stop/join/close teardown as the SDK callback (idempotent), covering the no-context
  case. Receiver unregistered in `handleOnDestroy`. `refresh()` is now non-destructive: teardown
  only when the bus is EMPTY; if a device is present it keeps the healthy context and pre-warms.
- **`js/capture/capture-flow.js`** — comment-only update (the orbbecDeviceChange subscription now
  covers cold first-plug; JS logic unchanged — it already rebuilt on the event).
- **Manifest was already correct** (USB_DEVICE_ATTACHED intent-filter + orbbec_usb_filter.xml),
  so plug-while-app-closed prompts to open the app and grants USB permission via the system flow.
- **Guard:** new android-config test "Orbbec cold-plug: hotplug receiver at load, SDK pre-warm,
  non-destructive refresh".
- **Honest limit:** the Gemini 335L's own firmware boot after power-up still takes however long
  it takes — the fix removes the *app-side* blindness and the self-inflicted context teardowns,
  so the source appears as soon as Android enumerates the device.

### Device checklist for session 9 (nothing seen on a screen yet)

1. Capture screen, builtin camera selected → plug the Orbbec in (powered hub) → the Camera
   selector should appear by itself within a few seconds of Android's USB sound, no
   "Find camera" needed. Select Orbbec → preview should start noticeably faster (pre-warmed).
2. Unplug → selector disappears/falls back; replug → reappears. Then "Find camera" once —
   should return fast (no multi-second SDK re-init) and not kill a working preview.
3. v2.0 sizing spot-check: live capture cluster (Cancel / CAMERA select / Find camera all equal
   height, Capture larger), session form vs capture form inputs same height, delete-confirm
   modal buttons, bottom tabs. Light + dark.
4. Regression-watch: Orbbec preview still smooth (R8 stays OFF — unrelated but always verify),
   capture/stop/reopen/detach per the CLAUDE.md Orbbec checklist.

## Session 8 (2026-06-10) — Orbbec preview lag ROOT-CAUSED to R8 (bdcd500), not the bridge. Sessions 6–7 reverted.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, 45,315,863 bytes
(≈43.2 MiB — ~3 MB larger than the R8 builds, still far under the original 85.8 MiB).
**202/202 tests pass.** `adb devices` empty. NEEDS DEVICE CONFIRMATION.

Operator report: the live Orbbec preview is STILL laggy after the session-6/7 ack-gating "fix",
**but it worked perfectly before the APK-size commit `bdcd500`** ("Optimize Android APK size").

**Bisection (decisive):** `git diff bdcd500 HEAD` for `OrbbecPlugin.kt` and `orbbec-source.js` is
**empty** — the preview code is byte-for-byte identical to when it worked. So the regression is in
`bdcd500`'s BUILD CONFIG, not the code. `bdcd500` changed four things; I verified the native side
is fully intact in the built APK (`libOrbbecSDK.so`, `libobsensor_jni.so`, `libob_frame_processor.so`,
`libFilterProcessor.so`, depth engine, `libomp.so` all present at full size), so the ABI filter and
slim-AAR are innocent. That leaves **R8 code minification** (`minifyEnabled true` +
`proguard-android-optimize.txt`, enabled for debug AND release in `bdcd500`) as the only change that
alters runtime behaviour — and "worked → one frame then freeze" exactly when minify switched on is
the classic signature of R8 stripping/optimising the Orbbec SDK's JNI/reflection frame-callback path
beyond what the keep rules cover.

**This means sessions 6–7 were a MISDIAGNOSIS.** The ack-gating assumed "the WebView can't drain
frames fast enough" — disproven by the preview running smoothly at full frame-rate before `bdcd500`.
The ack-gating sat on top of the real bug and its own failure mode (acks stalling → ~1 fps) mimics
the snapshot symptom.

What changed this session:

- **Reverted sessions 6–7** entirely on the preview path: `git checkout HEAD --`
  `OrbbecPlugin.kt`, `orbbec-source.js`, `orbbec-source.test.mjs`, `android-config.test.mjs`
  (removed ack-gating + the 720→640 downscale + the ack guard/tests), restoring the exact
  last-known-good pump.
- **`android/app/build.gradle`** — `minifyEnabled false` + `shrinkResources false` for debug AND
  release (with a long comment explaining why). KEPT the real size wins (independent of R8): ONNX
  model shrink + slim arm64 Orbbec AAR + arm64-only ABI.
- **`CLAUDE.md`** — rewrote the "Current APK build direction" header: R8 is now deliberately OFF,
  with the bisection rationale and a do-not-re-enable-without-device-verifying warning.
- **`android-config.test.mjs`** — flipped the guard: new test "R8 minification stays OFF until the
  Orbbec preview is device-verified" asserts `minifyEnabled false`/`shrinkResources false`.
- **Gotcha hit & fixed:** `git checkout` on Windows re-expanded `OrbbecPlugin.kt` to **CRLF**
  (autocrlf; repo has no `.gitattributes`), which broke the one disconnect-teardown test marker that
  spans a line break (`/**\n * Start…`). Normalized the file back to **LF** — it now byte-matches
  the committed blob (zero git diff). If a future `git checkout` of a `.kt`/multi-line-marker file
  trips a test, suspect CRLF first.

**DEVICE-CONFIRMED 2026-06-10 — hypothesis was correct.** Operator installed this APK and the live
preview works again: a smooth RGB stream plus the colorized depth PiP, Orbbec USB camera selected
(screenshot on the Xiaomi Pad 6, "View 1/4" capture screen). R8 minification was the cause; the
ack-gating (sessions 6–7) was an unnecessary misdiagnosis and stays reverted.

**Remaining (optional) follow-up:** R8 is now OFF, so the debug/release APK is ~3 MB larger than the
R8 builds (still far under the original 85.8 MiB). If the smaller APK is wanted back, the path is to
reintroduce R8 **on release only**, add Orbbec-specific keep rules, and RE-VERIFY the live preview on
the device before trusting it — re-enabling R8 blind will reintroduce the freeze. Recommendation:
leave R8 off unless the size is actually a problem; the working camera is worth 3 MB.

### Session 8b — Orbbec preview cropped/cut-off in portrait → letterboxed. Rebuilt.

**BUILD SUCCESSFUL** — `app-debug.apk` 45,316,147 bytes (≈43.2 MiB), 2026-06-10 12:36. **203/203
tests pass.** Operator report (phone screenshot, Orbbec selected): the live preview was cut off —
only a centre slice of the scene was visible. Cause: the Orbbec is a fixed **landscape 16:9** USB
camera but `.orbbec-live__main` used `object-fit: cover`, which crops the wide frame to fill the
portrait (9:16) screen — and `capture()` saves the FULL landscape frame, so what you framed ≠ what
you got. Fix (`css/capture.css`): `@media (orientation: portrait) { .orbbec-live__main { object-fit:
contain } }` — the whole frame is now letterboxed (black bars top/bottom) and matches the captured
image exactly. Landscape/tablet keeps `cover` (approved, untouched). Guard:
`ui-shell.test.mjs` "Orbbec live preview letterboxes its landscape frame in portrait". **Device check
still pending for this one** — confirm the full FOV is visible in portrait and the captured photo
matches the letterboxed preview.

## Session 7 (2026-06-10) — handoff issue sweep: all classes clean; one ack-rejection fix. DEVICE STILL ABSENT.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, 42,272,538 bytes
(≈40.3 MiB), fresh 2026-06-10 07:42. **204/204 tests pass** (1 new guard). `adb devices` empty
AGAIN — device verification (Next Steps step 1) remains the blocking task before commit.

Audited everything actionable from this handoff with no device attached:

- **Class-1 sweep (raw `env()`)** — every remaining usage matches the deliberate-skip list exactly:
  `ux-compact.css` tablet floating palette, `.header__inner--wide`/`.workspace` (tablet), capture
  overlay root (`capture.css:24`), reviewall retake (`capture.css:801`), dead `.rotate-gate`. Clean.
- **Class-2 sweep (clipped popups), banned-paint sweep (`backdrop-filter`/`filter:blur`/
  `transition:all`), undefined-token cross-check (every `var(--x)` in css/ resolves to a
  definition)** — all clean.
- **Build provenance** — `www/` matches root sources file-for-file; APK timestamp was newer than
  every source file (session 6's build really did contain the ack fix).
- **Session-6 ack pump re-review** — Kotlin side sound (increment-before-notify, 1 s timeout
  fallback, reset in startPump, clamp-at-0 ack). Found ONE real defect on the JS side:
  `orbbec-source.js` `_ackFrame` called `Orbbec.ackPreview()` fire-and-forget inside a sync
  `try/catch` — Capacitor bridge methods return promises, so a rejection (USB detach racing the
  rAF-deferred ack) would escape as an **unhandled promise rejection**, violating the non-throwing
  capture contract. Fixed: the returned promise now gets `.catch(() => {})`. New guard:
  `orbbec-source.test.mjs` "ack is fire-and-forget — a rejecting ackPreview never escapes"
  (asserts zero `unhandledRejection` events when the mock ack throws).

No other code changes — sessions 4–6 work was verified internally consistent. Everything below
session 6's device checklist is unchanged and still pending a physical device.

## Session 6 (2026-06-10) — Orbbec live preview freeze/lag root-caused + fixed. DEVICE-BLIND.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, 42,272,422 bytes
(≈40.3 MiB), fresh 2026-06-10 07:33. **203/203 tests pass** (2 new guards). `adb devices` empty.

Operator bug report (phone screenshot, reproduced on tablet AND phone): Orbbec USB camera
preview shows ONE frame then freezes — "like a snapshot, not live"; whole screen laggy; native
capture itself still produces good photos. Root cause (source-verified, two compounding defects
in the preview pump, `OrbbecPlugin.kt`):

1. **No backpressure on the Capacitor bridge.** `runPump()` emitted a preview frame every 80 ms
   via `notifyListeners("orbbecFrame", …)`; each becomes an `evaluateJavascript` of a huge base64
   JSON string queued on the Android MAIN thread. The WebView (JS parse → event dispatch →
   data-URI base64 decode → JPEG decode → raster) can't drain at that rate, the queue grows
   unboundedly → first frame paints, then the UI is permanently behind = frozen preview + global
   jank. Capture worked because the camera pipeline/pump live on native threads.
2. **The "downscaled" preview was NOT downscaled.** `COLOR_PREVIEW_MAX_DIM = 720` is unreachable
   by the power-of-two `inSampleSize` from the preferred ~1280-wide profile (1280/2 = 640 < 720 →
   inSampleSize stays 1), so FULL 1280×720 JPEGs (~100–200 KB base64) crossed the bridge 12.5×/s.

Fix (both sides of the bridge):

- **`OrbbecPlugin.kt`** — ack-gated pump: new `previewPending` (AtomicInteger) +
  `lastPreviewEmitMs`; `runPump` emits only when `previewReady(now)` (pending == 0, or
  `PREVIEW_ACK_TIMEOUT_MS = 1_000L` elapsed so a lost ack degrades to ~1 fps instead of freezing);
  `emitPreview` increments pending before `notifyListeners`; new `@PluginMethod ackPreview()`
  decrements; `startPump` resets both. `COLOR_PREVIEW_MAX_DIM` 720→**640** (reachable: 1280→640×360),
  `COLOR_PREVIEW_JPEG_QUALITY` 60→**55**.
- **`js/capture/orbbec-source.js`** — `_onFrame` paints, then acks via
  `requestAnimationFrame(() => Orbbec.ackPreview())` (coalesced, best-effort, guarded for old
  plugins without the method) — stream rate self-adapts to the device's real paint rate.
- **Guards:** `android-config.test.mjs` "preview pump is ack-gated and genuinely downscaled";
  `orbbec-source.test.mjs` "mountPreview acks every preview frame".

**Verified-by-source + compiled only — NOT seen on a device.** The fix mechanism (frame pacing)
can only be confirmed with the Orbbec attached: open capture → Orbbec source → preview must
track camera movement continuously for ≥60 s with the UI staying responsive; also retest
capture, stop/reopen, and cable detach/reconnect (CLAUDE.md Orbbec checklist).

## Session 5 (2026-06-10) — "PalmAnnotate v2.0" UI consistency pass. STILL DEVICE-BLIND.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, 42,268,026 bytes
(≈40.3 MiB), fresh 2026-06-10 07:12. **201/201 tests pass** (1 new guard added).
`adb devices` empty AGAIN — sessions 2–5 have never been seen on a real screen.

Operator ask: "all tabs/pages still clunky, shapes not good, not consistent — define a new era,
PalmAnnotate v2.0, same features, really improved UI." Diagnosis: the colour system was already
tokenized, but **shape/elevation/label type were not** — `sessions.css` and `ux-compact.css`
ignored the `--r-*` scale entirely (ad-hoc 3/4/6/8/10/12/14/16/18/22/999px radii), labels ranged
0.65–0.8rem with 5 letter-spacings, shadows were copy-pasted rgba blocks, and two literal bugs
existed (`.modal__title` referenced a `--f-heading` token that was never defined; a duplicate
`.btn--accent` block repainted accent buttons in off-palette literal greens
`#22c55e/#16a34a`, overriding the token variant).

What changed (ALL features/markup/JS untouched — pure CSS system + version stamp):

- **Shape scale (style.css `:root`)** — radius tokens are now the law:
  `--r-xs:4 / --r-sm:8 / --r-md:12 / --r-lg:16 / --r-xl:24 / --r-full:999` (old scale was
  6/12/20/28). EVERY `border-radius` in EVERY css file now reads a token; **zero raw px radii
  remain** (verified by grep + new guard test). Cards = lg, buttons/inputs/toasts = md, modals
  (`.modal`, `.pa-modal__card`, `.quality-modal__panel`) = xl, chips/badges = xs, pills = full.
- **Elevation scale** — `--shadow-sm/--shadow-soft/--shadow-lg` tokens; ad-hoc box-shadows in
  modal/quality-modal/classbar/overflow-sheet/pa-modal now read them. `theme-light.css` redefines
  all three.
- **Micro-label type** — `--fs-label: 0.72rem` + `--ls-label: 0.08em`; all uppercase labels
  (toolbar, form fields, section titles, stat labels, capture/source labels, QA titles, results
  h3, dedup panel titles, depth-viewer) unified.
- **Heading identity** — `.home__hero h1` (1.9rem) and `.sheet__top h1` (1.45rem) now use
  `--f-display` serif weight 400, matching capture titles / empty states — one title voice app-wide.
- **Component fixes** — deleted the duplicate gradient `.btn--accent` (token variant + proper
  `:disabled` kept); `.modal__title` → bold sans (dead `--f-heading` ref removed); `.btn` weight
  500→600 (matches every other button); `.dedup-help:hover` text `#fff`→`--c-on-accent`; toggle
  switch knob `#0c120c`→`--c-on-accent` (both were light-theme contrast bugs); global
  `:focus-visible` accent ring via `:where(...)` (specificity 0).
- **Version stamp** — `package.json` 2.0.0; `build.gradle` default `versionName` '2.0'
  (env `PA_VERSION_NAME` still overrides).
- **`test/ui-shell.test.mjs`** — new guard "v2.0 shape/elevation/label tokens are the single
  source of truth": tokens exist; raw-px `border-radius` banned in all 8 sheets (0 / 50% / var /
  calc still legal); gradient btn--accent and `--f-heading` stay dead; focus ring + serif titles
  asserted. **201 tests pass.**

Verified-by-source only. **Visual risk notes for device check:** radius steps moved (lg 20→16,
xl 28→24, sm 6→8) so EVERYTHING is slightly different curvature — that is the point, but eyeball
the carousel stage, session cards, and modals; hero/sheet titles render in Instrument Serif now;
accent buttons (`#btn-save-output`, capture-tree) are lime/token instead of green gradient. The
tablet IS affected by these token changes (deliberate — operator asked for app-wide v2.0), unlike
sessions 2–4 which were phone-scoped.

## Session 4 (2026-06-10) — modal clipping + WebView paint cost. STILL DEVICE-BLIND.

**BUILD SUCCESSFUL** — `android\app\build\outputs\apk\debug\app-debug.apk`, 42,267,122 bytes
(≈40.3 MiB), fresh 2026-06-10 06:46. 200/200 tests pass.
`adb devices` was empty AGAIN — nothing from sessions 2–4 has ever been seen on a real screen.
**Device verification (Next Steps step 1 below) remains the blocking task before commit.**

Changes this session (same two bug classes, swept further):

- **`css/style.css` — `.modal` had NO height cap (Class-2 clip).** On a short landscape 20:9 phone
  (~360px CSS height) the "Bunch Class Resolution" modal (60vh `.mismatch-list` + header + footer)
  overflowed the screen with no scroll — footer buttons unreachable. Now: `.modal-overlay` pads by
  `12px + --pa-safe-top/bottom`, `.modal` is a flex column capped at `max-height:100%`,
  `.modal__body` scrolls (`overflow-y:auto; min-height:0`), header/footer `flex-shrink:0`.
- **`css/sessions.css` — same treatment for `.pa-modal`** (delete confirm): overlay folds in
  `--pa-safe-top/bottom`, card gets `max-height:100%; overflow-y:auto`.
- **`css/style.css` — removed the always-on `filter: blur(120px)` from `.bg-glow`** (ambient
  glows). Same WebView jank class as the banned backdrop-filter: a permanently-composited blurred
  layer. The soft look is now baked into the radial gradients (extra mid stop, `transparent 72%`).
  Phones never showed these (`display:none` ≤640px) — this is a pure tablet/desktop paint-cost win;
  visual change on the tablet is a slightly tighter (still very faint) glow falloff.
- **`css/style.css` — `.side-pill` `transition: all` → specific properties** (background-color,
  color, border-color).
- **`test/ui-shell.test.mjs` — 2 new guards:** "modals cap to the safe viewport and scroll inside"
  and a "no `filter: blur` / no `transition: all`" sweep across all css files. **200 tests pass.**

Verified-by-source this session: both fixed `.tabs` bars (portrait + short-landscape) pad by
`--pa-safe-*`; toast container uses `--pa-safe-bottom`; remaining raw `env()` usages are exactly
the deliberate list from session 3 (tablet surfaces, capture-overlay root, reviewall retake, dead
rotate-gate). `.quality-modal__panel` already caps at `88vh` + scrolls — left alone.

## Goal

Make the **narrow 20:9 / 9:16 phone** (operator screenshots 720×1600, ~360 CSS px) genuinely
usable and **pixel-perfect**, while leaving the **tablet (Xiaomi Pad 6) untouched — operator says
it's already perfect**. Recurring operator complaint across all sessions: chrome sliding under the
status-bar clock, controls clipped at the bottom, and popups cut off. The operator is (rightly)
frustrated when bugs of an already-known *class* are left for them to find one screenshot at a time —
so the standing expectation now is: **sweep the whole class, don't whack one mole.**

Standing constraints (in force from sessions 1–2): don't break bunch-linking/annotation; keep it
smooth (**no live `backdrop-filter: blur`** — caused WebView jank, guard-tested); **don't touch the
tablet**; never hand-edit `www/` or `android/.../assets/public/` (edit root sources + rebuild).

## Session 3 progress — 198/198 tests pass, APK builds green, NOT device-verified (now committed)

`android\app\build\outputs\apk\debug\app-debug.apk` (≈40.3 MiB, BUILD SUCCESSFUL, fresh 06/09 ~23:30).
**`adb devices` was EMPTY all session → source + tests + build only, NOTHING confirmed on-device.**
Everything below is reasoned + unit-guarded + compiled, not seen on a screen.

### The two root-cause bug CLASSES (the important part)

**Class 1 — raw `env(safe-area-inset-*)` is 0 on this no-notch device.** `env()` on Android resolves
only to the **display cutout (notch)**, NOT the status bar. The phone/Pad 6 have no notch, so it is
**0** even though the WebView draws edge-to-edge. The fix (from session 2) is the MainActivity-injected
`--sat/--sab/--sal/--sar` insets, exposed via the helpers `--pa-safe-top/bottom/left/right`
(= `max(--sat, env())`) in `css/style.css :root`. **Any topmost/bottommost surface that still uses
raw `env()` is buggy.** Converting `env()` → `--pa-safe-*` is **monotonic-safe** (always ≥ the old
inset, never less), so these changes cannot make anything worse than before.

**Class 2 — absolutely-positioned popups anchored off-screen and clipped by an `overflow:hidden`
ancestor.** The dedup "More" dropdown used `right: 0` while its button sits at the LEFT of the wrapped
row, so the 210px sheet ran off the left edge and `#panel-dedup { overflow:hidden }` sliced it in half.

### Files changed THIS session (session 3, all uncommitted)

- **`css/phone.css`**
  - Carousel bottom-clip fix: stage `min-height: 120px` → **`0`** (the 120px floor re-introduced the
    exact overflow that hid the Detect/Save/Next row — `carousel.css:423` had deliberately set 0).
    `.editor-area` bottom reservation `56px` → **`64px + --pa-safe-bottom`** (the fixed bottom nav is
    ~60px tall: 4 + 52 tab + 4). Landscape reservation `44px` → `48px`.
  - Dedup "More" dropdown: `.overflow-menu__sheet` anchor `right: 0` → **`left: 0; right: auto`** +
    `max-width: min(280px, calc(100vw - 24px))` so it opens INTO the screen and can't clip.
  - Replaced the `⋯` ellipsis with a **CSS caret** on `.overflow-menu > summary::after` that flips up
    when `[open]` (+ `list-style:none` / hide `::-webkit-details-marker`).
- **`index.html`** — dedup `<summary>` text `&#8943; More` → **`More`** (caret is CSS now).
- **`css/capture.css`** — migrated all full-bleed capture chrome `env()` → `--pa-safe-*`:
  `.capture-cam__bar` (+9:16 variant), `.capture-live__top`, `.capture-live__controls` (portrait +
  landscape) + `.capture-live__cancel`, `.orbbec-live__pip` (+ landscape). **Deliberately LEFT as
  `env()`:** `.capture-overlay` root padding (line 24 — inner bars now self-inset; padding it too
  would double-pad), and `.capture-reviewall__retake` (line 801 — it's relative to an already-inset
  slide, so `--pa-safe` would shove it ~28px too low).
- **`css/viewer.css`** — `.more-menu__sheet` (carousel "More" bottom sheet) padding-bottom
  `env` → `--pa-safe-bottom` (Cancel button was behind the system gesture nav).
- **`css/sessions.css`** — `.home__scroll` padding top/bottom `env` → `--pa-safe-*` in BOTH the base
  rule and the `min-width:720px` rule (sessions-home hero was under the clock; the old comment even
  repeated the wrong "env resolves on-device" assumption).
- **`css/style.css`** — `.toast-container` padding-bottom `env` → `--pa-safe-bottom`.
- **`test/ui-shell.test.mjs`** — added guards: carousel bottom-clip (64px reservation + stage
  min-height:0), capture full-bleed chrome uses `--pa-safe-*`, dedup overflow opens `left:0` + no `⋯`
  + caret, and an "edge-to-edge surfaces use injected insets not raw env()" sweep test. Loads
  `viewer.css` now. **198 tests pass.**

## What Worked

- **Treating each operator screenshot as a CLASS, then grepping `env(safe-area-inset` across all of
  `css/`** to find every unmigrated instance in one pass (capture, viewer, sessions, toast) instead
  of fixing only the one screen shown.
- **Monotonic-safety argument** (`--pa-safe-* ≥ env()`) makes the safe-area sweep low-risk even
  without a device: it can only add clearance, never remove it.
- **Anchoring the dropdown to the button's actual side** (`left:0`, because More is left-aligned) +
  a viewport-relative `max-width` — robust against the `overflow:hidden` panel.
- Keeping the tablet untouched by confirming `phone.css` (≤600px) fully overrides the `ux-compact.css`
  floating-palette rules, so leaving those `env()` usages alone affects only the tablet.

## What Didn't Work / Avoided / Unverified

- **UNVERIFIED — the whole session is device-blind (`adb devices` empty).** Needs real screenshots.
- Did **NOT** migrate `ux-compact.css` floating-palette `env()` (lines ~16–175) or `.workspace`
  /`.header__inner--wide` `env()` — those are **tablet/desktop** surfaces; the phone overrides them and
  the operator said the tablet is perfect. Changing them would shift the approved tablet (~20px).
- `.rotate-gate` (style.css ~1738) still uses `env()` but it's **`display:none` (retired)** — dead, skip.
- Don't reintroduce aspect-ratio-band media queries; width/height + `--pa-safe-*` is the model.

## Next Steps

1. **VERIFY ON DEVICE (blocking before commit).** Install + relaunch + screenshot, portrait AND
   landscape:
   ```powershell
   $adb='C:\tools\android-sdk\platform-tools\adb.exe'
   & $adb install -r android\app\build\outputs\apk\debug\app-debug.apk
   & $adb shell am force-stop dev.sawitulm.palmannotate
   & $adb shell monkey -p dev.sawitulm.palmannotate -c android.intent.category.LAUNCHER 1
   & $adb shell screencap -p /sdcard/pa.png ; & $adb pull /sdcard/pa.png "$env:TEMP\pa.png"
   ```
   Confirm specifically: (a) **Dedup → tap "More"**: dropdown opens fully on-screen, no left-edge clip,
   caret flips; (b) **carousel**: Detect/Save/Next row sits fully above the bottom nav with a small gap
   on all 4 tabs; (c) **capture flow** (metadata form, live camera top bar + capture controls, immersive
   review top/bottom bars, Orbbec PiP) all clear the clock / nav; (d) **carousel "More" sheet** Cancel
   clears the gesture bar; (e) **sessions home** hero clears the clock; (f) **tablet (Pad 6) unchanged**.
2. If any top STILL overlaps → the `--sat` injection isn't landing post-load; apply the
   `onPageFinished` / `DOMContentLoaded` bridge fallback (see session-2 notes below).
3. Proactively keep sweeping classes, not single screens — if a new clip/overlap shows up, grep for
   the pattern (`env(safe-area-inset`, `position:\s*absolute` inside `overflow:hidden`) across `css/`.
4. Once verified good, **commit** (sessions 2+3 are committed; the session-4 modal/perf changes
   AND the session-5 v2.0 design pass are still UNCOMMITTED). Add to the device checklist: (g) open
   **Output Settings** and **Bunch Class Resolution** modals on the phone in landscape — footer
   buttons must stay reachable, body scrolls; (h) tablet ambient glow still looks right without the
   blur filter; (i) **v2.0 spot-check**: sessions home (serif hero, 16px-radius cards, accent CTA),
   carousel floating palettes on the tablet, any modal (24px radius), accent export buttons (lime
   token, no green gradient), dark AND light theme.

## Build / toolchain quick ref (this machine)
```
JAVA_HOME = C:\tools\jdk17\jdk-17.0.19+10   (set inline every build; not on PATH)
ANDROID_HOME = C:\tools\android-sdk
adb = C:\tools\android-sdk\platform-tools\adb.exe
# from repo root:
npm test
npm run sync
cd android ; .\gradlew.bat clean assembleDebug --no-daemon
# APK: android\app\build\outputs\apk\debug\app-debug.apk
```
Repo root (use full path; cwd may report `...\PalmAnnotate` without `-Android`):
`C:\Users\Zainal\Desktop\PalmAnnotate-Android`. NOTE: in the Bash tool, `cd android` from a relative
cwd can fail — `cd` to the absolute `...\PalmAnnotate-Android\android` path.

---

## Session 2 (history) — top status-bar dead zone + centralize phone CSS

Fixed the top overlap by injecting the real status-bar height from native (`MainActivity
.injectSafeAreaInsets()` → `--sat/--sab/--sal/--sar` on `document.documentElement`, re-applied at
600/1800ms to beat the page-load race) and exposing `--pa-safe-*` helpers in `style.css`.
**Centralized all narrow-phone CSS into one ordered `css/phone.css`** (`@media (max-width: 600px)`,
loaded last after `ux-compact.css`), deleting the scattered/conflicting layers (style.css PORTRAIT
PHONE LAYER @768, ux-compact PHONE LAYER @600, carousel.css aspect-bands) that caused the inconsistent
double render. Fixed the double-label bottom-nav bug via `font-size:0 !important`. Biggest residual
risk noted then: the `--sat` injection timing — if the insets listener fires only before parse, vars
are lost and the top still overlaps; fallback is to push from `onPageFinished` / `DOMContentLoaded`.

## Session 1 (history) — bottom nav + un-float carousel + kill WebView lag

1. **Lag / 1s "More" freeze = `backdrop-filter: blur()`** in the Android WebView → removed all 15
   usages; frosted look kept via opaque glass tokens. **Do not reintroduce** (guard-tested).
2. **Cut-off tabs ("nnotate")** → fixed bottom nav (icon + `data-short` `::after`).
3. **Filmstrip behind buttons** → carousel un-floated into one flow stack on phones.
4. **Tablet 3:2 refinements never fired** (capped at 1280px; Pad 6 ~1440px CSS) → cap raised to 1600px.

Session-1 hard lesson, still binding: **do NOT remove the carousel Review/Edit toggle** — linking
(`_armOrCancelLink`) is Review-mode only. No emulator on this machine — must use a physical device.
