package dev.sawitulm.palmannotate;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins BEFORE the Capacitor bridge initialises.
        registerPlugin(OrbbecPlugin.class);
        registerPlugin(SafPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
