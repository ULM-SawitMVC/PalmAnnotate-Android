package dev.sawitulm.palmannotate

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * SafPlugin — Storage Access Framework bridge so the operator can pick a public,
 * browsable folder (Documents / SD card / USB-OTG) for PalmAnnotate to mirror
 * captured photos + metadata into.
 *
 * WHY: under Android 11+ scoped storage (and reliably broken on 13/14 =
 * targetSdk 34) the Filesystem plugin can't write to the public Documents
 * folder, so the working store lives in app-external storage (CapacitorAdapter).
 * SAF is the supported way to also drop user-browsable copies into a folder the
 * operator chooses — the system picker grants a persistable read/write URI.
 *
 * STATELESS BY DESIGN: the chosen tree URI is remembered on the JS side
 * (SafStore → SessionStore settings) and passed back to every writeFile call, so
 * this plugin holds no folder state of its own.
 *
 * THREADING: Capacitor invokes @PluginMethod handlers on a background thread, so
 * the (blocking) DocumentFile I/O in writeFile is fine here. pickFolder hands off
 * to the system picker via startActivityForResult and resolves in the
 * @ActivityCallback below.
 */
@CapacitorPlugin(name = "Saf")
class SafPlugin : Plugin() {

    // ── Folder picker ─────────────────────────────────────────────────────────

    /**
     * Launch ACTION_OPEN_DOCUMENT_TREE. Resolves { uri, name } for the chosen
     * folder, or { cancelled: true } if the user backs out.
     */
    @PluginMethod
    fun pickFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }
        startActivityForResult(call, intent, "pickFolderResult")
    }

    @ActivityCallback
    private fun pickFolderResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data?.data == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val uri: Uri = data.data!!
        // Persist the grant so the folder survives an app restart.
        try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (e: Exception) {
            // Some providers don't support persistable grants; the URI may still
            // work for this session — non-fatal.
        }
        val ret = JSObject()
        ret.put("uri", uri.toString())
        ret.put("name", displayName(uri))
        call.resolve(ret)
    }

    // ── hasFolder ─────────────────────────────────────────────────────────────

    /**
     * Resolve { has: Boolean, name } — true when the given tree URI is still a
     * persisted, writable grant. Used by JS to re-verify a remembered folder.
     */
    @PluginMethod
    fun hasFolder(call: PluginCall) {
        val uriStr = call.getString("uri")
        val ret = JSObject()
        if (uriStr.isNullOrBlank()) {
            ret.put("has", false)
            call.resolve(ret)
            return
        }
        val uri = Uri.parse(uriStr)
        val granted = try {
            context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission }
        } catch (e: Exception) {
            false
        }
        val writable = try {
            DocumentFile.fromTreeUri(context, uri)?.canWrite() == true
        } catch (e: Exception) {
            false
        }
        ret.put("has", granted && writable)
        ret.put("name", displayName(uri))
        call.resolve(ret)
    }

    // ── releaseFolder ─────────────────────────────────────────────────────────

    /** Release a previously taken persistable grant. Always resolves. */
    @PluginMethod
    fun releaseFolder(call: PluginCall) {
        val uriStr = call.getString("uri")
        if (!uriStr.isNullOrBlank()) {
            try {
                val uri = Uri.parse(uriStr)
                val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                context.contentResolver.releasePersistableUriPermission(uri, flags)
            } catch (e: Exception) {
                // Already released / never granted — ignore.
            }
        }
        call.resolve()
    }

    // ── writeFile ─────────────────────────────────────────────────────────────

    /**
     * Write data to <treeUri>/<relPath>, creating intermediate folders as needed
     * and overwriting any existing file of the same name. `encoding` is "base64"
     * (images) or "utf8" (JSON/text). Resolves { ok: true }.
     */
    @PluginMethod
    fun writeFile(call: PluginCall) {
        val treeUriStr = call.getString("treeUri")
        val relPath = call.getString("relPath")
        val data = call.getString("data") ?: ""
        val encoding = call.getString("encoding") ?: "base64"

        if (treeUriStr.isNullOrBlank() || relPath.isNullOrBlank()) {
            call.reject("treeUri and relPath are required")
            return
        }

        try {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(treeUriStr))
            if (tree == null) {
                call.reject("Export folder is not accessible")
                return
            }
            val segments = relPath.split('/').filter { it.isNotBlank() }
            if (segments.isEmpty()) {
                call.reject("Invalid relPath")
                return
            }
            val fileName = segments.last()

            // Walk/create the directory chain. findFile first so we reuse an
            // existing folder instead of creating a duplicate (SAF allows dupes).
            var dir: DocumentFile = tree
            for (i in 0 until segments.size - 1) {
                val seg = segments[i]
                val existing = dir.findFile(seg)
                dir = if (existing != null && existing.isDirectory) {
                    existing
                } else {
                    dir.createDirectory(seg) ?: run {
                        call.reject("Cannot create folder: $seg")
                        return
                    }
                }
            }

            // Overwrite: drop any existing same-named file so we don't get
            // "name (1).jpg" duplicates from the picker provider.
            dir.findFile(fileName)?.delete()

            val file = dir.createFile(mimeFor(fileName), fileName)
            if (file == null) {
                call.reject("Cannot create file: $fileName")
                return
            }

            val bytes = if (encoding == "base64") {
                Base64.decode(data, Base64.DEFAULT)
            } else {
                data.toByteArray(Charsets.UTF_8)
            }

            val out = context.contentResolver.openOutputStream(file.uri)
            if (out == null) {
                call.reject("Cannot open output stream for $fileName")
                return
            }
            out.use { it.write(bytes) }

            call.resolve(JSObject().put("ok", true))
        } catch (e: Exception) {
            call.reject("writeFile failed: ${e.message}", e)
        }
    }

    // ── deletePath ────────────────────────────────────────────────────────────

    /**
     * Delete <treeUri>/<relPath> if it exists. Missing files resolve as
     * { ok:true, removed:false } so callers can run broad cleanup sweeps.
     */
    @PluginMethod
    fun deletePath(call: PluginCall) {
        val treeUriStr = call.getString("treeUri")
        val relPath = call.getString("relPath")

        if (treeUriStr.isNullOrBlank() || relPath.isNullOrBlank()) {
            call.reject("treeUri and relPath are required")
            return
        }

        try {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(treeUriStr))
            if (tree == null) {
                call.resolve(JSObject().put("ok", true).put("removed", false))
                return
            }
            val segments = relPath.split('/').filter { it.isNotBlank() }
            if (segments.isEmpty()) {
                call.resolve(JSObject().put("ok", true).put("removed", false))
                return
            }

            var node: DocumentFile = tree
            for (i in 0 until segments.size - 1) {
                val child = node.findFile(segments[i])
                if (child == null || !child.isDirectory) {
                    call.resolve(JSObject().put("ok", true).put("removed", false))
                    return
                }
                node = child
            }
            val target = node.findFile(segments.last())
            val removed = target?.delete() == true
            call.resolve(JSObject().put("ok", true).put("removed", removed))
        } catch (e: Exception) {
            call.reject("deletePath failed: ${e.message}", e)
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /** Human-readable folder name, falling back to the URI's last path segment. */
    private fun displayName(uri: Uri): String {
        return try {
            DocumentFile.fromTreeUri(context, uri)?.name ?: lastPathName(uri)
        } catch (e: Exception) {
            lastPathName(uri)
        }
    }

    private fun lastPathName(uri: Uri): String {
        val decoded = Uri.decode(uri.toString())
        val idx = decoded.lastIndexOf('/')
        return if (idx >= 0 && idx < decoded.length - 1) decoded.substring(idx + 1) else "Selected folder"
    }

    private fun mimeFor(name: String): String {
        val lower = name.lowercase()
        return when {
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".txt") -> "text/plain"
            else -> "application/octet-stream"
        }
    }
}
