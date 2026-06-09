# HANDOFF — Mobile UI: fix top status-bar dead zone + centralize phone CSS

_Last updated: 2026-06-09 (session 2). Branch `main`. Changes are UNCOMMITTED in the working tree._

## Goal

Make the **narrow 20:9 / 9:16 phone** (operator screenshots 720×1600, ~360 CSS px) genuinely
usable, while leaving the **tablet (Xiaomi Pad 6) untouched — operator says it's already perfect**.
Two explicit asks this session:

1. **Fix the TOP.** Bottom nav was praised ("good job on bottom"), but on EVERY screen the top
   bar overlapped the status-bar clock (images 17, 19, 20, 21, 22). Plus: bottom nav sometimes
   showed **double labels** ("Annotation Editor" over "Editor", image 18); editor buttons clipped
   (image 19); **landscape dedup had no way to go back** (images 20–21).
2. **Centralize the phone CSS** into one ordered place ("not that much grep at other files").

Standing constraints (still in force from session 1): don't break bunch-linking/annotation;
keep it smooth (no live `backdrop-filter: blur` — it caused the WebView jank); tablet stays good.

## Current Progress — 196/196 tests pass, APK builds green, NOT device-verified

`android\app\build\outputs\apk\debug\app-debug.apk` (≈40.3 MiB, BUILD SUCCESSFUL, fresh 06/09 22:48).
**`adb devices` was empty all session → source + tests + build only, NOTHING confirmed on-device.**

### Root cause of the top overlap (the important part)
`env(safe-area-inset-top)` on Android reports only the **display cutout (notch)** — NOT the status
bar. The phone/Pad 6 have no notch, so it resolves to **0** even though the WebView draws
edge-to-edge, and every `max(8px, env(safe-area-inset-top))` padding collapsed to ~8px → content
slid under the clock. The session-1 comment claiming env() returns the real inset was wrong.

### Files changed this session (all uncommitted)
- **`android/.../MainActivity.java`** — added `injectSafeAreaInsets()`: a
  `setOnApplyWindowInsetsListener` on the WebView measures the real `systemBars()+displayCutout()`
  insets and injects them as CSS px custom props `--sat/--sab/--sal/--sar` on
  `document.documentElement`; called in `onCreate`, re-applied via `postDelayed` at 600/1800 ms to
  beat the page-load race.
- **`css/style.css`** — `:root` now defines `--sat..--sar` (default `0px`, web-safe) and the
  helpers `--pa-safe-top/bottom/left/right` = `max(var(--sat), env(...))`. `.header__inner` uses
  them. Added the base `.dedup-rotate-hint { display: none; }` (moved out of ux-compact). **Removed**
  the old `@media (orientation: portrait) and (max-width: 768px)` PORTRAIT PHONE LAYER block.
- **`css/phone.css` (NEW)** — THE single consolidated narrow-phone layer. Loaded in `index.html`
  after `ux-compact.css`, before `theme-light.css`. One `@media (max-width: 600px)` block with
  ordered sections (0 status-bar inset → 1 bottom nav → 2 carousel → 3 editor → 4 dedup → 5 results
  → 6 overflow menu) plus a `@media (orientation: landscape) and (max-height: 500px)` block (7).
  Key fixes: pads every top bar by `calc(6px + var(--pa-safe-top))`; **double-label fix** via
  `font-size: 0 !important` (out-specifies `carousel.css` `crsl-show-tabs .tab`); slim fixed bottom
  nav kept in landscape so dedup is escapable; carousel chips become an equal-width row.
- **`css/ux-compact.css`** — removed the PHONE LAYER block (migrated to phone.css). Tablet
  floating-palette rules untouched.
- **`css/carousel.css`** — removed the aspect-band `@media …480px…9/20…9/16` block and the
  `@media (max-width: 560px)` top-nav block (both migrated to phone.css). Tablet rules untouched.
- **`test/android-config.test.mjs`** — edge-to-edge test now also asserts `injectSafeAreaInsets`,
  the insets listener, `--sat/--sab` injection, and the style.css tokens.
- **`test/ui-shell.test.mjs`** — repointed the reflow / bottom-nav / overflow / dedup-hint guards
  at `phone.css`; added a double-label (`font-size:0 !important`) guard; removed the two assertions
  for the deleted carousel aspect-band rule.

## What Worked
- **Pinning the top overlap to the env() Android gotcha**, not "add more padding". The real fix is
  injecting the measured status-bar height from native; CSS env() alone can never solve it on a
  no-notch device.
- **Centralizing into one `css/phone.css`** loaded last → its overrides win cleanly; the scattered
  three-file / four-breakpoint mess (which caused the inconsistent double render) is gone. Tablet
  (~800px CSS portrait) never hits the ≤600px query, so it stayed untouched.
- Keeping the migration faithful (move rules, don't rewrite semantics) + a guard test per behaviour
  change → 196/196 still green.

## What Didn't Work / Avoided / Unverified
- **UNVERIFIED, biggest risk: the `--sat` injection timing.** If the insets listener fires only
  before the page parses, the vars get lost and the top will STILL overlap. Mitigated with 600/1800
  ms re-applies, but this needs a real device screenshot to confirm. Fallback if it fails: push
  `--sat` from `onPageFinished` (override the WebViewClient carefully — Capacitor bridges through
  it) or from JS on `DOMContentLoaded` via a bridge call.
- The **landscape-phone breakpoint** `max-height: 500px` is an estimate of the phone's landscape CSS
  height (Pad 6 is ~800px tall in landscape, so excluded). Confirm on device it actually triggers.
- Did NOT touch any JS / linking. Carousel Review/Edit + `_armOrCancelLink`/`_completeLink` intact.
- Don't re-introduce aspect-ratio-band media queries — width/height + `--pa-safe-*` is the model now.

## Next Steps
1. **VERIFY ON DEVICE (blocking before commit).** Install + relaunch + screenshot every surface in
   **portrait AND landscape**:
   ```powershell
   $adb='C:\tools\android-sdk\platform-tools\adb.exe'
   & $adb install -r android\app\build\outputs\apk\debug\app-debug.apk
   & $adb shell am force-stop dev.sawitulm.palmannotate
   & $adb shell monkey -p dev.sawitulm.palmannotate -c android.intent.category.LAUNCHER 1
   & $adb shell screencap -p /sdcard/pa.png ; & $adb pull /sdcard/pa.png "$env:TEMP\pa.png"
   ```
   Confirm: (a) **top bars clear the clock** on carousel/editor/dedup/results (= `--sat` injected);
   (b) bottom nav shows ONE short label per tab, no double; (c) editor buttons not clipped; (d)
   dedup is escapable in landscape (slim bottom nav visible); (e) linking works in carousel Review
   mode AND dedup; (f) tablet (Pad 6) layout unchanged.
2. If the top STILL overlaps → the listener isn't firing post-load; apply the `onPageFinished` /
   `DOMContentLoaded` fallback above.
3. If the carousel canvas is too short on phone with the bottom nav: move `Detect again / Save &
   exit / Next tree` into `_openMoreMenu` (app.js ~290) and stop building `.crsl-actionrow`
   (`_carouselHooks`, app.js ~263) to reclaim ~50px. (Deferred pending screenshots.)
4. Once verified good, **commit** (currently uncommitted).

## Build / toolchain quick ref (this machine)
```
JAVA_HOME = C:\tools\jdk17\jdk-17.0.19+10   (set inline every build; not on PATH)
ANDROID_HOME = C:\tools\android-sdk
adb = C:\tools\android-sdk\platform-tools\adb.exe
# from repo root:
npm test
npm run sync
cd android && .\gradlew.bat clean assembleDebug --no-daemon
# APK: android\app\build\outputs\apk\debug\app-debug.apk
```
Repo root (use full path; cwd may report `...\PalmAnnotate` without `-Android`):
`C:\Users\Zainal\Desktop\PalmAnnotate-Android`

---

## Session 1 (history) — bottom nav + un-float carousel + kill WebView lag

Earlier work that the above builds on. Root causes found and fixed then:
1. **Lag / 1s "More" freeze = `backdrop-filter: blur()`** in an Android WebView. Removed ALL 15
   blur usages (style/capture/ux-compact/sessions.css); frosted look kept via opaque glass tokens.
   **Do not reintroduce `backdrop-filter: blur`** — guard test enforces this.
2. **Cut-off tabs ("nnotate")** → tabs became a fixed bottom nav (icon + `data-short` `::after`).
3. **Filmstrip behind buttons** → carousel un-floated into one flow stack on phones.
4. **Tablet 3:2 refinements never fired** (capped at 1280px; Pad 6 is ~1440px CSS) → cap raised to
   1600px in `css/style.css` (guard test asserts `max-width: 1600px`).

Session-1 hard lesson, still binding: **do NOT remove the carousel Review/Edit toggle** — linking
(`_armOrCancelLink`) is Review-mode only; removing Review breaks bunch-linking. KEPT BOTH MODES.
No emulator on this machine — must use a physical device.
