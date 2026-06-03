package dev.sawitulm.palmannotate

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * OrbbecPlugin — Capacitor bridge for the Orbbec USB (RGB-D) camera.
 *
 * SCOPE (Phase 5 scaffold):
 *   The USB-host parts that can be real on any Android device with USB-OTG are
 *   implemented for real: enumerate USB devices, filter by the Orbbec vendor id,
 *   and request runtime USB permission via [UsbManager.requestPermission].
 *
 *   The actual frame capture against the Orbbec Android SDK (OBContext /
 *   Pipeline / Config) is STUBBED. Those methods reject with a clear message
 *   until the SDK .aar is dropped into android/app/libs/ and wired up. Every
 *   stub carries a TODO(OrbbecSDK) block describing the real calls so the
 *   on-device integrator can fill them in without re-deriving the API shape.
 *
 * THREADING:
 *   Capacitor invokes @PluginMethod handlers on its own background thread pool,
 *   so blocking USB enumeration here is fine. When the SDK is integrated, the
 *   real open()/capture() work (pipeline start, frame wait) should run off the
 *   main thread too — a Kotlin coroutine on Dispatchers.IO (or the SDK's own
 *   callback thread) is the natural fit; resolve/reject the PluginCall from
 *   that worker. We keep this scaffold synchronous because it does no real I/O.
 */
@CapacitorPlugin(name = "Orbbec")
class OrbbecPlugin : Plugin() {

    companion object {
        /** Permission-result broadcast action, namespaced to this app. */
        const val ACTION_USB_PERMISSION = "dev.sawitulm.palmannotate.USB_PERMISSION"

        /** Orbbec USB vendor id (0x2BC5 == 11205). */
        const val ORBBEC_VENDOR_ID = 0x2BC5
    }

    // ── USB helpers ──────────────────────────────────────────────────────────

    /**
     * Resolve the system [UsbManager]. Returns null if the service is somehow
     * unavailable (e.g. an unusual platform image) so callers can degrade
     * gracefully rather than throw.
     */
    private fun usbManager(): UsbManager? {
        val ctx: Context = context ?: return null
        return ctx.getSystemService(Context.USB_SERVICE) as? UsbManager
    }

    /** All currently-attached USB devices that report the Orbbec vendor id. */
    private fun orbbecDevices(): List<UsbDevice> {
        val mgr = usbManager() ?: return emptyList()
        return try {
            mgr.deviceList.values.filter { it.vendorId == ORBBEC_VENDOR_ID }
        } catch (e: Exception) {
            // deviceList access is defensive — never let enumeration crash a call.
            emptyList()
        }
    }

    // ── isAvailable ──────────────────────────────────────────────────────────

    /**
     * Resolve { available: Boolean } — true when at least one Orbbec-vendor USB
     * device is currently connected. Never throws.
     */
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val available = orbbecDevices().isNotEmpty()
        val ret = JSObject()
        ret.put("available", available)
        call.resolve(ret)
    }

    // ── listDevices ──────────────────────────────────────────────────────────

    /**
     * Resolve { devices: [ { name, vendorId, productId, deviceName,
     * hasPermission } ] } for every attached Orbbec-vendor device.
     */
    @PluginMethod
    fun listDevices(call: PluginCall) {
        val mgr = usbManager()
        val devices = JSArray()
        for (device in orbbecDevices()) {
            val obj = JSObject()
            // productName requires API 21+; fall back to deviceName when absent.
            obj.put("name", device.productName ?: device.deviceName)
            obj.put("vendorId", device.vendorId)
            obj.put("productId", device.productId)
            obj.put("deviceName", device.deviceName)
            obj.put("hasPermission", mgr?.hasPermission(device) ?: false)
            devices.put(obj)
        }
        val ret = JSObject()
        ret.put("devices", devices)
        call.resolve(ret)
    }

    // ── requestPermission ────────────────────────────────────────────────────

    /**
     * Request runtime USB permission for the first attached Orbbec device.
     * Registers a one-shot [BroadcastReceiver] for [ACTION_USB_PERMISSION],
     * fires [UsbManager.requestPermission] with a PendingIntent, and resolves
     * { granted: Boolean } once the system delivers the user's choice.
     *
     * Rejects "No Orbbec device found" when nothing matching is connected.
     */
    @PluginMethod
    fun requestPermission(call: PluginCall) {
        val mgr = usbManager()
        if (mgr == null) {
            call.reject("USB service unavailable on this device")
            return
        }

        val device = orbbecDevices().firstOrNull()
        if (device == null) {
            call.reject("No Orbbec device found")
            return
        }

        // Already granted — short-circuit without prompting again.
        if (mgr.hasPermission(device)) {
            val ret = JSObject()
            ret.put("granted", true)
            call.resolve(ret)
            return
        }

        val ctx: Context = context ?: run {
            call.reject("Plugin context unavailable")
            return
        }

        // One-shot receiver: resolves the call, then unregisters itself.
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action != ACTION_USB_PERMISSION) return
                synchronized(this) {
                    val granted = intent.getBooleanExtra(
                        UsbManager.EXTRA_PERMISSION_GRANTED, false
                    )
                    try {
                        receiverContext.unregisterReceiver(this)
                    } catch (e: IllegalArgumentException) {
                        // Already unregistered — ignore.
                    }
                    val ret = JSObject()
                    ret.put("granted", granted)
                    call.resolve(ret)
                }
            }
        }

        // FLAG_MUTABLE is required so the system can attach EXTRA_PERMISSION_*
        // results on API 31+; FLAG_IMMUTABLE would drop those extras. We OR in
        // the explicit-mutability flag only where the constant exists (API 31+).
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val permissionIntent = PendingIntent.getBroadcast(
            ctx, 0, Intent(ACTION_USB_PERMISSION).setPackage(ctx.packageName), flags
        )

        val filter = IntentFilter(ACTION_USB_PERMISSION)
        // RECEIVER_NOT_EXPORTED is mandatory for runtime receivers on API 34+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }

        mgr.requestPermission(device, permissionIntent)
        // The call is resolved asynchronously by the receiver above.
    }

    // ── open ─────────────────────────────────────────────────────────────────

    /**
     * Open/start the Orbbec pipeline. STUB until the SDK is integrated.
     *
     * TODO(OrbbecSDK): replace the reject below with the real startup sequence:
     *
     *   // 1. Initialise the SDK context (once per process; cache it).
     *   val obContext = OBContext(getContext()) { /* device-changed callback */ }
     *
     *   // 2. Pick the attached device (matched by ORBBEC_VENDOR_ID above) and
     *   //    build a pipeline for it.
     *   val device = obContext.queryDevices().getDevice(0)
     *   val pipeline = Pipeline(device)
     *
     *   // 3. Configure the streams we want — color is required, depth optional.
     *   val config = Config()
     *   val colorProfiles = pipeline.getStreamProfileList(SensorType.COLOR)
     *   config.enableStream(colorProfiles.getVideoStreamProfile(/* w,h,fmt,fps */))
     *   // val depthProfiles = pipeline.getStreamProfileList(SensorType.DEPTH)
     *   // config.enableStream(depthProfiles.getVideoStreamProfile(...))
     *
     *   // 4. Start streaming and keep the pipeline as a field for capture()/close().
     *   pipeline.start(config)
     *
     *   call.resolve(JSObject().put("opened", true))
     *
     * Run the above off the main thread (Dispatchers.IO / SDK callback thread).
     */
    @PluginMethod
    fun open(call: PluginCall) {
        // TODO(OrbbecSDK): initialise OBContext/Pipeline/Config and start streams.
        call.reject("Orbbec SDK not integrated yet")
    }

    // ── capture ──────────────────────────────────────────────────────────────

    /**
     * Grab a single color frame and return it as base64 JPEG. STUB until the
     * SDK is integrated.
     *
     * On success this MUST resolve:
     *   { base64: String, width: Int, height: Int, format: "jpeg" }
     * (optionally a parallel depth payload once depth is enabled in open()).
     *
     * TODO(OrbbecSDK): replace the reject below with the real frame grab:
     *
     *   // Block briefly for the next frameset from the running pipeline.
     *   val frames = pipeline.waitForFrames(100) ?: return call.reject("No frame")
     *   val color = frames.colorFrame ?: return call.reject("No color frame")
     *
     *   // Color frames may be MJPG (already JPEG) or a raw format (RGB888/YUYV)
     *   // that must be encoded to JPEG via Bitmap.compress before base64.
     *   val width = color.width
     *   val height = color.height
     *   val jpegBytes: ByteArray = /* color.data if MJPG, else encode to JPEG */
     *   val base64 = android.util.Base64.encodeToString(
     *       jpegBytes, android.util.Base64.NO_WRAP
     *   )
     *
     *   color.close(); frames.close()
     *   call.resolve(JSObject()
     *       .put("base64", base64)
     *       .put("width", width)
     *       .put("height", height)
     *       .put("format", "jpeg"))
     *
     * Run the wait/encode off the main thread.
     */
    @PluginMethod
    fun capture(call: PluginCall) {
        // TODO(OrbbecSDK): grab one color frame -> JPEG -> base64 and resolve
        // { base64, width, height, format: "jpeg" }.
        call.reject("Orbbec SDK not integrated yet")
    }

    // ── preview lifecycle (stubs) ────────────────────────────────────────────

    /**
     * Start a live preview stream. STUB.
     *
     * TODO(OrbbecSDK): if a separate low-latency preview is desired, push frames
     * to the WebView (e.g. via notifyListeners("orbbecFrame", ...) or a native
     * SurfaceView overlay). Many integrations skip this and reuse capture().
     */
    @PluginMethod
    fun startPreview(call: PluginCall) {
        // TODO(OrbbecSDK): begin pushing preview frames to the JS layer.
        call.reject("Orbbec SDK not integrated yet")
    }

    /**
     * Stop the live preview stream. STUB. Resolves so callers can always tear
     * down cleanly even when preview was never started.
     */
    @PluginMethod
    fun stopPreview(call: PluginCall) {
        // TODO(OrbbecSDK): stop the preview frame pump started in startPreview().
        call.resolve()
    }

    // ── close ────────────────────────────────────────────────────────────────

    /**
     * Stop and release the pipeline / SDK context. STUB. Resolves so the JS
     * layer can call close() unconditionally during teardown.
     *
     * TODO(OrbbecSDK): pipeline?.stop(); pipeline?.close(); obContext?.close();
     * null out the cached fields.
     */
    @PluginMethod
    fun close(call: PluginCall) {
        // TODO(OrbbecSDK): stop/close the pipeline and release the OBContext.
        call.resolve()
    }
}
