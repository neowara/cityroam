package expo.modules.boardble

/**
 * Bounded, in-memory record of every client's step lines, independent of whether JS is
 * currently listening.
 *
 * The connection foreground service's own client runs with a logcat-only listener until (if ever)
 * JS calls `connectDirect` and adopts it — before that point its progress was only ever
 * visible over a USB cable. This is what makes it visible without one: it's read by the
 * `BoardBle.recentDiagnostics()` module function for the debug console / exported
 * diagnostics.
 */
object BoardBleDiagnostics {
  private const val MAX_LINES = 200
  private val lines = java.util.Collections.synchronizedList(ArrayList<String>())

  fun record(devId: String, line: String) {
    val stamped = "${System.currentTimeMillis()} $devId $line"
    synchronized(lines) {
      lines.add(stamped)
      while (lines.size > MAX_LINES) lines.removeAt(0)
    }
  }

  fun recent(): List<String> = synchronized(lines) { lines.toList() }
}
