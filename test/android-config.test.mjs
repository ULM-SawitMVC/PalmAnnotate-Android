'use strict';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
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
  const pkg = JSON.parse(read('package.json'));

  assert.match(variables, /minSdkVersion = 22/);
  assert.match(variables, /compileSdkVersion = 34/);
  assert.match(variables, /targetSdkVersion = 34/);
  assert.equal(pkg.dependencies['@capacitor/android'].startsWith('^6.'), true);
  assert.equal(pkg.dependencies['@capacitor/filesystem'].startsWith('^6.'), true);
  assert.equal(pkg.dependencies['@capacitor/camera'].startsWith('^6.'), true);
  assert.equal(pkg.dependencies['@capacitor/preferences'].startsWith('^6.'), true);
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
});

test('Native activity uses a full-screen WebView instead of fixed-size Android views', () => {
  const layout = read('android/app/src/main/res/layout/activity_main.xml');
  const styles = read('android/app/src/main/res/values/styles.xml');

  assert.match(layout, /<androidx\.coordinatorlayout\.widget\.CoordinatorLayout[\s\S]*android:layout_width="match_parent"[\s\S]*android:layout_height="match_parent"/);
  assert.match(layout, /<WebView[\s\S]*android:layout_width="match_parent"[\s\S]*android:layout_height="match_parent"/);
  assert.doesNotMatch(layout, /dp"/, 'layout should not hardcode fixed dp sizes around the WebView');
  assert.match(styles, /<item name="windowActionBar">false<\/item>/);
  assert.match(styles, /<item name="windowNoTitle">true<\/item>/);
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
    'vendor/onnxruntime/ort-wasm-simd-threaded.wasm',
    'vendor/onnxruntime/ort-wasm-simd-threaded.mjs',
    'models/detector.config.json',
  ];

  for (const rel of required) {
    assert.equal(existsSync(join(publicRoot, rel)), true, `${rel} should exist in Android public assets`);
  }
});
