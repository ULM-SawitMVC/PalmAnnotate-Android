package dev.sawitulm.palmannotate;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

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

        installCameraPermissionWorkaround();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handlePalmAnnotateBack();
            }
        });
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
