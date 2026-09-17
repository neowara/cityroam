package expo.modules.cityroamwidget

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import androidx.core.graphics.ColorUtils
import androidx.appcompat.content.res.AppCompatResources
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Draws the widget's entire card into a single [Bitmap], which [CityroamWidgetProvider] hands
 * to `RemoteViews.setImageViewBitmap`. This is a line-for-line Kotlin port of the
 * approved, reviewed design prototype onto `android.graphics`. Keep the two in step:
 * a layout or drawing change belongs in both, and this file's function names/order
 * deliberately mirror the prototype's so the two can be diffed by eye.
 *
 * Everything is drawn in dp, exactly like the prototype draws in dp against a
 * devicePixelRatio-scaled canvas — [render] scales the real [Canvas] by density once up
 * front so every number below (radii, offsets, text sizes) is the same dp value that was
 * tuned and approved in the browser prototype.
 *
 * No `RemoteViews`/`AppWidgetManager` dependency here on purpose — this function is pure
 * over its arguments, so the in-app Settings preview (`CityroamWidgetModule.renderPreview`)
 * can call the exact same code path the placed widget uses, with no second renderer to
 * drift out of sync.
 */
object WidgetRenderer {

  // Caps the bitmap's actual pixel density below the device's real one (an S23 is ~2.6x)
  // so a large widget's bitmap stays well inside RemoteViews' transaction memory budget.
  // At this cap the largest widget this renderer is asked for (maxResizeWidth/Height,
  // cityroam_widget_info.xml) is comfortably under 5 MB.
  private const val MAX_RENDER_DENSITY = 2.0f
  private const val MAX_RENDER_PX = 1600

  private const val GAUGE_START_DEG = 150f // 0 = 3 o'clock, sweeping clockwise
  private const val GAUGE_SWEEP_DEG = 240f

  private data class Theme(
    val bg: Int, val text: Int, val dim: Int, val faint: Int,
    val good: Int, val warn: Int, val crit: Int, val isDark: Boolean,
  )

  private val DARK_THEME = Theme(
    bg = 0xFF171B22.toInt(), text = 0xFFE8EAED.toInt(), dim = 0xFF8B93A1.toInt(), faint = 0xFF565E6C.toInt(),
    good = 0xFF6FCF6A.toInt(), warn = 0xFFF2C94C.toInt(), crit = 0xFFFF5C5C.toInt(), isDark = true,
  )
  private val LIGHT_THEME = Theme(
    bg = 0xFFFFFFFF.toInt(), text = 0xFF1A1D22.toInt(), dim = 0xFF6B7280.toInt(), faint = 0xFF9CA3AF.toInt(),
    good = 0xFF2E9E4F.toInt(), warn = 0xFFB8860B.toInt(), crit = 0xFFD93B3B.toInt(), isDark = false,
  )

  private val MODE_COLORS = mapOf(
    "eco" to 0xFF22A55A.toInt(),
    "ride" to 0xFF2F95DC.toInt(),
    "speed" to 0xFFF5793A.toInt(),
    "turbo" to 0xFFE5484D.toInt(),
  )

  /** Everything this render pass needs, flattened out of [WidgetSnapshot] plus the caller's
   * appearance/state selection — kept separate from WidgetSnapshot so this file has no
   * JSON/parsing concerns, only drawing. */
  data class RenderState(
    val kind: Kind,
    val accentColor: Int,
    val font: String, // "dash" | "modern" | "mono"
    val needle: String, // "accent" | "ink"
    val containerStyle: String, // "matte" | "glass"
    // Header
    val stateLabel: String,
    val meta: String?,
    val paused: Boolean,
    val weatherTempC: Double?,
    val weatherKind: String?, // "sun" | "cloud" | "rain" | "snow" | "storm"
    // Live — board telemetry, nullable while the board isn't genuinely reporting (the
    // last-ride branch of toRenderState always supplies real, non-null values here; only
    // the live branch can leave these null).
    val speedKmh: Double?,
    val distanceKm: Double?,
    val avgKmh: Double?,
    val maxKmh: Double?,
    val batteryPct: Int?,
    val charging: Boolean,
    val odometerKm: Double?,
    // Last ride
    val durationText: String,
    val batteryUsedPct: Int?,
    val efficiency: Double?,
    val stops: Int,
    val modeCost: Map<String, Double?>,
  ) {
    enum class Kind { LIVE, LAST_RIDE, EMPTY }
  }

  fun render(context: Context, wDp: Float, hDp: Float, state: RenderState): Bitmap {
    val rawDensity = context.resources.displayMetrics.density
    var density = min(rawDensity, MAX_RENDER_DENSITY)
    if (wDp * density > MAX_RENDER_PX || hDp * density > MAX_RENDER_PX) {
      density = min(density, MAX_RENDER_PX / max(wDp, hDp))
    }
    val pxW = max(1, (wDp * density).roundToInt())
    val pxH = max(1, (hDp * density).roundToInt())

    val bitmap = Bitmap.createBitmap(pxW, pxH, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.scale(density, density)

    // Follows the system's dark/light setting, same as the pre-redesign widget's
    // values-night resource qualifier did — the widget has no theme concept of its own,
    // only its own independent font/accent/needle (widgetAppearance.ts).
    val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    val theme = if (night) DARK_THEME else LIGHT_THEME

    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val path = Path()

    renderWidget(context, canvas, paint, path, wDp, hDp, theme, state)
    return bitmap
  }

  private fun renderWidget(context: Context, canvas: Canvas, paint: Paint, path: Path, w: Float, h: Float, theme: Theme, s: RenderState) {
    val accent = s.accentColor
    val fam = typefaceProviderFor(context, s.font)
    val needleColor = if (s.needle == "ink") theme.text else accent

    // Card — matte (opaque surface) or glass (translucent tint + diagonal sheen,
    // matching Card.tsx's Android fake-glass look — a real backdrop blur isn't
    // available drawing into a plain Bitmap, and Card.tsx itself avoids one on
    // Android for its own reasons, so this uses the exact same technique: a flat
    // tinted fill plus a top-left sheen highlight, not a live blur of whatever's
    // behind the widget on the home screen) — either way, an accent-tinted hairline.
    val radius = clamp(min(w, h) * 0.09f, 10f, 22f)
    roundRect(path, 0.5f, 0.5f, w - 1f, h - 1f, radius)
    paint.style = Paint.Style.FILL
    if (s.containerStyle == "glass") {
      // 80% opacity — deliberately more opaque than the in-app glass Cards (~42-50%),
      // since a widget sits over an arbitrary, often busy home-screen wallpaper and
      // needs to stay legible without the app's own controlled backdrop behind it.
      paint.color = withAlpha(if (theme.isDark) 0xFF141418.toInt() else Color.WHITE, 0.8f)
    } else {
      paint.color = theme.bg
    }
    canvas.drawPath(path, paint)
    if (s.containerStyle == "glass") {
      val sheenTop = if (theme.isDark) withAlpha(Color.WHITE, 0.16f) else withAlpha(Color.WHITE, 0.75f)
      val sheenBottom = if (theme.isDark) withAlpha(Color.WHITE, 0.03f) else withAlpha(Color.WHITE, 0.1f)
      paint.shader = LinearGradient(w * 0.1f, 0f, w * 0.6f, h, sheenTop, sheenBottom, Shader.TileMode.CLAMP)
      canvas.drawPath(path, paint)
      paint.shader = null
    }
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 1f
    paint.color = withAlpha(accent, 0.42f)
    canvas.drawPath(path, paint)

    if (s.kind == RenderState.Kind.EMPTY) {
      renderEmpty(canvas, paint, w, h, theme, accent, fam, s.needle)
      return
    }

    val l = computeLayout(w, h, s)
    if (l.showHeader) drawHeader(context, canvas, paint, l, s, theme, accent, fam)

    val gb = l.gaugeBox
    val r = gb.size / 2f
    val live = s.kind == RenderState.Kind.LIVE
    val ceiling = gaugeCeiling(if (live) s.speedKmh else s.avgKmh, s.maxKmh)
    drawGauge(
      canvas, paint, gb.x + r, gb.y + r, r,
      value = (if (live) s.speedKmh else s.avgKmh) ?: 0.0,
      ceiling = ceiling,
      marker = s.maxKmh,
      accent = accent, theme = theme, needleColor = needleColor, fam = fam,
      big = if (live) fmt(s.speedKmh, 1) else fmt(s.distanceKm, 2),
      unit = if (live) "km/h" else "km",
      caption = if (live) "MAX " + fmt(s.maxKmh, 0) else "AVG " + fmt(s.avgKmh, 1) + " km/h",
    )

    if (l.rows > 0) drawStatGrid(context, canvas, paint, l, s, theme, accent, fam)
    if (l.modeRect != null) drawModeStrip(context, canvas, paint, l.modeRect, s, theme, fam)
  }

  // ================= fonts =================

  /** Resolves a (font choice, target weight) pair to one of this module's embedded .ttf
   * files. "num" vs "body" is not a real distinction in the approved design — every font
   * choice's num/body values are identical — so unlike widget.js this takes only a weight. */
  private class FontProvider(private val context: Context, private val font: String) {
    private val cache = HashMap<Int, Typeface>()
    fun get(weight: Int): Typeface = cache.getOrPut(weight) {
      val res = when (font) {
        "modern" -> if (weight >= 700) R.font.manrope_700_bold else if (weight >= 600) R.font.manrope_600_semibold else R.font.manrope_400_regular
        "mono" -> R.font.space_mono_regular
        else -> if (weight >= 700) R.font.space_grotesk_700_bold else R.font.space_grotesk_500_medium
      }
      ResourcesCompat.getFont(context, res) ?: Typeface.DEFAULT
    }
    // Same face as the in-app wordmark (CityroamMark.tsx's ClashDisplay_Bold) — the
    // widget's header lockup is meant to read as the same logo, not a distinct mark.
    val wordmark: Typeface by lazy { ResourcesCompat.getFont(context, R.font.clash_display_bold) ?: Typeface.DEFAULT }
  }

  private fun typefaceProviderFor(context: Context, font: String) = FontProvider(context, font)

  // ================= text helpers =================

  /** Draws `text` and returns its measured advance width (including tracking). Android's
   * Paint.textAlign + Paint.letterSpacing already do exactly what widget.js's manual
   * per-character tracking loop worked around a lack of canvas letter-spacing support to
   * achieve — no loop needed here. */
  private fun drawText(
    canvas: Canvas, paint: Paint, text: String, x: Float, y: Float,
    typeface: Typeface, size: Float, color: Int,
    align: Paint.Align = Paint.Align.LEFT, middle: Boolean = false, trackingDp: Float = 0f,
  ): Float {
    paint.style = Paint.Style.FILL
    paint.typeface = typeface
    paint.textSize = size
    paint.color = color
    paint.textAlign = align
    paint.letterSpacing = if (size > 0f) trackingDp / size else 0f
    val drawY = if (middle) y - (paint.ascent() + paint.descent()) / 2f else y
    canvas.drawText(text, x, drawY, paint)
    val w = paint.measureText(text)
    paint.letterSpacing = 0f
    return w
  }

  /** Measures without tracking — mirrors widget.js's `measure()`, which never applies the
   * manual tracking hack, so callers that add their own tracking approximation (see
   * columnWidths below) keep matching the approved layout's numbers exactly. */
  private fun measure(paint: Paint, text: String, typeface: Typeface, size: Float): Float {
    paint.typeface = typeface
    paint.textSize = size
    paint.letterSpacing = 0f
    return paint.measureText(text)
  }

  // ================= shapes =================

  private fun roundRect(path: Path, x: Float, y: Float, w: Float, h: Float, r: Float) {
    path.reset()
    path.addRoundRect(RectF(x, y, x + w, y + h), r, r, Path.Direction.CW)
  }

  // ================= colour helpers =================

  private fun mix(a: Int, b: Int, t: Float): Int = ColorUtils.blendARGB(a, b, t.toDouble().coerceIn(0.0, 1.0).toFloat())
  private fun lighten(c: Int, t: Float): Int = mix(c, Color.WHITE, t)
  private fun darken(c: Int, t: Float): Int = mix(c, Color.BLACK, t)
  private fun withAlpha(c: Int, a: Float): Int = ColorUtils.setAlphaComponent(c, (a * 255f).roundToInt().coerceIn(0, 255))

  private fun clamp(v: Float, lo: Float, hi: Float): Float = max(lo, min(hi, v))

  /** Shared, whiter-than-faint color for stat/mode labels (DISTANCE, AVG, ECO, ...) and
   * the header's weather/date text+icon — those were all drawn at theme.faint, tuned for
   * a subtle caption look but too low-contrast to actually read at a glance on a small
   * widget. Blended toward theme.text (not hardcoded pure white) so it stays readable in
   * light theme too, not just dark. */
  private fun labelColor(theme: Theme): Int = mix(theme.text, theme.dim, 0.3f)

  // ================= the gauge =================

  /** A "nice" full-scale ceiling so the needle never pins and the scale doesn't jitter
   * between frames: the next 10 km/h step above the highest value shown, floored at 40
   * (not the round-number default of 30) — the rider's own stated normal riding range
   * tops out around there, so the gauge should never read finer-grained than that even
   * on a slow ride, keeping the dial's scale consistent ride to ride. */
  private fun gaugeCeiling(vararg values: Double?): Float {
    var peak = 0.0
    for (v in values) if (v != null && v.isFinite() && v > peak) peak = v
    return max(40.0, ceil((peak + 1) / 10) * 10).toFloat()
  }

  /**
   * The speedometer. The dial sweeps from a near-white tint of the accent at zero to a
   * deep shade of it at full scale; the portion up to `value` is drawn at full opacity and
   * the remainder ghosted, so the fill level reads at a glance even before you find the
   * needle.
   */
  private fun drawGauge(
    canvas: Canvas, paint: Paint, cx: Float, cy: Float, r: Float,
    value: Double, ceiling: Float, marker: Double?, accent: Int, theme: Theme,
    needleColor: Int, fam: FontProvider, big: String, unit: String?, caption: String?,
  ) {
    val ring = r * 0.155f
    val rr = r - ring / 2f
    val frac = clamp((value / ceiling).toFloat(), 0f, 1f)

    val light = lighten(accent, 0.62f)
    val dark = darken(accent, 0.48f)

    // Dial, drawn as short segments so the gradient follows the arc rather than a
    // straight line — Canvas has no per-arc gradient primitive that follows a stroked
    // arc's own curvature, so this mirrors widget.js's own segmented-arc workaround
    // rather than reaching for a SweepGradient shader (which would need its own matrix
    // rotation bookkeeping to line up with GAUGE_START/GAUGE_SWEEP for no visual gain
    // over the segments, which the prototype already tuned).
    val seg = 2f
    val steps = (GAUGE_SWEEP_DEG / seg).toInt()
    val oval = RectF(cx - rr, cy - rr, cx + rr, cy + rr)
    paint.style = Paint.Style.STROKE
    paint.strokeCap = Paint.Cap.BUTT
    paint.strokeWidth = ring
    for (i in 0 until steps) {
      val t = i / (steps - 1).toFloat()
      val a0 = GAUGE_START_DEG + i * seg
      val c = mix(light, dark, t)
      paint.color = if (t <= frac) c else withAlpha(c, if (theme.isDark) 0.14f else 0.18f)
      canvas.drawArc(oval, a0, seg + 0.6f, false, paint)
    }

    // Ticks, stepped in km/h rather than in fractions of the sweep, so the labelled
    // majors are always round tens no matter what the ceiling works out to.
    val majorStep = 10f
    val minorStep = if (ceiling > 60f) 5f else 2f
    val showLabels = r >= 48f
    val tickOuter = rr - ring / 2f - r * 0.035f
    var v = 0f
    while (v <= ceiling + 0.001f) {
      val major = abs(v % majorStep) < 0.001f
      if (major || r >= 34f) {
        val a = (GAUGE_START_DEG + (v / ceiling) * GAUGE_SWEEP_DEG) * (PI.toFloat() / 180f)
        val len = if (major) r * 0.1f else r * 0.05f
        paint.color = if (major) theme.dim else theme.faint
        paint.strokeWidth = if (major) max(1f, r * 0.022f) else max(0.7f, r * 0.013f)
        canvas.drawLine(
          cx + cos(a) * tickOuter, cy + sin(a) * tickOuter,
          cx + cos(a) * (tickOuter - len), cy + sin(a) * (tickOuter - len),
          paint,
        )
        if (major && showLabels) {
          val lr = tickOuter - len - r * 0.11f
          // Color only, not size — these ("0"/"10"/"20"/.../ceiling) were too dark
          // (theme.faint) against the dial to read at a glance; same labelColor
          // treatment as the stat/mode labels and header text elsewhere in this file.
          // drawGauge is shared by both the live and last-ride widget states (see
          // renderWidget), so this applies to both automatically.
          drawText(
            canvas, paint, v.toInt().toString(), cx + cos(a) * lr, cy + sin(a) * lr,
            fam.get(600), r * 0.115f, labelColor(theme), Paint.Align.CENTER, middle = true,
          )
        }
      }
      v += minorStep
    }

    // Peak marker — a bright pip on the dial at the ride's max speed, so the needle's
    // "now" always has the ride's "best" to read against.
    if (marker != null && marker > 0) {
      val a = (GAUGE_START_DEG + clamp((marker / ceiling).toFloat(), 0f, 1f) * GAUGE_SWEEP_DEG) * (PI.toFloat() / 180f)
      paint.color = theme.text
      paint.strokeWidth = max(1.6f, r * 0.032f)
      paint.strokeCap = Paint.Cap.ROUND
      canvas.drawLine(
        cx + cos(a) * (rr + ring * 0.5f), cy + sin(a) * (rr + ring * 0.5f),
        cx + cos(a) * (rr - ring * 0.5f), cy + sin(a) * (rr - ring * 0.5f),
        paint,
      )
      paint.strokeCap = Paint.Cap.BUTT
    }

    // Needle — a tapered blade with a short counterweight tail, pivoting on a hub.
    val naDeg = GAUGE_START_DEG + frac * GAUGE_SWEEP_DEG
    val tip = r * 0.74f
    val tail = r * 0.15f
    val halfBase = max(1.4f, r * 0.045f)
    canvas.save()
    canvas.translate(cx, cy)
    canvas.rotate(naDeg)
    val needlePath = Path().apply {
      moveTo(tip, 0f)
      lineTo(0f, -halfBase)
      lineTo(-tail, 0f)
      lineTo(0f, halfBase)
      close()
    }
    paint.style = Paint.Style.FILL
    paint.color = needleColor
    canvas.drawPath(needlePath, paint)
    canvas.restore()

    val hub = max(2.5f, r * 0.075f)
    paint.style = Paint.Style.FILL
    paint.color = theme.bg
    canvas.drawCircle(cx, cy, hub, paint)
    paint.style = Paint.Style.STROKE
    paint.color = needleColor
    paint.strokeWidth = max(1f, r * 0.022f)
    canvas.drawCircle(cx, cy, hub, paint)

    // Readout, sitting in the gap the 240° sweep leaves at the bottom of the dial. Sized
    // so it clears the 0 and full-scale tick labels on either side of it.
    if (r >= 26f) {
      var numSize = r * 0.38f
      val bold = fam.get(700)
      val body = fam.get(600)
      val probe = measure(paint, big, bold, numSize) +
        (if (unit != null) measure(paint, unit, body, numSize * 0.36f) + r * 0.045f else 0f)
      val maxW = r * 0.92f
      if (probe > maxW) numSize *= maxW / probe
      val unitSize = numSize * 0.36f
      val baseY = cy + r * 0.58f
      val numW = measure(paint, big, bold, numSize)
      val unitW = if (unit != null) measure(paint, unit, body, unitSize) + r * 0.045f else 0f
      val x0 = cx - (numW + unitW) / 2f
      drawText(canvas, paint, big, x0, baseY, bold, numSize, accent)
      if (unit != null) drawText(canvas, paint, unit, x0 + numW + r * 0.045f, baseY, body, unitSize, theme.dim)
      if (caption != null && r >= 54f) {
        // caption is "AVG x.x km/h" (last-ride kind) or "MAX x" (live kind) — same
        // +2dp/labelColor treatment as the stat/mode labels; drawGauge is shared by
        // both widget states so this applies to live recording too, automatically.
        drawText(
          canvas, paint, caption, cx, baseY + r * 0.2f, body, r * 0.115f + 2f, labelColor(theme),
          Paint.Align.CENTER, trackingDp = r * 0.008f,
        )
      }
    }
  }

  // ================= glyphs =================

  private fun weatherIconRes(kind: String?): Int = when (kind) {
    "sun" -> R.drawable.ic_weather_sun
    "rain" -> R.drawable.ic_weather_rain
    "snow" -> R.drawable.ic_weather_snow
    "storm" -> R.drawable.ic_weather_storm
    else -> R.drawable.ic_weather_cloud
  }

  /** Maps a stat's icon kind to the app's own lucide-style vector drawable — real brand
   * icons rather than the prototype's hand-drawn approximations of them (widget.js has no
   * drawable resource system to draw from, so it hand-draws every glyph; this renderer
   * runs inside the app and already ships these). `odometer` intentionally reuses the
   * distance glyph, matching this widget's pre-redesign behavior — there is no dedicated
   * odometer icon. */
  private fun statIconRes(kind: String): Int? = when (kind) {
    "distance", "odometer" -> R.drawable.ic_widget_distance
    "speed" -> R.drawable.ic_widget_speed
    "duration" -> R.drawable.ic_widget_duration
    "efficiency" -> R.drawable.ic_widget_efficiency
    "stops" -> R.drawable.ic_widget_stops
    "eco" -> R.drawable.ic_widget_mode_eco
    "ride" -> R.drawable.ic_widget_mode_ride
    "turbo" -> R.drawable.ic_widget_mode_turbo
    "mode_speed" -> R.drawable.ic_widget_mode_speed
    else -> null // "battery" is hand-drawn — see drawBatteryIcon
  }

  private fun drawTintedIcon(context: Context, canvas: Canvas, resId: Int, x: Float, y: Float, size: Float, color: Int) {
    val d = AppCompatResources.getDrawable(context, resId) ?: return
    d.mutate()
    d.setTint(color)
    d.setBounds(x.roundToInt(), y.roundToInt(), (x + size).roundToInt(), (y + size).roundToInt())
    d.draw(canvas)
  }

  /** Hand-drawn, not a static drawable: the fill must track the board's actual charge
   * level and overlay a charging bolt, neither of which a fixed vector asset can do. An
   * always-empty glyph next to "100%" would read as a flat battery at a glance — the
   * opposite of what it means — so a near-empty level still gets a visible sliver rather
   * than nothing. Ported from widget.js's `case 'battery'`. */
  private fun drawBatteryIcon(canvas: Canvas, paint: Paint, path: Path, x: Float, y: Float, s: Float, color: Int, level: Float?, charging: Boolean) {
    val bx = x + s * 0.08f
    val by = y + s * 0.3f
    val bw = s * 0.64f
    val bh = s * 0.4f

    paint.reset()
    paint.isAntiAlias = true
    paint.color = color
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = max(1f, s * 0.11f)
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    roundRect(path, bx, by, bw, bh, s * 0.1f)
    canvas.drawPath(path, paint)

    paint.style = Paint.Style.FILL
    roundRect(path, x + s * 0.78f, y + s * 0.42f, s * 0.11f, s * 0.16f, s * 0.04f)
    canvas.drawPath(path, paint)

    if (level != null) {
      val inset = max(1f, s * 0.09f)
      val trackW = bw - inset * 2f
      val fillW = if (level > 0f) max(s * 0.06f, trackW * clamp(level, 0f, 1f)) else 0f
      if (fillW > 0f) {
        roundRect(path, bx + inset, by + inset, fillW, bh - inset * 2f, s * 0.04f)
        canvas.drawPath(path, paint)
      }
    }

    if (charging) {
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = max(0.9f, s * 0.09f)
      val cx = x + s / 2f
      val cy = y + s / 2f
      path.reset()
      path.moveTo(cx + s * 0.05f, by - s * 0.02f)
      path.lineTo(cx - s * 0.06f, cy + s * 0.02f)
      path.lineTo(cx + s * 0.02f, cy + s * 0.02f)
      path.lineTo(cx - s * 0.07f, by + bh + s * 0.02f)
      canvas.drawPath(path, paint)
    }
  }

  // ================= layout =================

  private data class Box(val x: Float, val y: Float, val size: Float)
  private data class Rect(val x: Float, val y: Float, val w: Float, val h: Float)
  private data class Layout(
    val pad: Float, val iw: Float, val ih: Float, val gap: Float,
    val showHeader: Boolean, val headerH: Float,
    val gaugeBox: Box, val gridRect: Rect, val modeRect: Rect?,
    val cols: Int, val rows: Int,
  )

  /**
   * Everything about the widget's shape is derived from its real dp size — there are no
   * size buckets and no per-size layout files. Sections are laid out in priority order and
   * each is skipped when what's left can't hold it, so the same code covers a 2x1 tile and
   * a 5x5 slab.
   */
  private fun computeLayout(w: Float, h: Float, s: RenderState): Layout {
    val pad = clamp(min(w, h) * 0.058f, 7f, 15f)
    val iw = w - pad * 2f
    val ih = h - pad * 2f
    val gap = clamp(ih * 0.045f, 4f, 10f)

    val showHeader = ih >= 62f
    val headerH = if (showHeader) clamp(iw * 0.062f, 14f, 21f) else 0f
    val bodyY = pad + if (showHeader) headerH + gap else 0f
    var bodyH = ih - if (showHeader) headerH + gap else 0f

    // Gauge-beside-stats vs gauge-above-stats is decided on the card's own proportions,
    // before the mode strip is carved off. Deciding it after would let a band 27dp tall
    // flip a squarish widget into the side-by-side layout and strand the space it was
    // supposed to reclaim.
    val wide = iw / bodyH >= 1.18f

    // The mode strip is a full-width band across the bottom of the card, not a row inside
    // the stat column — in the side-by-side layout that column ends well above the
    // gauge's bottom edge, so confining the strip to it stranded a band of empty space
    // under the gauge.
    val modeH = 27f
    val rowMin = 26f
    var modeRect: Rect? = null
    if (s.kind == RenderState.Kind.LAST_RIDE && iw >= 150f && bodyH - (modeH + gap) >= 60f) {
      modeRect = Rect(pad, pad + ih - modeH, iw, modeH)
      bodyH -= modeH + gap
    }

    val gaugeBox: Box
    val gridRect: Rect
    if (wide) {
      val size = clamp(min(bodyH, iw * 0.44f), 44f, 260f)
      gaugeBox = Box(pad, bodyY + (bodyH - size) / 2f, size)
      gridRect = Rect(pad + size + gap * 1.4f, bodyY, iw - size - gap * 1.4f, bodyH)
    } else {
      val size = clamp(min(iw * 0.94f, bodyH * 0.64f), 44f, 260f)
      gaugeBox = Box(pad + (iw - size) / 2f, bodyY, size)
      gridRect = Rect(pad, bodyY + size + gap, iw, bodyH - size - gap)
    }

    val cols = clamp(kotlin.math.floor(gridRect.w / 76f), 1f, 3f).toInt()
    val rows = clamp(kotlin.math.floor(gridRect.h / rowMin), 0f, 4f).toInt()

    return Layout(pad, iw, ih, gap, showHeader, headerH, gaugeBox, gridRect, modeRect, cols, rows)
  }

  // ================= state -> display data =================

  private fun fmt(n: Double?, d: Int): String = if (n == null || !n.isFinite()) "–" else String.format(java.util.Locale.US, "%.${d}f", n)
  private fun dashInt(v: Int?): String = v?.let { "$it%" } ?: "–"

  private data class StatItem(val icon: String, val label: String, val value: String, val battery: Boolean = false, val level: Float? = null, val charging: Boolean = false)

  private fun statsFor(s: RenderState): List<StatItem> {
    if (s.kind == RenderState.Kind.LIVE) {
      return listOf(
        StatItem("distance", "DISTANCE", fmt(s.distanceKm, 2) + " km"),
        StatItem("speed", "AVG", fmt(s.avgKmh, 1) + " km/h"),
        StatItem("speed", "MAX", fmt(s.maxKmh, 1) + " km/h"),
        StatItem("battery", "BATTERY", dashInt(s.batteryPct), battery = true, level = s.batteryPct?.let { it / 100f }, charging = s.charging),
        StatItem("odometer", "ODOMETER", s.odometerKm?.let { String.format(java.util.Locale.US, "%.1f km", it) } ?: "–"),
      )
    }
    return listOf(
      StatItem("duration", "DURATION", s.durationText),
      StatItem("speed", "MAX", fmt(s.maxKmh, 1) + " km/h"),
      StatItem("battery", "USED", dashInt(s.batteryUsedPct)),
      StatItem("efficiency", "EFFICIENCY", s.efficiency?.let { String.format(java.util.Locale.US, "%.1f %%/km", it) } ?: "–"),
      StatItem("odometer", "ODOMETER", s.odometerKm?.let { String.format(java.util.Locale.US, "%.1f km", it) } ?: "–"),
      StatItem("stops", "STOPS", s.stops.toString()),
    )
  }

  // ================= sections =================

  private fun drawHeader(context: Context, canvas: Canvas, paint: Paint, l: Layout, s: RenderState, theme: Theme, accent: Int, fam: FontProvider) {
    val pad = l.pad
    val iw = l.iw
    val headerH = l.headerH
    val y = pad + headerH / 2f
    var x = pad

    // The actual wordmark, "city" + "roam" in two colors — same lockup as the in-app
    // logo (CityroamMark.tsx), no route glyph and no animation here: a static header
    // reads correctly as branding without either.
    val size = headerH * 1.02f
    val cityW = drawText(canvas, paint, "city", x, y, fam.wordmark, size, theme.text, middle = true)
    x += cityW
    val roamW = drawText(canvas, paint, "roam", x, y, fam.wordmark, size, accent, middle = true)
    x += roamW
    // Same margin on both sides of the status dot below (dotMargin) — it needs to sit
    // centered between the wordmark and the state label, not closer to one than the other.
    val dotMargin = headerH * 0.37f
    x += dotMargin

    // Right cluster: weather badge, then the elapsed clock / ride date.
    val metaSize = clamp(headerH * 0.62f, 9f, 13f)
    var rx = pad + iw
    val labelClr = labelColor(theme)
    if (s.meta != null) {
      // s.meta is the elapsed clock while live, the ride date otherwise — same draw
      // call/style either way. Color only (not size): brighter/whiter than theme.dim.
      val w = drawText(canvas, paint, s.meta, rx, y, fam.get(700), metaSize, labelClr, Paint.Align.RIGHT, middle = true)
      rx -= w + headerH * 0.5f
    }
    if (s.weatherTempC != null && iw >= 172f) {
      val w = drawText(canvas, paint, "${s.weatherTempC.roundToInt()}°", rx, y, fam.get(600), metaSize, labelClr, Paint.Align.RIGHT, middle = true)
      rx -= w + headerH * 0.14f
      val iconS = headerH * 0.86f
      drawTintedIcon(context, canvas, weatherIconRes(s.weatherKind), rx - iconS, y - iconS / 2f, iconS, labelClr)
      rx -= iconS + headerH * 0.42f
    }

    // Status dot + state label, filling whatever is left between the two clusters.
    // labelSize decided first — the dot is sized off the text it actually sits next to,
    // not off headerH, or it grows past the text's own cap-height on larger widget
    // sizes (labelSize is capped at 13.5sp; headerH keeps growing past that cap).
    val labelSize = clamp(headerH * 0.66f, 9f, 13.5f)
    val dotR = max(1.8f, labelSize * 0.16f)
    paint.reset()
    paint.isAntiAlias = true
    paint.style = Paint.Style.FILL
    paint.color = if (s.kind == RenderState.Kind.LIVE) (if (s.paused) theme.warn else theme.good) else accent
    canvas.drawCircle(x + dotR, y, dotR, paint)
    x += dotR * 2f + dotMargin

    val avail = rx - x
    if (avail > 22f) {
      val bodyBold = fam.get(700)
      paint.typeface = bodyBold
      paint.textSize = labelSize
      paint.letterSpacing = 0f
      var label = s.stateLabel
      if (paint.measureText(label) > avail) {
        while (label.length > 1 && paint.measureText("$label…") > avail) label = label.dropLast(1)
        label += "…"
      }
      drawText(canvas, paint, label, x, y, bodyBold, labelSize, theme.text, middle = true)
    }
  }

  // Columns are sized to their own widest value, not to an equal share of the grid — a
  // column of "26.0 km/h" next to one of "72%" would otherwise leave the wide one butting
  // straight into its neighbour while the narrow one floats in empty space.
  private const val COL_GUTTER_MIN = 12f
  private const val COL_GUTTER_MAX = 30f
  private const val RIGHT_INSET = 4f

  private fun drawStatGrid(context: Context, canvas: Canvas, paint: Paint, l: Layout, s: RenderState, theme: Theme, accent: Int, fam: FontProvider) {
    val g = l.gridRect
    val cols = l.cols
    val items = statsFor(s).take(cols * l.rows)
    if (items.isEmpty()) return
    val usedRows = ceil(items.size / cols.toFloat()).toInt()
    val rowH = min(g.h / usedRows, 48f)
    val top = g.y + (g.h - rowH * usedRows) / 2f

    var valueSize = clamp(min(rowH * 0.42f, (g.w / cols) * 0.18f), 10f, 17f)
    // +2dp over the base caption size — labels (DISTANCE, AVG, ODOMETER, ...) were too
    // small/low-contrast to read at a glance on a real widget (+4dp was tried first
    // and came back too large). The corrective shrink-to-fit pass below (widths vs.
    // budget) still applies on top of this if the grid is genuinely too tight, same
    // as before.
    var labelSize = clamp(valueSize * 0.6f, 7.5f, 9.5f) + 2f
    var iconS = valueSize * 0.95f
    val showLabels = rowH >= 27f

    fun columnWidths(): FloatArray {
      val w = FloatArray(cols)
      val bold = fam.get(700)
      val body = fam.get(600)
      for (c in 0 until cols) {
        var widest = 0f
        for (rI in 0 until usedRows) {
          val it = items.getOrNull(rI * cols + c) ?: continue
          widest = max(widest, iconS + valueSize * 0.3f + measure(paint, it.value, bold, valueSize))
          if (showLabels) {
            widest = max(widest, measure(paint, it.label, body, labelSize) + it.label.length * labelSize * 0.1f)
          }
        }
        w[c] = widest
      }
      return w
    }

    // One corrective pass: if the natural widths plus minimum gutters overflow, scale the
    // type down by exactly the overflow ratio rather than letting columns collide. The
    // trailing inset keeps the last column's widest value off the card's edge even in the
    // worst case (Mono's fixed-width glyphs, three columns, a short widget).
    var widths = columnWidths()
    val budget = g.w - RIGHT_INSET - COL_GUTTER_MIN * (cols - 1)
    val natural = widths.sum()
    if (natural > budget && natural > 0f) {
      val k = budget / natural
      valueSize *= k; labelSize *= k; iconS *= k
      widths = columnWidths()
    }

    val slack = g.w - RIGHT_INSET - widths.sum()
    val gutter = if (cols > 1) clamp(slack / (cols - 1), COL_GUTTER_MIN, COL_GUTTER_MAX) else 0f
    val colX = FloatArray(cols)
    var cursor = g.x
    for (c in 0 until cols) { colX[c] = cursor; cursor += widths[c] + gutter }

    val bold = fam.get(700)
    val body = fam.get(600)
    val labelClr = labelColor(theme)
    for (i in items.indices) {
      val it = items[i]
      val c = i % cols
      val rIdx = i / cols
      val x = colX[c]
      val cy = top + rIdx * rowH + rowH / 2f

      var color = theme.text
      if (it.battery && s.batteryPct != null) {
        color = if (s.batteryPct <= 30) theme.crit else if (s.batteryPct <= 60) theme.warn else theme.good
      }
      val vy = if (showLabels) cy - rowH * 0.04f else cy + valueSize * 0.36f
      val iconColor = if (it.battery) color else withAlpha(accent, 0.9f)
      val iconY = vy - iconS * 0.8f
      if (it.icon == "battery") {
        drawBatteryIcon(canvas, paint, Path(), x, iconY, iconS, iconColor, it.level, it.charging)
      } else {
        statIconRes(it.icon)?.let { drawTintedIcon(context, canvas, it, x, iconY, iconS, iconColor) }
      }
      drawText(canvas, paint, it.value, x + iconS + valueSize * 0.3f, vy, bold, valueSize, color)
      if (showLabels) {
        drawText(canvas, paint, it.label, x + 0.5f, cy + rowH * 0.36f, body, labelSize, labelClr, trackingDp = labelSize * 0.1f)
      }
    }
  }

  /** "What this ride would have cost in each mode" — one chip per mode, in the app's own
   * mode colours. */
  private fun drawModeStrip(context: Context, canvas: Canvas, paint: Paint, m: Rect, s: RenderState, theme: Theme, fam: FontProvider) {
    val modes = listOf("eco", "ride", "speed", "turbo")
    val cellW = m.w / 4f
    val size = clamp(m.h * 0.46f, 9f, 13f)
    val iconS = size * 1.1f
    val bold = fam.get(700)
    val body = fam.get(600)
    for (i in modes.indices) {
      val mode = modes[i]
      val x = m.x + i * cellW
      val color = MODE_COLORS.getValue(mode)
      val raw = s.modeCost[mode]
      val value = if (raw == null) "–" else "${raw.roundToInt()}%"
      val vw = measure(paint, value, bold, size)
      val total = iconS + size * 0.28f + vw
      val sx = x + (cellW - total) / 2f
      val iconRes = if (mode == "speed") R.drawable.ic_widget_mode_speed else statIconRes(mode)
      iconRes?.let { drawTintedIcon(context, canvas, it, sx, m.y + m.h * 0.08f, iconS, color) }
      drawText(canvas, paint, value, sx + iconS + size * 0.28f, m.y + m.h * 0.08f + iconS * 0.82f, bold, size, color)
      // +2dp and a whiter color, same reasoning/treatment as the stat grid's labels above.
      drawText(canvas, paint, mode.uppercase(), x + cellW / 2f, m.y + m.h, body, size * 0.66f + 2f, labelColor(theme), Paint.Align.CENTER, trackingDp = size * 0.06f)
    }
  }

  // ================= shared formatting =================
  //
  // CityroamWidgetProvider.toRenderState builds RenderState's pre-formatted display strings
  // (stateLabel/meta/durationText) from these — kept here rather than in the provider so
  // every piece of "how a number becomes what's on screen" logic lives in one file, next
  // to the drawing code that was ported from widget.js alongside it.

  internal fun formatElapsed(totalSec: Long): String {
    val mm = totalSec / 60
    val ss = totalSec % 60
    return String.format(java.util.Locale.US, "%02d:%02d", mm, ss)
  }

  internal fun formatDuration(totalSec: Long): String {
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    return if (h > 0) String.format(java.util.Locale.US, "%dh %02dm", h, m) else String.format(java.util.Locale.US, "%dm", m)
  }

  internal fun formatDate(epochMs: Long): String {
    if (epochMs <= 0) return "–"
    return java.text.SimpleDateFormat("MMM d", java.util.Locale.getDefault()).format(java.util.Date(epochMs))
  }

  private fun renderEmpty(canvas: Canvas, paint: Paint, w: Float, h: Float, theme: Theme, accent: Int, fam: FontProvider, needle: String) {
    val r = clamp(min(w * 0.34f, h * 0.3f), 26f, 78f)
    val cy = h * 0.42f
    drawGauge(
      canvas, paint, w / 2f, cy, r,
      value = 0.0, ceiling = 30f, marker = null, accent = accent, theme = theme,
      needleColor = if (needle == "ink") theme.text else accent, fam = fam,
      big = "0.0", unit = "km/h", caption = null,
    )
    val size = clamp(w * 0.04f, 9f, 13f)
    drawText(canvas, paint, "No rides yet", w / 2f, cy + r + size * 1.9f, fam.get(700), size * 1.15f, theme.text, Paint.Align.CENTER)
    if (h > 170f) {
      drawText(canvas, paint, "Connect your board and go for a spin", w / 2f, cy + r + size * 3.5f, fam.get(600), size, theme.faint, Paint.Align.CENTER)
    }
  }
}
