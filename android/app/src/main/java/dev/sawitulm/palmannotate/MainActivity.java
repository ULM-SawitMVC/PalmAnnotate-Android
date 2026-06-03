package dev.sawitulm.palmannotate;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins BEFORE the Capacitor bridge initialises.
        registerPlugin(OrbbecPlugin.class);
        registerPlugin(SafPlugin.class);
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handlePalmAnnotateBack();
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
