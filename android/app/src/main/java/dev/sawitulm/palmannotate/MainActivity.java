package dev.sawitulm.palmannotate;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    // A WebView camera request awaiting the runtime CAMERA permission dialog.
    private PermissionRequest pendingCameraRequest;
    private static final int RC_WEBVIEW_CAMERA = 0x7C0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins BEFORE the Capacitor bridge initialises.
        registerPlugin(OrbbecPlugin.class);
        registerPlugin(SafPlugin.class);
        super.onCreate(savedInstanceState);

        enableEdgeToEdge();
        injectSafeAreaInsets();
        installCameraPermissionWorkaround();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handlePalmAnnotateBack();
            }
        });
    }

    /**
     * Draw the WebView edge-to-edge (under the status bar, display cutout and
     * gesture-navigation bar) so the web layer's CSS {@code env(safe-area-inset-*)}
     * reports the REAL system inset sizes for this exact device — independent of
     * its screen ratio (16:9, 20:9, notch or not). The web UI then pads its top
     * bars and bottom action rows by those insets, keeping Back / Save / Capture /
     * Next-tree out of the system "dead zones" where taps were being swallowed.
     *
     * Before this, the activity was letterboxed by the system bars, so every
     * {@code env(safe-area-inset-*)} resolved to 0 and the existing safe-area CSS
     * was inert — which is why controls near the top/bottom edges felt blocked.
     *
     * Bars are made transparent (content shows through) with light icons to suit
     * the app's dark theme. Cutout mode SHORT_EDGES lets content use the notch
     * area while env(safe-area-inset-top) still accounts for it.
     */
    private void enableEdgeToEdge() {
        try {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
            WindowInsetsControllerCompat insets =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            if (insets != null) {
                insets.setAppearanceLightStatusBars(false);     // dark theme → light icons
                insets.setAppearanceLightNavigationBars(false);
            }
        } catch (Exception ignored) {
            // Edge-to-edge is a progressive enhancement; never let it crash launch.
        }
    }

    /**
     * Bridge the REAL system-bar insets into CSS as custom properties so the web
     * layer can pad its top bars / bottom nav off the status bar and gesture pill.
     *
     * Why this is needed: on Android, CSS {@code env(safe-area-inset-top)} only
     * reports the DISPLAY CUTOUT (notch) — it does NOT include the status bar.
     * On a no-notch device (e.g. the Xiaomi Pad 6) it stays 0 even though
     * {@link #enableEdgeToEdge()} draws the WebView under the status bar, so every
     * top toolbar slid under the clock. We measure systemBars + displayCutout from
     * the live {@link WindowInsetsCompat} and push them (in CSS px = device px /
     * density) onto {@code document.documentElement.style} as
     * --sat/--sab/--sal/--sar. style.css folds these into --pa-safe-* helpers.
     *
     * The listener re-fires on rotation and on every layout pass, and we re-request
     * insets a few times after launch so the values survive the initial page load
     * race (the first dispatch can arrive before the document is parsed).
     */
    private void injectSafeAreaInsets() {
        if (bridge == null || bridge.getWebView() == null) return;
        final WebView wv = bridge.getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(wv, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            float density = getResources().getDisplayMetrics().density;
            if (density <= 0f) density = 1f;
            final int top = Math.round(bars.top / density);
            final int bottom = Math.round(bars.bottom / density);
            final int left = Math.round(bars.left / density);
            final int right = Math.round(bars.right / density);
            final String js =
                "(function(){try{var s=document.documentElement.style;" +
                "s.setProperty('--sat','" + top + "px');" +
                "s.setProperty('--sab','" + bottom + "px');" +
                "s.setProperty('--sal','" + left + "px');" +
                "s.setProperty('--sar','" + right + "px');}catch(e){}})();";
            wv.post(() -> {
                try { wv.evaluateJavascript(js, null); } catch (Exception ignored) {}
            });
            return windowInsets;
        });
        // Initial apply + a couple of retries to beat the first page-load race.
        ViewCompat.requestApplyInsets(wv);
        wv.postDelayed(() -> ViewCompat.requestApplyInsets(wv), 600);
        wv.postDelayed(() -> ViewCompat.requestApplyInsets(wv), 1800);
    }

    /**
     * Work around a Capacitor WebView bug that crashes the Activity on the first
     * in-app camera capture.
     *
     * When the page calls getUserMedia and the runtime CAMERA permission is not
     * yet held, Capacitor's default {@link BridgeWebChromeClient#onPermissionRequest}
     * requests the permission MID-STREAM and its result handler can call the
     * PermissionRequest's grant()/deny() twice — throwing
     * "IllegalStateException: Either grant() or deny() has been already called."
     * while delivering onRequestPermissionsResult, which tears down the Activity
     * (the app "exits"); on reopen the WebView prompts a second time before the
     * camera finally streams.
     *
     * We take over the camera-only WebView request and resolve it ourselves,
     * never going through that buggy request path: grant it directly when the
     * runtime permission is already held; otherwise request the runtime CAMERA
     * permission ONCE through the Activity and grant/deny this WebView request
     * from {@link #onRequestPermissionsResult}. (The previous version denied
     * immediately when the permission wasn't yet held, which forced the operator
     * to back out, re-enter capture, and grant a SECOND time before the camera
     * streamed.) The JS flow still pre-grants up-front via the Camera plugin, so
     * the common path hits the has-permission branch and grants with no second
     * dialog; the request-on-demand branch is the safety net for the race where
     * the pre-grant hasn't propagated yet. Either way the camera works first try.
     * Non-camera requests fall through to Capacitor's default handling.
     */
    private void installCameraPermissionWorkaround() {
        if (bridge == null || bridge.getWebView() == null) return;
        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                final String[] resources = request.getResources();
                boolean cameraOnly = resources.length > 0;
                for (String r : resources) {
                    if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        cameraOnly = false;
                        break;
                    }
                }
                if (!cameraOnly) {
                    // Audio / MIDI / protected-media etc. — let Capacitor handle it.
                    super.onPermissionRequest(request);
                    return;
                }
                runOnUiThread(() -> {
                    boolean hasCamera = ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.CAMERA
                    ) == PackageManager.PERMISSION_GRANTED;
                    if (hasCamera) {
                        try { request.grant(resources); }
                        catch (IllegalStateException alreadySettled) { /* never crash */ }
                        return;
                    }
                    // Not held yet — request it ONCE through the Activity and grant
                    // this WebView request from the result, instead of denying and
                    // making the operator re-enter capture to grant a second time.
                    pendingCameraRequest = request;
                    try {
                        ActivityCompat.requestPermissions(
                            MainActivity.this,
                            new String[]{ Manifest.permission.CAMERA },
                            RC_WEBVIEW_CAMERA
                        );
                    } catch (Exception e) {
                        pendingCameraRequest = null;
                        try { request.deny(); }
                        catch (IllegalStateException alreadySettled) { /* never crash */ }
                    }
                });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == RC_WEBVIEW_CAMERA) {
            PermissionRequest req = pendingCameraRequest;
            pendingCameraRequest = null;
            boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (req != null) {
                try {
                    if (granted) req.grant(req.getResources());
                    else req.deny();
                } catch (IllegalStateException alreadySettled) {
                    // Defensive: never let a double-resolve crash the Activity.
                }
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private void handlePalmAnnotateBack() {
        if (bridge == null || bridge.getWebView() == null) {
            finish();
            return;
        }

        bridge.getWebView().evaluateJavascript(
            "(function(){try{return !!(window.PalmAnnotateHandleBack && window.PalmAnnotateHandleBack());}catch(e){console.warn('[AndroidBack]',e);return false;}})();",
            value -> {
                boolean consumed = "true".equals(String.valueOf(value));
                if (!consumed) finish();
            }
        );
    }
}
