# HOW TO USE ADB — Git Bash (MSYS) Working Commands

> **CRITICAL:** In Git Bash (MSYS), bare `/sdcard/` paths get converted to `C:/Program Files/Git/sdcard/`.  
> Always use `MSYS_NO_PATHCONV=1` before adb commands, or the paths will be mangled.

## Setup

```bash
ADB="/c/tools/android-sdk/platform-tools/adb.exe"
PKG="dev.sawitulm.palmannotate.debug"
```

## Common Commands

### Check device
```bash
MSYS_NO_PATHCONV=1 $ADB devices
```

### Screenshot → pull → read
```bash
MSYS_NO_PATHCONV=1 $ADB shell "screencap -p /sdcard/pa.png"
MSYS_NO_PATHCONV=1 $ADB pull /sdcard/pa.png "D:/Work/Assisten-Dosen/PalmAnnotate-Android/pa.png"
# Then use vision_describe or read on the PNG
```

### Launch app
```bash
MSYS_NO_PATHCONV=1 $ADB shell "monkey -p $PKG -c android.intent.category.LAUNCHER 1"
```

### Force stop + relaunch
```bash
MSYS_NO_PATHCONV=1 $ADB shell "am force-stop $PKG"
sleep 1
MSYS_NO_PATHCONV=1 $ADB shell "monkey -p $PKG -c android.intent.category.LAUNCHER 1"
```

### Install APK
```bash
MSYS_NO_PATHCONV=1 $ADB install -r "D:/Work/Assisten-Dosen/PalmAnnotate-Android/Migrasi/app/build/outputs/apk/debug/app-debug.apk"
```

### Tap (screen coordinates)
```bash
MSYS_NO_PATHCONV=1 $ADB shell "input tap <X> <Y>"
```

### Swipe
```bash
MSYS_NO_PATHCONV=1 $ADB shell "input swipe <X1> <Y1> <X2> <Y2> <duration_ms>"
```

### Type text
```bash
MSYS_NO_PATHCONV=1 $ADB shell "input text 'hello'"
```

### Key event (Back, Enter, etc.)
```bash
MSYS_NO_PATHCONV=1 $ADB shell "input keyevent 4"   # Back
MSYS_NO_PATHCONV=1 $ADB shell "input keyevent 66"  # Enter
```

### Logcat (filtered)
```bash
MSYS_NO_PATHCONV=1 $ADB logcat -c
# ... trigger the bug ...
MSYS_NO_PATHCONV=1 $ADB logcat -d -t 400 2>/dev/null | grep -iE "Exception|FATAL|AndroidRuntime|palmannotate"
```

### Screen info
```bash
MSYS_NO_PATHCONV=1 $ADB shell "wm size && wm density"
MSYS_NO_PATHCONV=1 $ADB shell "dumpsys display | grep mCurrentOrientation"
```

### Check foreground activity
```bash
MSYS_NO_PATHCONV=1 $ADB shell "dumpsys activity activities | grep -E 'ResumedActivity|mResumedActivity'"
```

### DB forensics (pull all WAL parts)
```bash
MSYS_NO_PATHCONV=1 $ADB shell "run-as $PKG ls databases"
MSYS_NO_PATHCONV=1 $ADB shell "run-as $PKG cat databases/palmannotate.db" > /tmp/pa.db
MSYS_NO_PATHCONV=1 $ADB shell "run-as $PKG cat databases/palmannotate.db-wal" > /tmp/pa.db-wal
MSYS_NO_PATHCONV=1 $ADB shell "run-as $PKG cat databases/palmannotate.db-shm" > /tmp/pa.db-shm
```

## Screen Coordinate Mapping (Xiaomi Pad 6)

- **Physical size:** 2136×3200 (portrait), density 440
- **Landscape mode:** 3200×2136
- Check orientation: `dumpsys display | grep mCurrentOrientation` (0=portrait, 1=landscape)
