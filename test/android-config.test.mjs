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

test('Android SDK and plugin dependencies cover current debug APK requirements', () => {
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
  assert.match(appGradle, /implementation fileTree\(dir: 'libs', include: \['\*\.aar'\]\)/);
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
