# E2E Testing Guide — PalmAnnotate Native App (Migrasi/)

## Key Learnings from Trial & Error

### ADB Commands (Git Bash — MUST use `MSYS_NO_PATHCONV=1`)

```bash
ADB="/c/tools/android-sdk/platform-tools/adb.exe"
PKG="dev.sawitulm.palmannotate.debug"

# All adb commands MUST be prefixed with:
MSYS_NO_PATHCONV=1 $ADB shell "..."
MSYS_NO_PATHCONV=1 $ADB pull /sdcard/file.png "D:/Work/.../file.png"
```

### Screenshot + Vision Workflow

```bash
# 1. Capture
MSYS_NO_PATHCONV=1 $ADB shell "screencap -p /sdcard/pa.png"
MSYS_NO_PATHCONV=1 $ADB pull /sdcard/pa.png "D:/Work/Assisten-Dosen/PalmAnnotate-Android/pa.png"
# 2. Use vision_describe tool on pa.png
```

### UI Automator — Get Exact Element Bounds

When taps don't register, dump UI hierarchy to find exact coordinates:

```bash
MSYS_NO_PATHCONV=1 $ADB shell "uiautomator dump /sdcard/ui.xml"
MSYS_NO_PATHCONV=1 $ADB shell "cat /sdcard/ui.xml" > "D:/Work/Assisten-Dosen/PalmAnnotate-Android/ui.xml"
```

Then parse with Python:

```python
import re
with open('D:/Work/Assisten-Dosen/PalmAnnotate-Android/ui.xml') as f:
    xml = f.read()
for m in re.finditer(r'<node[^>]*clickable="true"[^>]*>', xml):
    node = m.group(0)
    bounds = re.search(r'bounds="(\[[\d,\]\[]+)"', node)
    desc = re.search(r'content-desc="([^"]+)"', node)
    text = re.search(r'text="([^"]+)"', node)
    print(f'  bounds={bounds.group(1)} text={text.group(1) if text else ""!r} desc={desc.group(1) if desc else ""!r}')
```

**CRITICAL:** The clickable parent's bounds are what you tap, NOT the text/icon child bounds!

### Device Info (Xiaomi Pad 6)

- **Physical screen:** 2136×3200 (portrait native)
- **Landscape mode:** 3200×2136 (app is locked to landscape)
- **Density:** 440 dpi
- **Orientation:** `dumpsys display | grep mCurrentOrientation` → `1` = landscape
- **Screenshot size:** Always 3200×2136 in landscape

---

## Exact Tap Coordinates for Each Screen

### 1. Home Screen

| Element | Bounds (from uiautomator) | Center Tap |
|---|---|---|
| Group header "DAMIMAS · A21B" (expand/collapse) | `[44,816][3156,992]` | `1600, 880` |
| Session entry card (after group expands) | `[88,1025][3156,1234]` | `800, 1130` |
| Session Open arrow → | `[2991,1064][3123,1196]` | `3057, 1130` |
| Session Delete 🗑 | `[2859,1064][2991,1196]` | `2925, 1130` |
| "+ New Session" FAB | `[2731,1894][3156,2048]` | `2944, 1971` |
| Export folder "Change" | `[2746,354][2950,486]` | `2848, 420` |
| Export folder "Clear" | `[2950,354][3112,486]` | `3031, 420` |

**Navigation sequence to open a session:**
1. Tap group header to expand: `1600, 880`
2. Wait 1 second
3. Tap session Open arrow: `3057, 1130`

### 2. Session Detail Screen

| Element | Bounds | Center Tap |
|---|---|---|
| Back arrow ← | `[11,112][143,244]` | `77, 178` |
| "+ Add Tree" FAB | `[2796,1894][3156,2048]` | `2976, 1971` |

### 3. Capture Screen (View 1-4/4)

| Element | Bounds | Center Tap |
|---|---|---|
| View 1 tab | `[17,393][193,569]` | `105, 481` |
| View 2 tab | `[215,393][391,569]` | `303, 481` |
| View 3 tab | `[413,393][589,569]` | `501, 481` |
| View 4 tab | `[611,393][787,569]` | `699, 481` |
| **Capture button** (shutter) | `[1501,1739][1699,1937]` | **`1600, 1838`** |
| Cancel (back arrow) | `[11,112][143,244]` | `77, 178` |
| "Phone" camera switch | `[2958,113][3189,245]` | `3074, 179` |

### 4. After Capture (Confirmation per view)

| Element | Bounds | Center Tap |
|---|---|---|
| "Retake" button | `[61,1849][1583,1981]` | `822, 1915` |
| "Continue" button | `[1616,1849][3139,1981]` | **`2378, 1915`** |

### 5. After All 4 Views Captured

| Element | Bounds | Center Tap |
|---|---|---|
| "Retake" button | `[61,1849][1583,1981]` | `822, 1915` |
| "Review all" button | `[1616,1849][3139,1981]` | **`2378, 1915`** |

### 6. Review Carousel

| Element | Notes |
|---|---|
| Swipe left/right | `input swipe X1 Y1 X2 Y2 300` |
| "Save & Annotate" button | Bottom green button (use uiautomator to find exact bounds) |
| "Retake side N" button | Overlay on each captured image |

---

## Full Capture Flow (4 views)

```bash
ADB="/c/tools/android-sdk/platform-tools/adb.exe"

# 1. Launch app
MSYS_NO_PATHCONV=1 $ADB shell "am force-stop dev.sawitulm.palmannotate.debug"
MSYS_NO_PATHCONV=1 $ADB shell "monkey -p dev.sawitulm.palmannotate.debug -c android.intent.category.LAUNCHER 1"
sleep 2

# 2. Expand group + open session
MSYS_NO_PATHCONV=1 $ADB shell "input tap 1600 880"   # expand group
sleep 1
MSYS_NO_PATHCONV=1 $ADB shell "input tap 3057 1130"  # tap Open arrow
sleep 1

# 3. Tap "Add Tree"
MSYS_NO_PATHCONV=1 $ADB shell "input tap 2976 1971"
sleep 2

# 4. Capture view 1
MSYS_NO_PATHCONV=1 $ADB shell "input tap 1600 1838"
sleep 2
MSYS_NO_PATHCONV=1 $ADB shell "input tap 2378 1915"  # Continue
sleep 2

# 5. Capture view 2
MSYS_NO_PATHCONV=1 $ADB shell "input tap 1600 1838"
sleep 2
MSYS_NO_PATHCONV=1 $ADB shell "input tap 2378 1915"  # Continue
sleep 2

# 6. Capture view 3
MSYS_NO_PATHCONV=1 $ADB shell "input tap 1600 1838"
sleep 2
MSYS_NO_PATHCONV=1 $ADB shell "input tap 2378 1915"  # Continue
sleep 2

# 7. Capture view 4
MSYS_NO_PATHCONV=1 $ADB shell "input tap 1600 1838"
sleep 2
MSYS_NO_PATHCONV=1 $ADB shell "input tap 2378 1915"  # Review all
sleep 2

# 8. Now on review carousel — find and tap "Save & Annotate"
```

---

## Debugging Tips

1. **Taps not registering?** → Use `uiautomator dump` to find exact bounds
2. **Taps hit wrong element?** → The clickable PARENT bounds are what matters, not the child text/icon bounds
3. **Group collapses instead of navigating?** → Your tap hit the group header, not the session card below it
4. **Vision model can't see details?** → Use Python PIL to scan pixel colors for specific UI elements
5. **Logcat for crashes:** `MSYS_NO_PATHCONV=1 $ADB logcat -d -t 400 | grep -iE "Exception|FATAL|AndroidRuntime"`
6. **DB forensics (pull WAL):** `MSYS_NO_PATHCONV=1 $ADB shell "run-as $PKG cat databases/palmannotate.db-wal" > file.db-wal`
7. **Debug logging:** Add `Log.d(TAG, ...)` to key functions, rebuild, check logcat

## Critical Bug Fixes Found During E2E

### Race Condition: Dedup loads partial data

**Root cause:** `saveSession` does `deleteByTree` then re-inserts sides one by one. If dedup navigates before all sides are re-inserted, it sees partial data.

**Timeline:**
```
07:48:40.984 persistSides: delete all sides, start inserting 4 new sides
07:48:40.989 insert sideIndex=0 (Side 1) with 1 bbox
07:48:41.053 loadActiveSession for dedup: actualSides=1 ← RACE! Only 1 inserted
07:48:42.389 insert sideIndex=1 (Side 2)
07:48:43.707 insert sideIndex=2 (Side 3)
```

**Fix:** Use `saveAndAwait()` + `scope.launch` in the dedup button handler so navigation waits for save completion.

```kotlin
// BEFORE (buggy): save is async, navigation happens immediately
IconButton(onClick = { viewModel.save(); onOpenDedup() })

// AFTER (fixed): save completes before navigation
IconButton(onClick = {
    scope.launch {
        viewModel.saveAndAwait()
        onOpenDedup()
    }
})
```
