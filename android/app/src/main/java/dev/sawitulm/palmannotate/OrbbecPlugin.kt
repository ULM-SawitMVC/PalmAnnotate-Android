package dev.sawitulm.palmannotate

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

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

    private val deviceChangedCallback = object : DeviceChangedCallback {
        override fun onDeviceAttach(deviceList: DeviceList) {
            try {
                Log.i(TAG, "Orbbec device attached (${deviceList.getDeviceCount()} device(s))")
            } catch (e: Exception) {
                Log.w(TAG, "onDeviceAttach failed", e)
            } finally {
                safeClose(deviceList, "attach deviceList")
            }
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
                cameraExecutor.execute {
                    synchronized(stateLock) {
                        closeSdkLocked()
                    }
                }
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
                val frame = captureRgbd()
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
                }
                call.resolve(ret)
            } catch (e: Exception) {
                Log.e(TAG, "capture failed", e)
                call.reject(e.message ?: "Failed to capture Orbbec frame")
            }
        }
    }

    /** Preview is not rendered natively; keeping the pipeline open is enough. */
    @PluginMethod
    fun startPreview(call: PluginCall) {
        open(call)
    }

    /** No JS preview pump to stop. The capture pipeline remains open. */
    @PluginMethod
    fun stopPreview(call: PluginCall) {
        call.resolve(JSObject().put("stopped", true))
    }

    /** Stop/release the Pipeline, Device and OBContext. */
    @PluginMethod
    fun close(call: PluginCall) {
        cameraExecutor.execute {
            synchronized(stateLock) { closeSdkLocked() }
            call.resolve(JSObject().put("closed", true))
        }
    }

    override fun handleOnDestroy() {
        try {
            cameraExecutor.execute {
                synchronized(stateLock) { closeSdkLocked() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "cleanup dispatch failed", e)
        }
        cameraExecutor.shutdown()
        super.handleOnDestroy()
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
