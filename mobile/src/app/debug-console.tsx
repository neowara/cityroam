import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItemInfo } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import { Terminal, Trash2, Share2, Pause, Play } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { GlassBackdrop } from '@/components/ui/GlassBackdrop';
import { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '@/components/ui/FloatingBackHeader';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { appBuildInfo, clearLog, exportLogForSharing, type LogLine } from '@/lib/log';
import { MAX_LIVE_LINES, subscribeToLog } from '@/lib/liveLogTail';
import { DiagnosticsPanel } from '@/features/device/components/DiagnosticsPanel';

/** a live, in-app view of what the app is actually doing right
 * now, since chasing a real-device bug (e.g. "did the foreground service actually keep
 * running this whole ride?") by asking the user to "share the debug log" after the fact
 * and hoping the right lines are in there is slow and indirect. This reads the same
 * `logEvent` stream every part of the app already calls, live, no extra plumbing per
 * call site. */
export default function DebugConsoleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const crit = useThemeColor({}, 'crit');
  const line = useThemeColor({}, 'line');

  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const listRef = useRef<FlatList<LogLine>>(null);
  // Buffers lines that arrive while paused so nothing is lost, just not rendered/
  // auto-scrolled until resumed — pausing is for reading a specific moment steady,
  // not for missing what happens next.
  const pausedBufferRef = useRef<LogLine[] | null>(null);
  // Mirrors `paused` for the subscription listener below to read. A ref instead of
  // closing over the `paused` state directly: subscribing once at mount (see the
  // empty-deps effect) means the listener closure is created once and never replaced,
  // so it needs a way to see the *current* pause state on every call, not the value
  // from whenever it was created. Updated synchronously in togglePause, not via a
  // passive effect, so there's no window between "user tapped Pause" and "the
  // listener actually treats new lines as paused" for a fast-arriving log line to slip
  // through (code review finding — re-subscribing per paused-change had exactly this race).
  const pausedRef = useRef(false);

  useEffect(() => {
    return subscribeToLog((liveLines) => {
      if (pausedRef.current) {
        pausedBufferRef.current = liveLines;
        return;
      }
      setLines(liveLines);
    });
  }, []);

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    // A plain statement here, not inside setPaused's functional updater (which React
    // may invoke more than once, e.g. under StrictMode) — this side effect must run
    // exactly once per real tap (code review finding).
    if (!next && pausedBufferRef.current) {
      setLines(pausedBufferRef.current);
      pausedBufferRef.current = null;
    }
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<LogLine>) => {
      const time = item.deviceTime.slice(11, 19); // HH:MM:SS, deviceTime is a full ISO string
      const isErrorish = /fail|error|denied|blocked/i.test(item.message);
      return (
        <View style={styles.row}>
          <Text style={[styles.time, { color: inkFaint }]}>{time}</Text>
          <Text style={[styles.tag, { color: accentColor }]}>[{item.tag}]</Text>
          <Text style={[styles.message, { color: isErrorish ? crit : inkDim }]}>
            {item.message}
            {item.data !== undefined ? ` ${safeStringifyForDisplay(item.data)}` : ''}
          </Text>
        </View>
      );
    },
    [accentColor, crit, inkDim, inkFaint],
  );

  const build = appBuildInfo();

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <Text style={[styles.subtitle, { color: inkDim, marginTop: insets.top + PILL_TOP_OFFSET + PILL_CLEARANCE }]}>
        {/* Which build is producing these lines, on screen rather than only in the file. */}v{String(build.version)}
        {build.versionCode != null ? ` (${String(build.versionCode)})` : ''} · {build.dev ? 'dev' : 'release'} · Live log, last{' '}
        {lines.length} line{lines.length === 1 ? '' : 's'}
        {lines.length >= MAX_LIVE_LINES ? ` (older lines are in the shared log file)` : ''}.
      </Text>

      <DiagnosticsPanel />

      <View style={[styles.toolbar, { borderColor: line }]}>
        <PressableScale onPress={togglePause} style={styles.toolbarButton} hitSlop={8}>
          {paused ? <Play size={16} color={accentColor} /> : <Pause size={16} color={accentColor} />}
          <Text style={[styles.toolbarButtonText, { color: accentColor }]}>{paused ? 'Resume' : 'Pause'}</Text>
        </PressableScale>
        <PressableScale
          onPress={() =>
            Sharing.isAvailableAsync()
              .then((ok) =>
                ok ? Sharing.shareAsync(exportLogForSharing()) : Promise.reject(new Error('Sharing not available on this device')),
              )
              .catch((err) => console.error('[share log]', err))
          }
          style={styles.toolbarButton}
          hitSlop={8}>
          <Share2 size={16} color={accentColor} />
          <Text style={[styles.toolbarButtonText, { color: accentColor }]}>Share</Text>
        </PressableScale>
        <PressableScale
          onPress={() => {
            clearLog();
            setLines([]);
          }}
          style={styles.toolbarButton}
          hitSlop={8}>
          <Trash2 size={16} color={crit} />
          <Text style={[styles.toolbarButtonText, { color: crit }]}>Clear</Text>
        </PressableScale>
      </View>

      <FlatList
        ref={listRef}
        data={lines}
        keyExtractor={(item, index) => `${item.deviceTime}-${index}`}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => {
          if (!paused) listRef.current?.scrollToEnd({ animated: true });
        }}
        ListEmptyComponent={<Text style={[styles.empty, { color: inkFaint }]}>No log lines yet. They appear here as you use the app.</Text>}
      />
      <FloatingBackHeader icon={Terminal} title="Debug console" onPress={() => router.back()} />
    </View>
  );
}

function safeStringifyForDisplay(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  subtitle: { fontSize: 13, lineHeight: 18, marginHorizontal: 20, marginBottom: 10 },
  toolbar: {
    flexDirection: 'row',
    gap: 16,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarButton: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  toolbarButtonText: { fontSize: 13, fontWeight: '600' },
  list: { flex: 1, paddingHorizontal: 20 },
  listContent: { paddingBottom: 24 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 3 },
  time: { fontSize: 11, fontFamily: 'SpaceMono' },
  tag: { fontSize: 11, fontFamily: 'SpaceMono', fontWeight: '700' },
  message: { fontSize: 11, fontFamily: 'SpaceMono', flexShrink: 1 },
  empty: { fontSize: 13, textAlign: 'center', marginTop: 40 },
});
