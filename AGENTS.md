# Agent Guide

The full agent/contributor guide for this repository lives in **[CLAUDE.md](./CLAUDE.md)** —
project architecture, the root → `www/` → Android asset pipeline, module map, build/test
commands, and testing conventions. Read that file first.

Quick reminders:

- **Edit the root sources** (`index.html`, `js/`, `css/`), never the generated `www/` or
  `android/app/src/main/assets/public/` copies. Rebuild with `npm run build:www` (or `npm run sync`).
- Run `npm test` (Node's built-in test runner) after changes.
- App logic is plain classic `<script>` IIFEs that attach to `window.*`; mind the load order in
  `index.html`.
- **Compiling the Android APK** (JDK 17 + Android SDK locations, env vars, Gradle commands, output
  path, adb install) is documented in the "Toolchain / starter pack" and "Compile the Android APK"
  sections of [CLAUDE.md](./CLAUDE.md). Short version: set `JAVA_HOME`/`ANDROID_HOME`, then
  `npm run sync` → `cd android` → `.\gradlew.bat assembleDebug`.
- **Standing instruction:** rebuild the APK at the **end of any turn that changes APK-affecting
  sources** (root `index.html`/`js`/`css`/`assets`/`models` or `android/`) so a fresh
  `app-debug.apk` is always ready without the user asking. Skip only for docs/tests-only turns (and
  say so). Full rule in the "Compile the Android APK" section of [CLAUDE.md](./CLAUDE.md).
