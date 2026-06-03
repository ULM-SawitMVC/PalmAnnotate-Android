package dev.sawitulm.palmannotate;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
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
     * runtime permission is already held, otherwise deny (the web capture flow
     * then falls back to the file picker). The runtime CAMERA permission is
     * obtained up-front, through the Camera plugin's own correct permission API,
     * by the JS capture flow (CaptureFlow._ensureCameraPermission) before any
     * getUserMedia call — so by the time this fires the permission is held and we
     * grant immediately: one clean prompt, no crash, camera works first try.
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
                    try {
                        if (hasCamera) {
                            request.grant(resources);
                        } else {
                            request.deny();
                        }
                    } catch (IllegalStateException alreadySettled) {
                        // Defensive: never let a double-resolve crash the Activity.
                    }
                });
            }
        });
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
