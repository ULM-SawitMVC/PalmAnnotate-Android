# HANDOFF — Mobile UI: status-bar dead zone, phone CSS, overlay/popup clipping

_Last updated: 2026-06-10 (session 4). Branch `main`. Sessions 2+3 are now COMMITTED
(`5f26c34` "Add Better Mobile" + `61e5ded` "Update Safe-Area"); session-4 changes below are
UNCOMMITTED in the working tree._

## Session 4 (2026-06-10) — modal clipping + WebView paint cost. STILL DEVICE-BLIND.

`adb devices` was empty AGAIN — nothing from sessions 2–4 has ever been seen on a real screen.
**Device verification (Next Steps step 1 below) remains the blocking task before commit.**
200/200 tests pass.

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
   are still UNCOMMITTED). Add to the device checklist: (g) open **Output Settings** and **Bunch
   Class Resolution** modals on the phone in landscape — footer buttons must stay reachable, body
   scrolls; (h) tablet ambient glow still looks right without the blur filter.

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
