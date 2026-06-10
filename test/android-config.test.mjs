'use strict';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

function assertInOrder(source, labels) {
  let cursor = -1;
  for (const label of labels) {
    const next = source.indexOf(label);
    assert.ok(next > cursor, `${label} should appear after previous lifecycle step`);
    cursor = next;
  }
}

test('Android app id, namespace, strings, and Capacitor config stay aligned', () => {
  const cap = JSON.parse(read('capacitor.config.json'));
  const appGradle = read('android/app/build.gradle');
  const strings = read('android/app/src/main/res/values/strings.xml');

  assert.equal(cap.appId, 'dev.sawitulm.palmannotate');
  assert.equal(cap.appName, 'PalmAnnotate');
  assert.equal(cap.webDir, 'www');
  assert.match(appGradle, /namespace "dev\.sawitulm\.palmannotate"/);
  assert.match(appGradle, /applicationId "dev\.sawitulm\.palmannotate"/);
  assert.match(strings, /<string name="app_name">PalmAnnotate<\/string>/);
  assert.match(strings, /<string name="package_name">dev\.sawitulm\.palmannotate<\/string>/);
});

test('Android SDK and plugin dependencies cover the optimized debug APK', () => {
  const variables = read('android/variables.gradle');
  const appGradle = read('android/app/build.gradle');
  const pkg = JSON.parse(read('package.json'));

  assert.match(variables, /minSdkVersion = 24/);
  assert.match(variables, /compileSdkVersion = 34/);
  assert.match(variables, /targetSdkVersion = 34/);
  assert.equal(pkg.dependencies['@capacitor/android'].startsWith('^6.'), true);
  assert.equal(pkg.dependencies['@capacitor/filesystem'].startsWith('^6.'), true);
  assert.equal(pkg.dependencies['@capacitor/camera'].startsWith('^6.'), true);
  assert.equal(pkg.dependencies['@capacitor/preferences'].startsWith('^6.'), true);
  assert.match(appGradle, /abiFilters 'arm64-v8a'/);
  assert.match(appGradle, /exclude 'jni\/armeabi-v7a\/\*\*'/);
  assert.match(appGradle, /exclude 'assets\/armeabi-v7a\/\*\*'/);
  assert.match(appGradle, /exclude 'assets\/arm64-v8a\/extensions\/firmwareupdater\/\*\*'/);
  assert.match(appGradle, /implementation slimOrbbecFiles/);
});

test('Android R8 minification stays OFF until the Orbbec preview is device-verified', () => {
  // Regression guard. Enabling minify in bdcd500 ("Optimize Android APK size")
  // is when the live Orbbec preview broke (worked perfectly before → froze after
  // one frame). The preview code is unchanged across that commit and all native
  // libs are present at full size in the APK, so R8 — the only runtime-behaviour
  // change in that commit — is the cause (it strips/optimises the SDK's
  // JNI/reflection frame-callback path beyond what the keep rules cover). The
  // size wins that actually mattered (ONNX model shrink + slim arm64 Orbbec AAR)
  // are independent of R8 and remain in place. Do NOT flip these back to `true`
  // without first confirming the live preview streams smoothly on the device.
  const appGradle = read('android/app/build.gradle');
  assert.match(appGradle, /debug \{[\s\S]*minifyEnabled false[\s\S]*shrinkResources false/);
  assert.match(appGradle, /release \{[\s\S]*minifyEnabled false[\s\S]*shrinkResources false/);
});

test('Android release builds require external signing credentials', () => {
  const appGradle = read('android/app/build.gradle');
  const rootIgnore = read('.gitignore');
  const androidIgnore = read('android/.gitignore');

  assert.match(appGradle, /PA_KEYSTORE/);
  assert.match(appGradle, /PA_KEYSTORE_PASS/);
  assert.match(appGradle, /PA_KEY_ALIAS/);
  assert.match(appGradle, /PA_KEY_PASS/);
  assert.match(appGradle, /signingConfig signingConfigs\.release/);
  assert.match(appGradle, /Release signing is not configured/);
  assert.match(rootIgnore, /\*\.jks/);
  assert.match(rootIgnore, /android\/keystore\.properties/);
  assert.match(androidIgnore, /keystore\.properties/);
});

test('Android manifest remains orientation-flexible for phone and tablet aspect ratios', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  assert.doesNotMatch(manifest, /android:screenOrientation=/);
  assert.match(manifest, /android:configChanges="[^"]*orientation[^"]*screenSize[^"]*smallestScreenSize[^"]*screenLayout[^"]*uiMode[^"]*"/);
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.usb\.host" android:required="false" \/>/);
  assert.match(manifest, /<provider[\s\S]*android:name="androidx\.core\.content\.FileProvider"[\s\S]*android:authorities="\$\{applicationId\}\.fileprovider"/);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.INTERNET" \/>/);
});

test('Android manifest declares location permissions so capture GPS can be granted', () => {
  // Root cause of the "GPS Unavailable" bug: the WebView's navigator.geolocation
  // runtime request is auto-denied for any permission not declared here, so the
  // capture form could never obtain a fix. These declarations let the user grant
  // location; GPS hardware itself stays optional (app still runs without it).
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  assert.match(manifest, /<uses-permission android:name="android\.permission\.ACCESS_COARSE_LOCATION" \/>/);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.ACCESS_FINE_LOCATION" \/>/);
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.location\.gps" android:required="false" \/>/);
});

test('Android manifest declares CAMERA so the in-app live-preview capture can stream', () => {
  // The reworked capture flow streams the camera INSIDE the app via WebView
  // getUserMedia (no OS camera activity). Capacitor's BridgeWebChromeClient only
  // grants the WebView's getUserMedia request once CAMERA is declared here; the
  // hardware stays optional so camera-less devices still install (capture then
  // falls back to the file picker / plugin).
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  assert.match(manifest, /<uses-permission android:name="android\.permission\.CAMERA" \/>/);
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/);
});

test('Android Orbbec USB camera integration is optional and registered', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const filter = read('android/app/src/main/res/xml/orbbec_usb_filter.xml');
  const activity = read('android/app/src/main/java/dev/sawitulm/palmannotate/MainActivity.java');
  const plugin = read('android/app/src/main/java/dev/sawitulm/palmannotate/OrbbecPlugin.kt');

  assert.match(manifest, /android\.hardware\.usb\.action\.USB_DEVICE_ATTACHED/);
  assert.match(manifest, /android:resource="@xml\/orbbec_usb_filter"/);
  assert.match(filter, /<usb-device vendor-id="11205" \/>/);
  assert.match(activity, /registerPlugin\(OrbbecPlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "Orbbec"\)/);
  assert.match(plugin, /const val ORBBEC_VENDOR_ID = 0x2BC5/);
  assert.match(plugin, /Context\.RECEIVER_NOT_EXPORTED/);
  assert.match(plugin, /PendingIntent\.FLAG_MUTABLE/);
  assert.match(plugin, /OBContext/);
  assert.match(plugin, /Pipeline/);
  assert.match(plugin, /waitForFrameSet/);
  assert.doesNotMatch(plugin, /Orbbec SDK not integrated yet/);
});

test('Android Orbbec depth preview uses optimal-range filtering and lighter robust colorization', () => {
  const plugin = read('android/app/src/main/java/dev/sawitulm/palmannotate/OrbbecPlugin.kt');

  assert.match(plugin, /DEPTH_RANGE_FLOOR_MM = 250f/);
  assert.match(plugin, /DEPTH_RANGE_CEILING_MM = 7_000f/);
  assert.match(plugin, /DEPTH_PREVIEW_MAX_DIM = 288/);
  assert.match(plugin, /DEPTH_PREVIEW_INTERVAL_MS = 160L/);
  assert.match(plugin, /DEPTH_RANGE_LOW_PERCENTILE = 0\.02f/);
  assert.match(plugin, /DEPTH_RANGE_HIGH_PERCENTILE = 0\.98f/);
  assert.match(plugin, /depthDisplayFloorMm/);
  assert.match(plugin, /depthDisplayCeilingMm/);
  assert.match(plugin, /validMm\.sort\(0, validCount\)/);
});

test('Android Orbbec disconnect teardown serializes the native preview pump before SDK release/restart', () => {
  // Regression guard for the USB-C PD/charging detach crash: Orbbec can disappear
  // while the preview pump is blocked in waitForFrameSet(). Every path that
  // releases the SDK or starts a direct/new reader must first stop+join that pump,
  // otherwise the vendor native layer can race and kill the app process.
  const plugin = read('android/app/src/main/java/dev/sawitulm/palmannotate/OrbbecPlugin.kt');

  const detach = sliceBetween(plugin, 'override fun onDeviceDetach(deviceList: DeviceList)', 'notifyDeviceChange(false, 0)');
  assertInOrder(detach, ['stopPump()', 'cameraExecutor.execute', 'joinPump()', 'closeSdkLocked()']);

  const stopPreview = sliceBetween(plugin, 'fun stopPreview(call: PluginCall)', '/** Stop/release the Pipeline');
  assertInOrder(stopPreview, ['stopPump()', 'cameraExecutor.execute', 'joinPump()', 'call.resolve']);

  const startPreview = sliceBetween(plugin, 'fun startPreview(call: PluginCall)', '/** Stop the live preview pump');
  assertInOrder(startPreview, ['joinPump()', 'openSdkLocked()', 'startPump()', 'call.resolve']);

  const capture = sliceBetween(plugin, 'fun capture(call: PluginCall)', '/**\n     * Start the live preview pump');
  assert.match(capture, /if \(pumpRunning\)[\s\S]*captureViaPump\(\)[\s\S]*else[\s\S]*joinPump\(\)[\s\S]*captureRgbd\(\)/);

  const closeSdk = sliceBetween(plugin, 'private fun closeSdkLocked()', '// ── Frame capture');
  assertInOrder(closeSdk, ['pumpRunning = false', 'pendingCapture.getAndSet(null)?.reject', 'safeStopAndClose(oldPipeline)']);
});

test('Android Orbbec cold-plug: hotplug receiver at load, SDK pre-warm, non-destructive refresh', () => {
  // Regression guard for the "camera not found until ~2 minutes of Find-camera
  // spam" report: the SDK's DeviceChangedCallback only exists after the first
  // successful open, so before that the app was blind to USB attach. A plain
  // Android BroadcastReceiver registered at plugin load (no SDK context needed)
  // must notify JS AND pre-warm the OBContext, and refresh() must not tear down
  // a healthy context (that forced a full multi-second SDK re-init per press).
  const plugin = read('android/app/src/main/java/dev/sawitulm/palmannotate/OrbbecPlugin.kt');

  assert.match(plugin, /override fun load\(\)[\s\S]*?registerUsbHotplugReceiver\(\)/);
  assert.match(plugin, /UsbManager\.ACTION_USB_DEVICE_ATTACHED/);
  assert.match(plugin, /UsbManager\.ACTION_USB_DEVICE_DETACHED/);

  // Attach: pre-warm first, then tell JS to re-scan its source list.
  const attach = sliceBetween(plugin, 'UsbManager.ACTION_USB_DEVICE_ATTACHED ->', 'UsbManager.ACTION_USB_DEVICE_DETACHED ->');
  assertInOrder(attach, ['warmUpSdk()', 'notifyDeviceChange(true']);

  // Detach with an empty bus tears down off the main thread (join before close).
  const detach = sliceBetween(plugin, 'UsbManager.ACTION_USB_DEVICE_DETACHED ->', 'val filter = IntentFilter()');
  assertInOrder(detach, ['stopPump()', 'cameraExecutor.execute', 'joinPump()', 'closeSdkLocked()', 'notifyDeviceChange(false']);

  // Pre-warm: permission-gated, background, OBContext only — never a Pipeline.
  const warm = sliceBetween(plugin, 'private fun warmUpSdk()', '// ── USB helpers');
  assert.match(warm, /cameraExecutor\.execute/);
  assert.match(warm, /hasPermission/);
  assert.match(warm, /obContext = OBContext\(appContext, deviceChangedCallback\)/);
  assert.doesNotMatch(warm, /Pipeline\(/);

  // refresh(): teardown only when the bus is empty; otherwise keep + pre-warm.
  const refresh = sliceBetween(plugin, 'fun refresh(call: PluginCall)', 'override fun handleOnDestroy');
  assert.match(refresh, /if \(devices\.isEmpty\(\)\)[\s\S]*?closeSdkLocked\(\)[\s\S]*?\} else \{[\s\S]*?warmUpSdk\(\)/);

  // The receiver is released with the plugin.
  assert.match(plugin, /override fun handleOnDestroy\(\)[\s\S]*?unregisterUsbHotplugReceiver\(\)/);
});

test('Native activity uses a full-screen WebView and delegates Android Back to the SPA', () => {
  const layout = read('android/app/src/main/res/layout/activity_main.xml');
  const styles = read('android/app/src/main/res/values/styles.xml');
  const activity = read('android/app/src/main/java/dev/sawitulm/palmannotate/MainActivity.java');

  assert.match(layout, /<androidx\.coordinatorlayout\.widget\.CoordinatorLayout[\s\S]*android:layout_width="match_parent"[\s\S]*android:layout_height="match_parent"/);
  assert.match(layout, /<WebView[\s\S]*android:layout_width="match_parent"[\s\S]*android:layout_height="match_parent"/);
  assert.doesNotMatch(layout, /dp"/, 'layout should not hardcode fixed dp sizes around the WebView');
  assert.match(styles, /<item name="windowActionBar">false<\/item>/);
  assert.match(styles, /<item name="windowNoTitle">true<\/item>/);
  assert.match(activity, /OnBackPressedCallback/);
  assert.match(activity, /PalmAnnotateHandleBack/);
  assert.match(activity, /evaluateJavascript/);
  assert.match(activity, /if \(!consumed\) finish\(\)/);
});

test('Native activity draws edge-to-edge AND injects the real system insets as CSS vars', () => {
  const activity = read('android/app/src/main/java/dev/sawitulm/palmannotate/MainActivity.java');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const style = read('css/style.css');

  // Edge-to-edge: the WebView fills the whole screen (under status bar / cutout /
  // gesture nav).
  assert.match(activity, /setDecorFitsSystemWindows\(getWindow\(\), false\)/);
  assert.match(activity, /setStatusBarColor\(Color\.TRANSPARENT\)/);
  assert.match(activity, /setNavigationBarColor\(Color\.TRANSPARENT\)/);
  assert.match(activity, /LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES/);
  // Keyboard must resize the view (not cover capture-form inputs) under edge-to-edge.
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);

  // CRITICAL: env(safe-area-inset-top) only reports the display CUTOUT on Android,
  // NOT the status bar — so on a no-notch device it is 0 and top bars slide under
  // the clock. The activity must measure the REAL system bars and inject them as
  // --sat/--sab so CSS can pad correctly regardless of notch.
  assert.match(activity, /private void injectSafeAreaInsets\(\)/);
  assert.match(activity, /setOnApplyWindowInsetsListener/);
  assert.match(activity, /WindowInsetsCompat\.Type\.systemBars\(\)/);
  assert.match(activity, /setProperty\('--sat'/);
  assert.match(activity, /setProperty\('--sab'/);
  assert.match(activity, /injectSafeAreaInsets\(\);/);

  // style.css must define the injected vars (default 0 for web) and the helper.
  assert.match(style, /--sat:\s*0px/);
  assert.match(style, /--pa-safe-top:\s*max\(var\(--sat\), env\(safe-area-inset-top\)\)/);
});

test('Native camera permission request-on-demand grants the WebView request on first try', () => {
  const activity = read('android/app/src/main/java/dev/sawitulm/palmannotate/MainActivity.java');

  // Camera-only WebView requests are handled by our own WebChromeClient.
  assert.match(activity, /onPermissionRequest\(final PermissionRequest request\)/);
  // When the runtime permission isn't held yet, request it ONCE through the
  // Activity instead of denying (the old deny() forced a back-out + 2nd grant).
  assert.match(activity, /ActivityCompat\.requestPermissions\([\s\S]*Manifest\.permission\.CAMERA[\s\S]*RC_WEBVIEW_CAMERA/);
  // The result handler grants/denies the pending WebView request, guarded so a
  // double-resolve can never crash the Activity.
  assert.match(activity, /public void onRequestPermissionsResult\(/);
  assert.match(activity, /pendingCameraRequest/);
  assert.match(activity, /req\.grant\(req\.getResources\(\)\)/);
  assert.match(activity, /catch \(IllegalStateException/);
});

test('Capacitor sync output contains the app shell, Android storage code, and offline detector vendor files', () => {
  const publicRoot = join(root, 'android/app/src/main/assets/public');
  const required = [
    'index.html',
    'css/style.css',
    'css/capture.css',
    'css/carousel.css',
    'js/app.js',
    'js/storage/capacitor-adapter.js',
    'js/capture/capture-source.js',
    'js/capture/capture-flow.js',
    'js/capture/orbbec-source.js',
    'js/carousel/carousel-ui.js',
    'js/detect/detector.js',
    'vendor/onnxruntime/ort.min.js',
    // onnxruntime-web 1.19's ort.min.js loads the JSEP wasm variant for the
    // wasm EP (not the plain non-jsep pair). Vendoring the wrong variant left
    // the on-device runtime with "no available backend found" → detection
    // silently disabled. These two MUST be the jsep files. See build-www.mjs.
    'vendor/onnxruntime/ort-wasm-simd-threaded.jsep.wasm',
    'vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs',
    'models/detector.config.json',
  ];

  for (const rel of required) {
    assert.equal(existsSync(join(publicRoot, rel)), true, `${rel} should exist in Android public assets`);
  }
});
