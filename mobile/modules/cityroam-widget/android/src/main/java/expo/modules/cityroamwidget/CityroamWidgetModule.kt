package expo.modules.cityroamwidget

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File

/**
 * JS-facing bridge for the Cityroam home-screen widget.
 *
 * The widget itself is rendered natively (CityroamWidgetProvider) and can't read JS memory,
 * so the JS side pushes a compact JSON snapshot here on every meaningful change (trip
 * state transitions and the recorder's 1s tick). The module persists it to
 * SharedPreferences and re-renders every live widget instance. Because the snapshot is
 * persisted, a widget added or refreshed while the app process is dead still shows the
 * last-known state.
 */
class CityroamWidgetModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  // Where Settings' live preview (WidgetPreview.tsx) reads its PNG from. Cleared on
  // every module init (a fresh process) so a stale preview from a prior session's cache
  // dir never lingers past its own process's lifetime.
  private val previewDir: File by lazy {
    File(context.cacheDir, "widget-preview").apply {
      mkdirs()
      listFiles()?.forEach { it.delete() }
    }
  }
  private var previewCounter = 0
  private var lastPreviewFile: File? = null

  override fun definition() = ModuleDefinition {
    Name("CityroamWidget")

    // Called by the JS side whenever the live trip/telemetry snapshot changes. The JSON
    // is a flat object of primitives only (see widgetSync.ts for the producer). Wrapped
    // defensively — this runs in the app's own process (widgetSync.ts's own try/catch
    // only guards against the native module being entirely absent, e.g. a dev client
    // without the widget prebuilt), so an unexpected failure here must never take the
    // whole app down over what is, at worst, a stale widget.
    Function("updateSnapshot") { snapshotJson: String ->
      try {
        WidgetSnapshotStore.save(context, snapshotJson)
        WidgetSnapshotStore.refreshAll(context)
      } catch (t: Throwable) {
        Log.e("CityroamWidget", "updateSnapshot failed", t)
      }
    }

    // Renders the widget's card through the exact same code path the placed widget uses
    // (WidgetRenderer.render) at an arbitrary size, and writes it to a cache file whose
    // path is returned for an <Image source={{uri}}> to load. Settings' live preview
    // calls this on every appearance change and on every snapshot update, so there is one
    // renderer, not a second hand-maintained JS approximation that could silently drift
    // from what the real widget looks like.
    //
    // AsyncFunction, not Function: this does real drawing + file I/O work, not a
    // fire-and-forget bridge call like updateSnapshot above.
    AsyncFunction("renderPreview") { snapshotJson: String, widthDp: Double, heightDp: Double ->
      val snap = WidgetSnapshot.fromJson(JSONObject(snapshotJson))
      val state = CityroamWidgetProvider.toRenderState(context, snap)
      val bitmap = WidgetRenderer.render(context, widthDp.toFloat(), heightDp.toFloat(), state)
      writePreviewFile(bitmap)
    }
  }

  // React Native's <Image> caches by URI, so re-using one stable filename across renders
  // would freeze the preview on its first frame — each call gets a fresh name. The
  // previous file is deleted only after the new one is fully written, not before:
  // renderPreview calls can overlap (Settings re-renders on every appearance change and
  // every trip-recorder tick, and AsyncFunction bodies aren't guaranteed to run one at a
  // time), and deleting first would risk pulling the file out from under a still-loading
  // <Image> that has already been handed the previous path.
  private fun writePreviewFile(bitmap: Bitmap): String {
    val previous = lastPreviewFile
    val file = File(previewDir, "widget-preview-${++previewCounter}.png")
    file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    lastPreviewFile = file
    previous?.delete()
    return file.absolutePath
  }
}
