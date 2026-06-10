package dev.sawitulm.palmannotate

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.orbbec.obsensor.ColorFrame
import com.orbbec.obsensor.Config
import com.orbbec.obsensor.DepthFrame
import com.orbbec.obsensor.Device
import com.orbbec.obsensor.DeviceChangedCallback
import com.orbbec.obsensor.DeviceList
import com.orbbec.obsensor.FrameSet
import com.orbbec.obsensor.OBContext
import com.orbbec.obsensor.Pipeline
import com.orbbec.obsensor.StreamProfileList
import com.orbbec.obsensor.VideoStreamProfile
import com.orbbec.obsensor.types.AlignMode
import com.orbbec.obsensor.types.Format
import com.orbbec.obsensor.types.FrameAggregateOutputMode
import com.orbbec.obsensor.types.LogSeverity
import com.orbbec.obsensor.types.SensorType
import com.orbbec.obsensor.types.StreamType
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Capacitor bridge for Orbbec USB RGB-D cameras.
 *
 * USB-host discovery and permission are handled with Android's UsbManager. Frame
 * capture is backed by Orbbec's Android SDK wrapper AAR
 * (obsensor_v2.0.6_2026031801_release.aar in android/app/libs). The JS layer
 * receives one color frame per capture as base64 JPEG plus, when available, the
 * synchronized/aligned raw uint16 depth plane for future RGB-D / 4-channel YOLO:
 *   { base64, width, height, format: "jpeg", sourceFormat,
 *     depthBase64, depthWidth, depthHeight, depthFormat, depthValueScale }
 *
 * PalmAnnotate still annotates the RGB JPEG, but stores the depth sidecar with
 * the same tree/side stem so later training can join RGB + D deterministically.
 */
@CapacitorPlugin(name = "Orbbec")
class OrbbecPlugin : Plugin() {

    companion object {
        /** Permission-result broadcast action, namespaced to this app. */
        const val ACTION_USB_PERMISSION = "dev.sawitulm.palmannotate.USB_PERMISSION"

        /** Orbbec USB vendor id (0x2BC5 == 11205). */
        const val ORBBEC_VENDOR_ID = 0x2BC5

        private const val TAG = "PalmAnnotateOrbbec"
        private const val JPEG_QUALITY = 88
        private const val FRAME_TIMEOUT_MS = 1_500L
        private const val DEVICE_QUERY_RETRIES = 8
        private const val DEVICE_QUERY_DELAY_MS = 250L

        // ── Live preview (notifyListeners("orbbecFrame", …)) tuning ──────────────
        /** Minimum gap between emitted RGB preview frames (~12.5 fps) to spare the bridge. */
        private const val PREVIEW_INTERVAL_MS = 80L
        /** Minimum gap between emitted depth-preview frames (~6.25 fps; RGB stays smoother). */
        private const val DEPTH_PREVIEW_INTERVAL_MS = 160L
        /** Longest the colored RGB preview edge may be before JPEG-encoding for the bridge. */
        private const val COLOR_PREVIEW_MAX_DIM = 720
        private const val COLOR_PREVIEW_JPEG_QUALITY = 60
        /** Longest the colorized depth preview edge may be (PiP is small). */
        private const val DEPTH_PREVIEW_MAX_DIM = 288
        private const val DEPTH_PREVIEW_JPEG_QUALITY = 70
        /** Fallback depth colormap window (mm), used only when a frame carries no valid depth. */
        private const val DEPTH_MIN_MM = 250f
        private const val DEPTH_MAX_MM = 6_000f
        /**
         * The live depth preview auto-ranges to each frame's robust valid-depth percentiles
         * (P2–P98) so near/far contrast fills the palette without letting a few noisy pixels
         * dominate, then eases the stored range toward the new frame (EMA) so colours stay
         * stable instead of breathing.
         *
         * EMA is fairly aggressive (≈90% in ~5 frames / 0.4 s) so the palette tracks a
         * panning/approaching scene quickly. A lower value lagged ~1.5 s and left near/far
         * objects mis-coloured (still "blue" when they should already read "yellow").
         */
        private const val DEPTH_RANGE_EMA = 0.40f
        private const val DEPTH_RANGE_PAD = 0.05f
        private const val DEPTH_RANGE_MIN_SPAN_MM = 120f
        private const val DEPTH_RANGE_LOW_PERCENTILE = 0.02f
        private const val DEPTH_RANGE_HIGH_PERCENTILE = 0.98f
        /** Gemini 335L optimal range floor (0.25 m); nearer readings are unstable for display. */
        private const val DEPTH_RANGE_FLOOR_MM = 250f
        /**
         * Depths above the Gemini 335L optimal range plus 1 m (6 m + 1 m = 7 m),
         * along with the 65535 / 0xFFFF sentinel, are treated as noise when AUTO-RANGING
         * the preview colormap. Without this, a handful of stray far/invalid pixels push
         * frameMax toward the theoretical ~65 m range, the span explodes, and the whole
         * scene collapses to the "near" (blue) end of the palette.
         */
        private const val DEPTH_RANGE_CEILING_MM = 7_000f
        /** How long capture() waits for the pump to hand back a full-res frame. */
        private const val CAPTURE_VIA_PUMP_TIMEOUT_MS = 6_000L
    }

    /** One-shot handoff between capture() (waiter) and the streaming pump (filler). */
    private class CaptureWaiter {
        @Volatile var result: CapturedRgbd? = null
        @Volatile var error: Exception? = null
        val latch = CountDownLatch(1)

        fun resolve(r: CapturedRgbd) { result = r; latch.countDown() }
        fun reject(e: Exception) { error = e; latch.countDown() }

        fun await(timeoutMs: Long): CapturedRgbd {
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                throw IllegalStateException("Timed out waiting for Orbbec frame")
            }
            error?.let { throw it }
            return result ?: throw IllegalStateException("No Orbbec frame produced")
        }
    }

    private data class CapturedJpeg(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
        val sourceFormat: String
    )

    private data class CapturedDepth(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
        val sourceFormat: String,
        val valueScale: Float
    )

    private data class CapturedRgbd(
        val color: CapturedJpeg,
        val depth: CapturedDepth?
    )

    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "PalmAnnotate-Orbbec").apply { isDaemon = true }
    }

    private val stateLock = Any()
    private var obContext: OBContext? = null
    private var device: Device? = null
    private var pipeline: Pipeline? = null
    private var selectedUid: String? = null
    private var streaming = false
    private var depthStreaming = false

    // Live-preview pump: a dedicated thread is the SOLE reader of the pipeline
    // while streaming. capture() coordinates through pendingCapture so two threads
    // never call waitForFrameSet() on the same pipeline at once.
    @Volatile private var pumpRunning = false
    private var streamPump: Thread? = null
    private val pendingCapture = AtomicReference<CaptureWaiter?>(null)
    // Smoothed depth-preview colormap range (mm). Touched only on the pump thread;
    // reset to "uninitialised" by startPump so each fresh stream re-adapts.
    private var depthRangeInit = false
    private var depthRangeMinMm = 0f
    private var depthRangeMaxMm = 0f

    private val deviceChangedCallback = object : DeviceChangedCallback {
        override fun onDeviceAttach(deviceList: DeviceList) {
            var count = 0
            try {
                count = deviceList.getDeviceCount()
                Log.i(TAG, "Orbbec device attached ($count device(s))")
            } catch (e: Exception) {
                Log.w(TAG, "onDeviceAttach failed", e)
            } finally {
                safeClose(deviceList, "attach deviceList")
            }
            notifyDeviceChange(true, count)
        }

        override fun onDeviceDetach(deviceList: DeviceList) {
            var detachedSelectedDevice = false
            try {
                val uid = synchronized(stateLock) { selectedUid }
                if (uid != null) {
                    for (i in 0 until deviceList.getDeviceCount()) {
                        if (uid == deviceList.getUid(i)) {
                            detachedSelectedDevice = true
                            break
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "onDeviceDetach failed", e)
                detachedSelectedDevice = true
            } finally {
                safeClose(deviceList, "detach deviceList")
            }

            if (detachedSelectedDevice) {
                // A USB-C PD role switch can make the Orbbec disappear while the
                // preview pump is blocked inside waitForFrameSet(). Do not close
                // the native SDK objects underneath that reader: stop + join the
                // pump first, then release Pipeline/Device/OBContext on the
                // single camera executor. Without this ordering the vendor SDK can
                // race detach cleanup and take the app process down instead of
                // surfacing a normal "camera disconnected" state to JS.
                stopPump()
                cameraExecutor.execute {
                    joinPump()
                    synchronized(stateLock) {
                        closeSdkLocked()
                    }
                }
            }
            notifyDeviceChange(false, 0)
        }
    }

    /** Tell JS the USB device set changed so the UI can re-scan sources. */
    private fun notifyDeviceChange(attached: Boolean, count: Int) {
        try {
            notifyListeners(
                "orbbecDeviceChange",
                JSObject().put("attached", attached).put("count", count)
            )
        } catch (e: Exception) {
            Log.d(TAG, "notifyDeviceChange ignored", e)
        }
    }

    // ── USB hotplug receiver (cold-plug detection + SDK pre-warm) ────────────
    //
    // The Orbbec SDK's DeviceChangedCallback only exists once an OBContext has
    // been created — i.e. after the first successful open()/startPreview(). Before
    // that the app was BLIND to USB attach: a freshly plugged camera was only
    // found by manually spamming "Find camera" (operator report: ~2 minutes of
    // open/close/rescan before the source appeared). This plain Android receiver
    // is registered at plugin load, needs no SDK context, and on attach both
    // notifies JS (the capture surface rebuilds its source list immediately) and
    // pre-warms the SDK context in the background so the subsequent
    // open()/startPreview() skips the slow OBContext init + enumeration wait.

    private var usbHotplugReceiver: BroadcastReceiver? = null

    override fun load() {
        super.load()
        registerUsbHotplugReceiver()
    }

    private fun registerUsbHotplugReceiver() {
        val ctx: Context = context ?: return
        if (usbHotplugReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                val device: UsbDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                }
                if (device == null || device.vendorId != ORBBEC_VENDOR_ID) return
                when (intent.action) {
                    UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                        Log.i(TAG, "USB attach: ${device.deviceName} — pre-warming SDK")
                        warmUpSdk()
                        notifyDeviceChange(true, orbbecDevices().size)
                    }
                    UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                        Log.i(TAG, "USB detach: ${device.deviceName}")
                        val remaining = orbbecDevices().size
                        if (remaining == 0) {
                            // Covers the case where the SDK callback never fires
                            // (no OBContext yet) — idempotent with that teardown.
                            stopPump()
                            cameraExecutor.execute {
                                joinPump()
                                synchronized(stateLock) { closeSdkLocked() }
                            }
                        }
                        notifyDeviceChange(false, remaining)
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        // System (protected) broadcasts reach NOT_EXPORTED receivers on API 33+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
        usbHotplugReceiver = receiver
    }

    private fun unregisterUsbHotplugReceiver() {
        val receiver = usbHotplugReceiver ?: return
        usbHotplugReceiver = null
        try {
            context?.unregisterReceiver(receiver)
        } catch (e: Exception) {
            Log.d(TAG, "hotplug unregister ignored", e)
        }
    }

    /**
     * Create the OBContext in the background (camera executor) if permission is
     * already granted, so a later open()/startPreview() finds the SDK initialised
     * and the device already enumerated instead of paying ~seconds of cold init
     * while the operator stares at "Connecting to Orbbec…". Best-effort: any
     * failure just falls back to the lazy init inside openSdkLocked().
     */
    private fun warmUpSdk() {
        cameraExecutor.execute {
            try {
                val mgr = usbManager() ?: return@execute
                val devices = orbbecDevices()
                if (devices.isEmpty() || devices.none { mgr.hasPermission(it) }) return@execute
                val appContext = context?.applicationContext ?: return@execute
                synchronized(stateLock) {
                    if (obContext == null) {
                        OBContext.setLoggerSeverity(LogSeverity.INFO)
                        OBContext.setLoggerToConsole(LogSeverity.INFO)
                        obContext = OBContext(appContext, deviceChangedCallback)
                        Log.i(TAG, "Orbbec SDK pre-warmed (core ${OBContext.getCoreVersionName()})")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "SDK pre-warm failed (will init lazily)", e)
            }
        }
    }

    // ── USB helpers ──────────────────────────────────────────────────────────

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
            Log.w(TAG, "USB enumeration failed", e)
            emptyList()
        }
    }

    private fun requireUsbPermission() {
        val mgr = usbManager() ?: throw IllegalStateException("USB service unavailable on this device")
        val devices = orbbecDevices()
        if (devices.isEmpty()) throw IllegalStateException("No Orbbec device found")
        if (devices.none { mgr.hasPermission(it) }) {
            throw SecurityException("USB permission not granted for the Orbbec camera")
        }
    }

    // ── isAvailable ──────────────────────────────────────────────────────────

    /** Resolve { available: Boolean } for attached Orbbec-vendor USB devices. */
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val ret = JSObject()
        ret.put("available", orbbecDevices().isNotEmpty())
        call.resolve(ret)
    }

    // ── listDevices ──────────────────────────────────────────────────────────

    /** Resolve attached Orbbec devices and current Android USB permission state. */
    @PluginMethod
    fun listDevices(call: PluginCall) {
        val mgr = usbManager()
        val devices = JSArray()
        for (device in orbbecDevices()) {
            val obj = JSObject()
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

    /** Request Android USB permission for the first attached Orbbec device. */
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

        if (mgr.hasPermission(device)) {
            call.resolve(JSObject().put("granted", true))
            return
        }

        val ctx: Context = context ?: run {
            call.reject("Plugin context unavailable")
            return
        }

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
                    call.resolve(JSObject().put("granted", granted))
                }
            }
        }

        // FLAG_MUTABLE is required so Android can attach EXTRA_PERMISSION_* on
        // API 31+; FLAG_IMMUTABLE would drop those extras.
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val permissionIntent = PendingIntent.getBroadcast(
            ctx, 0, Intent(ACTION_USB_PERMISSION).setPackage(ctx.packageName), flags
        )

        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }

        mgr.requestPermission(device, permissionIntent)
    }

    // ── open / capture / preview / close ─────────────────────────────────────

    /** Initialise OBContext, open the first Orbbec color stream, and keep it hot. */
    @PluginMethod
    fun open(call: PluginCall) {
        cameraExecutor.execute {
            try {
                val info = synchronized(stateLock) { openSdkLocked() }
                call.resolve(info)
            } catch (e: Exception) {
                Log.e(TAG, "open failed", e)
                call.reject(e.message ?: "Failed to open Orbbec camera")
            }
        }
    }

    /** Grab one color frame from the running Pipeline and return it as JPEG. */
    @PluginMethod
    fun capture(call: PluginCall) {
        cameraExecutor.execute {
            try {
                synchronized(stateLock) { openSdkLocked() }
                // While the live pump owns the pipeline, let it hand back the next
                // full-res frameset instead of reading the pipeline concurrently.
                // If stopPreview() just ran, pumpRunning is already false but the
                // old thread may still be unwinding out of waitForFrameSet(); join
                // it before doing a direct capture so the SDK never has two readers.
                val frame = if (pumpRunning) {
                    captureViaPump()
                } else {
                    joinPump()
                    captureRgbd()
                }
                val ret = JSObject()
                ret.put("base64", Base64.encodeToString(frame.color.bytes, Base64.NO_WRAP))
                ret.put("width", frame.color.width)
                ret.put("height", frame.color.height)
                ret.put("format", "jpeg")
                ret.put("sourceFormat", frame.color.sourceFormat)
                val depth = frame.depth
                ret.put("hasDepth", depth != null)
                if (depth != null) {
                    ret.put("depthBase64", Base64.encodeToString(depth.bytes, Base64.NO_WRAP))
                    ret.put("depthWidth", depth.width)
                    ret.put("depthHeight", depth.height)
                    ret.put("depthFormat", depth.sourceFormat)
                    ret.put("depthValueScale", depth.valueScale.toDouble())
                    ret.put("depthEncoding", "uint16le")
                    ret.put("depthUnit", "mm")
                    ret.put("depthAlignedTo", "color")
                    ret.put("depthDisplayFloorMm", DEPTH_RANGE_FLOOR_MM.toDouble())
                    ret.put("depthDisplayCeilingMm", DEPTH_RANGE_CEILING_MM.toDouble())
                }
                call.resolve(ret)
            } catch (e: Exception) {
                Log.e(TAG, "capture failed", e)
                call.reject(e.message ?: "Failed to capture Orbbec frame")
            }
        }
    }

    /**
     * Start the live preview pump: open the pipeline and spin up the streaming
     * thread that emits throttled, downscaled RGB + colorized-depth frames to JS
     * via notifyListeners("orbbecFrame", …).
     */
    @PluginMethod
    fun startPreview(call: PluginCall) {
        cameraExecutor.execute {
            try {
                // A previous stopPreview()/detach may have signalled the pump but
                // not yet observed its exit. Join first so a fresh preview never
                // races an old waitForFrameSet() reader on the same pipeline.
                joinPump()
                synchronized(stateLock) { openSdkLocked() }
                startPump()
                call.resolve(JSObject().put("streaming", true))
            } catch (e: Exception) {
                Log.e(TAG, "startPreview failed", e)
                call.reject(e.message ?: "Failed to start Orbbec preview")
            }
        }
    }

    /** Stop the live preview pump. The pipeline stays open for a following capture. */
    @PluginMethod
    fun stopPreview(call: PluginCall) {
        stopPump()
        cameraExecutor.execute {
            joinPump()
            call.resolve(JSObject().put("stopped", true))
        }
    }

    /** Stop/release the Pipeline, Device and OBContext. */
    @PluginMethod
    fun close(call: PluginCall) {
        stopPump()
        cameraExecutor.execute {
            joinPump()
            synchronized(stateLock) { closeSdkLocked() }
            call.resolve(JSObject().put("closed", true))
        }
    }

    /**
     * Re-enumerate the USB bus. When the bus is EMPTY, drop any stale SDK context
     * so a later re-plug starts clean (the original "unplug → replug never found"
     * fix). When a device IS present, the context is healthy (detach teardown
     * already ran via the hotplug receiver / SDK callback), so keep it and just
     * pre-warm — tearing a live context down here made every "Find camera" press
     * pay the full multi-second SDK re-init, which is why the operator had to
     * spam the button. Resolves { available, count } for the live bus.
     */
    @PluginMethod
    fun refresh(call: PluginCall) {
        cameraExecutor.execute {
            val devices = orbbecDevices()
            if (devices.isEmpty()) {
                synchronized(stateLock) { pumpRunning = false }
                pendingCapture.getAndSet(null)?.reject(IllegalStateException("Orbbec preview stopped"))
                joinPump()
                synchronized(stateLock) { closeSdkLocked() }
            } else {
                warmUpSdk()
            }
            call.resolve(
                JSObject()
                    .put("available", devices.isNotEmpty())
                    .put("count", devices.size)
            )
        }
    }

    override fun handleOnDestroy() {
        unregisterUsbHotplugReceiver()
        stopPump()
        try {
            cameraExecutor.execute {
                joinPump()
                synchronized(stateLock) { closeSdkLocked() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "cleanup dispatch failed", e)
        }
        cameraExecutor.shutdown()
        super.handleOnDestroy()
    }

    // ── Live preview pump ────────────────────────────────────────────────────

    /** Start the streaming thread (idempotent). */
    private fun startPump() {
        synchronized(stateLock) {
            if (pumpRunning) return
            pumpRunning = true
            depthRangeInit = false
            val thread = Thread({ runPump() }, "PalmAnnotate-OrbbecPump").apply { isDaemon = true }
            streamPump = thread
            thread.start()
        }
    }

    /**
     * Signal the streaming thread to stop and fail any in-flight capture handoff.
     * Does NOT wait for the thread to exit — safe to call from the main thread
     * (stopPreview) since it leaves the pipeline open. Teardown paths that close
     * the pipeline must additionally joinPump() so the close can't race a read.
     */
    private fun stopPump() {
        synchronized(stateLock) { pumpRunning = false }
        pendingCapture.getAndSet(null)?.reject(IllegalStateException("Orbbec preview stopped"))
        synchronized(stateLock) { streamPump }?.let { try { it.interrupt() } catch (_: Exception) {} }
    }

    /**
     * Wait (bounded) for the pump thread to exit so the pipeline can be closed
     * without a concurrent waitForFrameSet(). Must run OFF the stateLock (the pump
     * briefly takes it each iteration) and OFF the main thread — call it from the
     * cameraExecutor only.
     */
    private fun joinPump() {
        synchronized(stateLock) { pumpRunning = false }
        val thread = synchronized(stateLock) { streamPump }
        if (thread != null && thread.isAlive) {
            try { thread.interrupt() } catch (_: Exception) {}
            try {
                thread.join(FRAME_TIMEOUT_MS + 1_000L)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        synchronized(stateLock) { if (streamPump === thread) streamPump = null }
    }

    /**
     * Streaming loop: the SOLE reader of the pipeline while running. Each frameset
     * fulfils a pending full-res capture (if any) and, throttled, emits a small
     * RGB + colorized-depth preview to JS.
     */
    private fun runPump() {
        var lastPreview = 0L
        var lastDepthPreview = 0L
        while (pumpRunning) {
            val activePipeline = synchronized(stateLock) { pipeline }
            if (activePipeline == null) break

            var frameSet: FrameSet? = null
            var colorFrame: ColorFrame? = null
            var depthFrame: DepthFrame? = null
            try {
                frameSet = activePipeline.waitForFrameSet(FRAME_TIMEOUT_MS)
                if (frameSet == null) continue
                colorFrame = frameSet.getColorFrame()
                depthFrame = frameSet.getDepthFrame()

                // Hand a full-resolution frame to a waiting capture() call.
                val waiter = pendingCapture.getAndSet(null)
                if (waiter != null) {
                    try {
                        val color = colorFrame ?: throw IllegalStateException("No color frame")
                        val depth = depthFrame?.let { runCatching { encodeDepthFrame(it) }.getOrNull() }
                        waiter.resolve(CapturedRgbd(encodeColorFrame(color), depth))
                    } catch (e: Exception) {
                        waiter.reject(e)
                    }
                }

                // Throttled, downscaled preview push. RGB stays responsive while the
                // heavier depth colorize/JPEG/base64 path updates at a lower rate.
                val now = System.currentTimeMillis()
                if (now - lastPreview >= PREVIEW_INTERVAL_MS) {
                    val includeDepth = now - lastDepthPreview >= DEPTH_PREVIEW_INTERVAL_MS
                    lastPreview = now
                    if (includeDepth) lastDepthPreview = now
                    emitPreview(colorFrame, if (includeDepth) depthFrame else null)
                }
            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "pump iteration failed", e)
                pendingCapture.getAndSet(null)?.reject(e)
            } finally {
                safeClose(depthFrame, "pump depth frame")
                safeClose(colorFrame, "pump color frame")
                safeClose(frameSet, "pump frameSet")
            }
        }
    }

    /** Block on the pump producing the next full-res frame for capture(). */
    private fun captureViaPump(): CapturedRgbd {
        if (!pumpRunning) return captureRgbd()
        val waiter = CaptureWaiter()
        pendingCapture.set(waiter)
        return waiter.await(CAPTURE_VIA_PUMP_TIMEOUT_MS)
    }

    /** Encode + emit one preview frame (best-effort; never throws). */
    private fun emitPreview(colorFrame: ColorFrame?, depthFrame: DepthFrame?) {
        try {
            val event = JSObject()
            var any = false
            if (colorFrame != null) {
                val rgb = runCatching { encodeColorPreviewBase64(colorFrame) }.getOrNull()
                if (rgb != null) {
                    event.put("rgb", rgb)
                    event.put("width", colorFrame.getWidth())
                    event.put("height", colorFrame.getHeight())
                    any = true
                }
            }
            if (depthFrame != null) {
                val depth = runCatching { encodeDepthPreviewBase64(depthFrame) }.getOrNull()
                if (depth != null) {
                    event.put("depth", depth)
                    event.put("depthWidth", depthFrame.getWidth())
                    event.put("depthHeight", depthFrame.getHeight())
                    any = true
                }
            }
            if (any) notifyListeners("orbbecFrame", event)
        } catch (e: Exception) {
            Log.w(TAG, "emitPreview failed", e)
        }
    }

    // ── SDK lifecycle internals ──────────────────────────────────────────────

    private fun openSdkLocked(): JSObject {
        if (streaming && pipeline != null) {
            return JSObject()
                .put("opened", true)
                .put("alreadyOpen", true)
                .put("uid", selectedUid ?: "")
        }

        requireUsbPermission()

        val appContext = context?.applicationContext
            ?: throw IllegalStateException("Plugin context unavailable")

        if (obContext == null) {
            OBContext.setLoggerSeverity(LogSeverity.INFO)
            OBContext.setLoggerToConsole(LogSeverity.INFO)
            obContext = OBContext(appContext, deviceChangedCallback)
            Log.i(TAG, "Orbbec SDK core ${OBContext.getCoreVersionName()} initialised")
        }

        val deviceList = queryDevicesWithRetry(obContext!!)
        var openedDevice: Device? = null
        var openedPipeline: Pipeline? = null
        var config: Config? = null
        var selectedProfile: VideoStreamProfile? = null
        var selectedDepthProfile: VideoStreamProfile? = null
        var name = "Orbbec camera"
        var width = 0
        var height = 0
        var fps = 0
        var sourceFormat = "default"
        var depthWidth = 0
        var depthHeight = 0
        var depthFps = 0
        var depthFormat = "none"
        var depthEnabled = false

        try {
            val count = deviceList.getDeviceCount()
            if (count <= 0) throw IllegalStateException("No Orbbec device visible to SDK")

            var index = 0
            for (i in 0 until count) {
                if (deviceList.getVid(i) == ORBBEC_VENDOR_ID) {
                    index = i
                    break
                }
            }

            val uid = deviceList.getUid(index) ?: ""
            openedDevice = deviceList.getDevice(index)
                ?: throw IllegalStateException("Failed to open Orbbec device")

            val info = openedDevice.getInfo()
            name = info?.getName() ?: name

            val colorSensor = openedDevice.getSensor(SensorType.COLOR)
            if (colorSensor == null) throw IllegalStateException("Orbbec device has no color sensor")
            val depthSensor = openedDevice.getSensor(SensorType.DEPTH)

            openedPipeline = Pipeline(openedDevice)
            config = Config()
            selectedProfile = chooseColorProfile(openedPipeline)
            if (selectedProfile != null) {
                width = selectedProfile.getWidth()
                height = selectedProfile.getHeight()
                fps = selectedProfile.getFps()
                sourceFormat = selectedProfile.getFormat().name
                config.enableStream(selectedProfile)
            } else {
                config.enableStream(SensorType.COLOR)
            }

            if (depthSensor != null) {
                try {
                    selectedDepthProfile = chooseDepthProfile(openedPipeline)
                    if (selectedDepthProfile != null) {
                        depthWidth = selectedDepthProfile.getWidth()
                        depthHeight = selectedDepthProfile.getHeight()
                        depthFps = selectedDepthProfile.getFps()
                        depthFormat = selectedDepthProfile.getFormat().name
                        config.enableStream(selectedDepthProfile)
                    } else {
                        config.enableStream(SensorType.DEPTH)
                        depthFormat = "default"
                    }
                    // Prefer D2C so the stored depth sidecar is geometrically useful
                    // with the RGB JPEG for later RGB-D/4-channel YOLO training.
                    try { config.setAlignMode(AlignMode.ALIGN_D2C_SW_MODE) } catch (e: Exception) {
                        Log.w(TAG, "software D2C align unavailable; using raw depth geometry", e)
                    }
                    try { config.setDepthScaleRequire(true) } catch (_: Exception) {}
                    try { config.setFrameAggregateOutputMode(FrameAggregateOutputMode.OB_FRAME_AGGREGATE_OUTPUT_ALL_TYPE_FRAME_REQUIRE) } catch (_: Exception) {}
                    depthEnabled = true
                } catch (e: Exception) {
                    Log.w(TAG, "Depth stream setup failed; continuing RGB-only", e)
                    safeClose(selectedDepthProfile, "selected depth profile")
                    selectedDepthProfile = null
                    depthWidth = 0
                    depthHeight = 0
                    depthFps = 0
                    depthFormat = "none"
                    depthEnabled = false
                } finally {
                    safeClose(depthSensor, "depth sensor")
                }
            }

            openedPipeline.start(config)
            streaming = true
            depthStreaming = depthEnabled
            device = openedDevice
            pipeline = openedPipeline
            selectedUid = uid
            openedDevice = null
            openedPipeline = null

            return JSObject()
                .put("opened", true)
                .put("alreadyOpen", false)
                .put("uid", uid)
                .put("name", name)
                .put("width", width)
                .put("height", height)
                .put("fps", fps)
                .put("sourceFormat", sourceFormat)
                .put("depthEnabled", depthEnabled)
                .put("depthWidth", depthWidth)
                .put("depthHeight", depthHeight)
                .put("depthFps", depthFps)
                .put("depthFormat", depthFormat)
        } finally {
            safeClose(selectedProfile, "selected color profile")
            safeClose(selectedDepthProfile, "selected depth profile")
            safeClose(config, "config")
            safeClose(deviceList, "query deviceList")
            // These are non-null only if start/configuration failed before the
            // fields above were promoted to plugin state.
            safeStopAndClose(openedPipeline)
            safeClose(openedDevice, "device")
        }
    }

    private fun queryDevicesWithRetry(ctx: OBContext): DeviceList {
        var lastList: DeviceList? = null
        for (attempt in 0 until DEVICE_QUERY_RETRIES) {
            val list = ctx.queryDevices()
            if (list.getDeviceCount() > 0) {
                safeClose(lastList, "empty deviceList")
                return list
            }
            safeClose(lastList, "empty deviceList")
            lastList = list
            try {
                Thread.sleep(DEVICE_QUERY_DELAY_MS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
        }
        return lastList ?: ctx.queryDevices()
    }

    private fun chooseColorProfile(pipeline: Pipeline): VideoStreamProfile? {
        val profileList: StreamProfileList = pipeline.getStreamProfileList(SensorType.COLOR)
            ?: return null
        val profiles = ArrayList<VideoStreamProfile>()
        try {
            for (i in 0 until profileList.getCount()) {
                val profile: VideoStreamProfile = profileList.getProfile(i).`as`(StreamType.VIDEO)
                val width = profile.getWidth()
                val height = profile.getHeight()
                val format = profile.getFormat()
                if (width >= 640 && height >= 360 && isCapturableColorFormat(format)) {
                    profiles.add(profile)
                } else {
                    safeClose(profile, "unused color profile")
                }
            }
        } finally {
            safeClose(profileList, "color profileList")
        }

        if (profiles.isEmpty()) return null

        profiles.sortWith(
            compareBy<VideoStreamProfile> { colorFormatPriority(it.getFormat()) }
                .thenBy { kotlin.math.abs(it.getWidth() - 1280) }
                .thenByDescending { it.getFps() }
                .thenByDescending { it.getWidth() * it.getHeight() }
        )

        val selected = profiles.first()
        for (profile in profiles.drop(1)) {
            safeClose(profile, "unselected color profile")
        }
        Log.i(
            TAG,
            "Selected color profile ${selected.getWidth()}x${selected.getHeight()}@${selected.getFps()} ${selected.getFormat()}"
        )
        return selected
    }

    private fun chooseDepthProfile(pipeline: Pipeline): VideoStreamProfile? {
        val profileList: StreamProfileList = pipeline.getStreamProfileList(SensorType.DEPTH)
            ?: return null
        val profiles = ArrayList<VideoStreamProfile>()
        try {
            for (i in 0 until profileList.getCount()) {
                val profile: VideoStreamProfile = profileList.getProfile(i).`as`(StreamType.VIDEO)
                val width = profile.getWidth()
                val height = profile.getHeight()
                val format = profile.getFormat()
                if (width >= 320 && height >= 240 && isCapturableDepthFormat(format)) {
                    profiles.add(profile)
                } else {
                    safeClose(profile, "unused depth profile")
                }
            }
        } finally {
            safeClose(profileList, "depth profileList")
        }

        if (profiles.isEmpty()) return null

        profiles.sortWith(
            compareBy<VideoStreamProfile> { depthFormatPriority(it.getFormat()) }
                .thenBy { kotlin.math.abs(it.getWidth() - 1280) }
                .thenByDescending { it.getFps() }
                .thenByDescending { it.getWidth() * it.getHeight() }
        )

        val selected = profiles.first()
        for (profile in profiles.drop(1)) {
            safeClose(profile, "unselected depth profile")
        }
        Log.i(
            TAG,
            "Selected depth profile ${selected.getWidth()}x${selected.getHeight()}@${selected.getFps()} ${selected.getFormat()}"
        )
        return selected
    }

    private fun closeSdkLocked() {
        val oldPipeline = pipeline
        val oldDevice = device
        val oldContext = obContext

        pipeline = null
        device = null
        obContext = null
        selectedUid = null
        streaming = false
        depthStreaming = false
        // The pump loop reads `pipeline` under stateLock each iteration, so nulling
        // it here also breaks the loop (belt-and-braces with stopPump/joinPump).
        pumpRunning = false
        pendingCapture.getAndSet(null)?.reject(IllegalStateException("Orbbec camera closed"))

        safeStopAndClose(oldPipeline)
        safeClose(oldDevice, "device")
        safeClose(oldContext, "OBContext")
    }

    // ── Frame capture / encoding ─────────────────────────────────────────────

    private fun captureRgbd(): CapturedRgbd {
        val activePipeline = synchronized(stateLock) {
            pipeline ?: throw IllegalStateException("Orbbec pipeline is not open")
        }
        val wantDepth = synchronized(stateLock) { depthStreaming }

        var lastError: Exception? = null
        for (attempt in 0 until 3) {
            var frameSet: FrameSet? = null
            var colorFrame: ColorFrame? = null
            var depthFrame: DepthFrame? = null
            try {
                frameSet = activePipeline.waitForFrameSet(FRAME_TIMEOUT_MS)
                if (frameSet == null) continue
                colorFrame = frameSet.getColorFrame()
                if (colorFrame == null) continue
                depthFrame = frameSet.getDepthFrame()
                if (wantDepth && depthFrame == null) {
                    Log.w(TAG, "capture attempt ${attempt + 1} had RGB but no depth frame")
                    continue
                }
                val color = encodeColorFrame(colorFrame)
                val depth = depthFrame?.let { encodeDepthFrame(it) }
                return CapturedRgbd(color, depth)
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "capture attempt ${attempt + 1} failed", e)
            } finally {
                safeClose(depthFrame, "depth frame")
                safeClose(colorFrame, "color frame")
                safeClose(frameSet, "frameSet")
            }
        }

        throw IllegalStateException(lastError?.message ?: "No Orbbec RGB-D frame received")
    }

    private fun encodeColorFrame(frame: ColorFrame): CapturedJpeg {
        val width = frame.getWidth()
        val height = frame.getHeight()
        if (width <= 0 || height <= 0) throw IllegalStateException("Invalid Orbbec frame size")

        val format = frame.getFormat()
        val size = frame.getDataSize()
        if (size <= 0) throw IllegalStateException("Empty Orbbec frame")

        val raw = ByteArray(size)
        val copied = frame.getData(raw)
        if (copied < 0) throw IllegalStateException("Failed to copy Orbbec frame data")
        val data = if (copied in 0 until raw.size) raw.copyOf(copied) else raw

        val jpeg = when (format) {
            Format.MJPG -> data
            Format.RGB -> packedRgbToJpeg(data, width, height, PixelOrder.RGB)
            Format.BGR -> packedRgbToJpeg(data, width, height, PixelOrder.BGR)
            Format.RGBA -> packedRgbToJpeg(data, width, height, PixelOrder.RGBA)
            Format.BGRA -> packedRgbToJpeg(data, width, height, PixelOrder.BGRA)
            Format.YUYV, Format.YUY2 -> yuvImageToJpeg(data, ImageFormat.YUY2, width, height)
            Format.NV21 -> yuvImageToJpeg(data, ImageFormat.NV21, width, height)
            Format.NV12 -> yuvImageToJpeg(nv12ToNv21(data, width, height), ImageFormat.NV21, width, height)
            Format.UYVY -> yuv422ToJpeg(data, width, height, uyvy = true)
            Format.I420 -> i420ToJpeg(data, width, height)
            else -> throw IllegalStateException("Unsupported Orbbec color frame format: $format")
        }

        return CapturedJpeg(jpeg, width, height, format.name)
    }

    private enum class PixelOrder { RGB, BGR, RGBA, BGRA }

    private fun packedRgbToJpeg(data: ByteArray, width: Int, height: Int, order: PixelOrder): ByteArray {
        val pixelCount = width * height
        val stride = if (order == PixelOrder.RGBA || order == PixelOrder.BGRA) 4 else 3
        if (data.size < pixelCount * stride) {
            throw IllegalStateException("Short ${order.name} frame: ${data.size} bytes")
        }

        val pixels = IntArray(pixelCount)
        var src = 0
        for (i in 0 until pixelCount) {
            val r: Int
            val g: Int
            val b: Int
            when (order) {
                PixelOrder.RGB -> {
                    r = data[src].u8(); g = data[src + 1].u8(); b = data[src + 2].u8()
                }
                PixelOrder.BGR -> {
                    b = data[src].u8(); g = data[src + 1].u8(); r = data[src + 2].u8()
                }
                PixelOrder.RGBA -> {
                    r = data[src].u8(); g = data[src + 1].u8(); b = data[src + 2].u8()
                }
                PixelOrder.BGRA -> {
                    b = data[src].u8(); g = data[src + 1].u8(); r = data[src + 2].u8()
                }
            }
            pixels[i] = argb(r, g, b)
            src += stride
        }
        return pixelsToJpeg(pixels, width, height)
    }

    private fun yuvImageToJpeg(data: ByteArray, imageFormat: Int, width: Int, height: Int): ByteArray {
        val yuv = YuvImage(data, imageFormat, width, height, null)
        val out = ByteArrayOutputStream()
        val ok = yuv.compressToJpeg(Rect(0, 0, width, height), JPEG_QUALITY, out)
        if (!ok) throw IllegalStateException("Failed to encode YUV Orbbec frame")
        return out.toByteArray()
    }

    private fun nv12ToNv21(data: ByteArray, width: Int, height: Int): ByteArray {
        val ySize = width * height
        if (data.size < ySize) throw IllegalStateException("Short NV12 frame: ${data.size} bytes")
        val out = data.copyOf()
        var i = ySize
        while (i + 1 < out.size) {
            val u = out[i]
            out[i] = out[i + 1]
            out[i + 1] = u
            i += 2
        }
        return out
    }

    private fun yuv422ToJpeg(data: ByteArray, width: Int, height: Int, uyvy: Boolean): ByteArray {
        val pixelCount = width * height
        if (data.size < pixelCount * 2) throw IllegalStateException("Short YUV422 frame: ${data.size} bytes")
        val pixels = IntArray(pixelCount)
        var src = 0
        var dst = 0
        while (dst < pixelCount && src + 3 < data.size) {
            val y0: Int
            val y1: Int
            val u: Int
            val v: Int
            if (uyvy) {
                u = data[src].u8(); y0 = data[src + 1].u8(); v = data[src + 2].u8(); y1 = data[src + 3].u8()
            } else {
                y0 = data[src].u8(); u = data[src + 1].u8(); y1 = data[src + 2].u8(); v = data[src + 3].u8()
            }
            pixels[dst++] = yuvToArgb(y0, u, v)
            if (dst < pixelCount) pixels[dst++] = yuvToArgb(y1, u, v)
            src += 4
        }
        return pixelsToJpeg(pixels, width, height)
    }

    private fun i420ToJpeg(data: ByteArray, width: Int, height: Int): ByteArray {
        val pixelCount = width * height
        val chromaWidth = (width + 1) / 2
        val chromaHeight = (height + 1) / 2
        val uOffset = pixelCount
        val vOffset = uOffset + chromaWidth * chromaHeight
        if (data.size < vOffset + chromaWidth * chromaHeight) {
            throw IllegalStateException("Short I420 frame: ${data.size} bytes")
        }

        val pixels = IntArray(pixelCount)
        for (y in 0 until height) {
            for (x in 0 until width) {
                val yValue = data[y * width + x].u8()
                val uvIndex = (y / 2) * chromaWidth + (x / 2)
                val u = data[uOffset + uvIndex].u8()
                val v = data[vOffset + uvIndex].u8()
                pixels[y * width + x] = yuvToArgb(yValue, u, v)
            }
        }
        return pixelsToJpeg(pixels, width, height)
    }

    private fun encodeDepthFrame(frame: DepthFrame): CapturedDepth {
        val width = frame.getWidth()
        val height = frame.getHeight()
        if (width <= 0 || height <= 0) throw IllegalStateException("Invalid Orbbec depth frame size")

        val format = frame.getFormat()
        val size = frame.getDataSize()
        if (size <= 0) throw IllegalStateException("Empty Orbbec depth frame")

        val raw = ByteArray(size)
        val copied = frame.getData(raw)
        if (copied < 0) throw IllegalStateException("Failed to copy Orbbec depth frame data")
        val data = if (copied in 0 until raw.size) raw.copyOf(copied) else raw
        val y16 = when (format) {
            Format.Y16, Format.Y10, Format.Y11, Format.Y12 -> data
            else -> throw IllegalStateException("Unsupported Orbbec depth frame format: $format")
        }
        return CapturedDepth(y16, width, height, format.name, frame.getValueScale())
    }

    // ── Live preview encoders (downscaled, cheap for the JS bridge) ──────────

    /** Encode a downscaled JPEG preview of the color frame as base64. */
    private fun encodeColorPreviewBase64(frame: ColorFrame): String {
        val jpeg = encodeColorFrame(frame).bytes
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        val srcMax = maxOf(bounds.outWidth, bounds.outHeight)
        val opts = BitmapFactory.Options()
        if (srcMax > COLOR_PREVIEW_MAX_DIM) opts.inSampleSize = sampleSizeFor(srcMax, COLOR_PREVIEW_MAX_DIM)
        val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, opts)
            ?: return Base64.encodeToString(jpeg, Base64.NO_WRAP) // fall back to full JPEG
        return try {
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, COLOR_PREVIEW_JPEG_QUALITY, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
            bmp.recycle()
        }
    }

    /** Largest power-of-two sample size that keeps the longest edge >= target. */
    private fun sampleSizeFor(srcMax: Int, target: Int): Int {
        var sample = 1
        while (srcMax / (sample * 2) >= target) sample *= 2
        return sample
    }

    /** Encode a subsampled, colorized JPEG preview of the depth field as base64. */
    private fun encodeDepthPreviewBase64(frame: DepthFrame): String? {
        val width = frame.getWidth()
        val height = frame.getHeight()
        if (width <= 0 || height <= 0) return null
        val size = frame.getDataSize()
        if (size <= 0) return null
        val raw = ByteArray(size)
        val copied = frame.getData(raw)
        if (copied <= 0) return null
        val data = if (copied in 1 until raw.size) raw.copyOf(copied) else raw
        if (data.size < width * height * 2) return null
        val scale = frame.getValueScale()

        val step = maxOf(1, maxOf(width, height) / DEPTH_PREVIEW_MAX_DIM)
        val outW = (width + step - 1) / step
        val outH = (height + step - 1) / step
        if (outW <= 0 || outH <= 0) return null

        // Pass 1: subsample the depth plane into a mm grid and collect plausible
        // display depths. The colormap uses robust P2–P98 percentiles instead of
        // raw min/max so a few edge/noise pixels do not dominate the palette.
        val mmGrid = FloatArray(outW * outH)
        val validMm = FloatArray(outW * outH)
        var validCount = 0
        var di = 0
        var y = 0
        while (y < height && di < mmGrid.size) {
            var x = 0
            while (x < width && di < mmGrid.size) {
                val idx = (y * width + x) * 2
                val v = (data[idx].toInt() and 0xFF) or ((data[idx + 1].toInt() and 0xFF) shl 8)
                val mm = v * scale
                mmGrid[di++] = mm
                // Range only over plausible optimal-window depths so near/far/sentinel
                // noise cannot blow up the colormap span and wash the scene to blue.
                if (isPlausiblePreviewDepth(mm)) validMm[validCount++] = mm
                x += step
            }
            y += step
        }
        val filled = di

        // EMA-smooth the robust auto-range so colours stay stable as the scene moves;
        // fall back to the fixed window only when a frame has no valid depth at all.
        val lo: Float
        val hi: Float
        if (validCount > 0) {
            validMm.sort(0, validCount)
            val frameMin = percentile(validMm, validCount, DEPTH_RANGE_LOW_PERCENTILE)
            val frameMax = percentile(validMm, validCount, DEPTH_RANGE_HIGH_PERCENTILE)
            val r = smoothDepthRange(frameMin, frameMax)
            lo = r.first; hi = r.second
        } else {
            lo = DEPTH_MIN_MM; hi = DEPTH_MAX_MM
        }
        val span = (hi - lo).coerceAtLeast(1f)

        // Pass 2: colorize from the smoothed range.
        val pixels = IntArray(outW * outH)
        var ci = 0
        while (ci < filled) {
            pixels[ci] = depthPreviewColor(mmGrid[ci], lo, span)
            ci++
        }

        val bmp = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        return try {
            bmp.setPixels(pixels, 0, outW, 0, 0, outW, outH)
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, DEPTH_PREVIEW_JPEG_QUALITY, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
            bmp.recycle()
        }
    }

    private fun isPlausiblePreviewDepth(mm: Float): Boolean =
        mm >= DEPTH_RANGE_FLOOR_MM && mm <= DEPTH_RANGE_CEILING_MM

    private fun percentile(sorted: FloatArray, count: Int, p: Float): Float {
        if (count <= 0) return 0f
        val idx = kotlin.math.round((count - 1) * p).toInt().coerceIn(0, count - 1)
        return sorted[idx]
    }

    /** Jet colormap over [minMm, minMm + span]; 0/invalid/out-of-range depth → black. */
    private fun depthPreviewColor(mm: Float, minMm: Float, span: Float): Int {
        if (!isPlausiblePreviewDepth(mm)) return 0xFF shl 24
        val t = ((mm - minMm) / span).coerceIn(0f, 1f)
        val r = (clampUnit(1.5f - kotlin.math.abs(4f * t - 3f)) * 255f).toInt()
        val g = (clampUnit(1.5f - kotlin.math.abs(4f * t - 2f)) * 255f).toInt()
        val b = (clampUnit(1.5f - kotlin.math.abs(4f * t - 1f)) * 255f).toInt()
        return argb(r, g, b)
    }

    /**
     * EMA-smoothed auto-range for the depth preview colormap. Pads the frame's
     * valid extent a little, then eases the stored min/max toward it so the live
     * PiP keeps high near/far contrast without the palette flickering frame to
     * frame. Runs on the pump thread only. Returns the smoothed (minMm, maxMm).
     */
    private fun smoothDepthRange(frameMin: Float, frameMax: Float): Pair<Float, Float> {
        val pad = (frameMax - frameMin) * DEPTH_RANGE_PAD
        val targetMin = (frameMin - pad).coerceAtLeast(DEPTH_RANGE_FLOOR_MM)
        val targetMax = (frameMax + pad).coerceAtMost(DEPTH_RANGE_CEILING_MM)
        if (!depthRangeInit) {
            depthRangeMinMm = targetMin
            depthRangeMaxMm = targetMax
            depthRangeInit = true
        } else {
            depthRangeMinMm += (targetMin - depthRangeMinMm) * DEPTH_RANGE_EMA
            depthRangeMaxMm += (targetMax - depthRangeMaxMm) * DEPTH_RANGE_EMA
        }
        if (depthRangeMaxMm - depthRangeMinMm < DEPTH_RANGE_MIN_SPAN_MM) {
            depthRangeMaxMm = depthRangeMinMm + DEPTH_RANGE_MIN_SPAN_MM
        }
        return Pair(depthRangeMinMm, depthRangeMaxMm)
    }

    private fun clampUnit(v: Float): Float = if (v < 0f) 0f else if (v > 1f) 1f else v

    private fun pixelsToJpeg(pixels: IntArray, width: Int, height: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            bitmap.setPixels(pixels, 0, width, 0, 0, width, height)
            val out = ByteArrayOutputStream()
            val ok = bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            if (!ok) throw IllegalStateException("Failed to encode Orbbec RGB frame")
            return out.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    private fun yuvToArgb(y: Int, u: Int, v: Int): Int {
        val c = (y - 16).coerceAtLeast(0)
        val d = u - 128
        val e = v - 128
        val r = clamp((298 * c + 409 * e + 128) shr 8)
        val g = clamp((298 * c - 100 * d - 208 * e + 128) shr 8)
        val b = clamp((298 * c + 516 * d + 128) shr 8)
        return argb(r, g, b)
    }

    private fun argb(r: Int, g: Int, b: Int): Int {
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    private fun clamp(value: Int): Int = value.coerceIn(0, 255)

    private fun Byte.u8(): Int = toInt() and 0xFF

    private fun isCapturableColorFormat(format: Format): Boolean {
        return when (format) {
            Format.MJPG,
            Format.RGB,
            Format.BGR,
            Format.RGBA,
            Format.BGRA,
            Format.YUYV,
            Format.YUY2,
            Format.UYVY,
            Format.NV21,
            Format.NV12,
            Format.I420 -> true
            else -> false
        }
    }

    private fun colorFormatPriority(format: Format): Int {
        return when (format) {
            Format.MJPG -> 0 // already JPEG, cheapest and preserves camera output
            Format.RGB -> 1
            Format.BGR -> 2
            Format.RGBA, Format.BGRA -> 3
            Format.YUYV, Format.YUY2, Format.NV21, Format.NV12 -> 4
            Format.UYVY, Format.I420 -> 5
            else -> 99
        }
    }

    private fun isCapturableDepthFormat(format: Format): Boolean {
        return when (format) {
            Format.Y16,
            Format.Y10,
            Format.Y11,
            Format.Y12 -> true
            else -> false
        }
    }

    private fun depthFormatPriority(format: Format): Int {
        return when (format) {
            Format.Y16 -> 0
            Format.Y12 -> 1
            Format.Y11 -> 2
            Format.Y10 -> 3
            else -> 99
        }
    }

    // ── Safe close helpers ──────────────────────────────────────────────────

    private fun safeStopAndClose(pipeline: Pipeline?) {
        if (pipeline == null) return
        try {
            pipeline.stop()
        } catch (e: Exception) {
            Log.d(TAG, "pipeline stop ignored", e)
        }
        safeClose(pipeline, "pipeline")
    }

    private fun safeClose(closeable: AutoCloseable?, label: String) {
        if (closeable == null) return
        try {
            closeable.close()
        } catch (e: Exception) {
            Log.d(TAG, "close $label ignored", e)
        }
    }
}
