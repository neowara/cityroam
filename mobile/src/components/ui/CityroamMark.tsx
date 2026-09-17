import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Path, Polygon } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Text } from '@/components/Themed';

/**
 * Cityroam rebrand mark.
 *
 * A route glyph, not a wheel or a wave: a start dot, a dashed trail that wanders
 * before arriving, an X destination marker — literally "A to B, not a straight
 * line," matching the app's actual GPS-tracking feature. Geometry is shared with
 * the master SVGs in cityroam-website's prototype/cityroam-icons/ (and the widget's
 * native drawRouteGlyph) — the dash offset 9.25 against dasharray 9/11 is measured
 * against this exact path so the trail emerges at the dot's edge and ends under
 * the X; change the path here and in those copies together. Rendered against
 * whatever background color is passed in; `dotColor`/`xColor` default to the
 * rebrand's amber (`#ffa63d`, see lib/theme.tsx's ACCENT_COLORS.amber).
 */
export function CityroamMark({
  size = 32,
  routeColor,
  dotColor = '#ffa63d',
  xColor = '#ffa63d',
}: {
  size?: number;
  routeColor: string;
  dotColor?: string;
  xColor?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Path
        d="M 22 70 C 28 83, 48 86, 56 73 C 64 60, 50 50, 58 39 C 62 33, 69 29.5, 76 28"
        fill="none"
        stroke={routeColor}
        strokeWidth={7.5}
        strokeLinecap="round"
        strokeDasharray="9 11"
        strokeDashoffset={9.25}
      />
      <Circle cx={22} cy={70} r={9.5} fill={dotColor} />
      <Line x1={70.5} y1={22.5} x2={81.5} y2={33.5} stroke={xColor} strokeWidth={5.5} strokeLinecap="round" />
      <Line x1={70.5} y1={33.5} x2={81.5} y2={22.5} stroke={xColor} strokeWidth={5.5} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * The wordmark is a 1:1 port of cityroam-website's hero lockup (`src/pages/index.astro`,
 * the `.word` + `.roam` pair), so every number below is the website's own: the same
 * 560x160 authoring box, the same path, stroke, dot radii and opacities.
 *
 * `ROUTE_SEGMENTS` restates that path's S-commands as explicit cubic control points
 * because RN has no CSS `offset-path` — the travelling dot's position has to be
 * computed, and only an explicit form can be evaluated. It must stay in sync with
 * `ROUTE_PATH_D`, which is the website's path string verbatim.
 */
const ROUTE_PATH_D = 'M6,90 C 70,10 130,150 200,70 S 320,10 380,95 S 480,150 540,120';

const ROUTE_SEGMENTS = [
  { p0: [6, 90], c1: [70, 10], c2: [130, 150], p1: [200, 70] },
  { p0: [200, 70], c1: [270, -10], c2: [320, 10], p1: [380, 95] },
  { p0: [380, 95], c1: [440, 180], c2: [480, 150], p1: [540, 120] },
] as const;

function pointOnRoute(t: number) {
  'worklet';
  const clamped = Math.min(Math.max(t, 0), 1);
  const scaled = clamped * ROUTE_SEGMENTS.length;
  const index = Math.min(Math.floor(scaled), ROUTE_SEGMENTS.length - 1);
  const localT = scaled - index;
  const seg = ROUTE_SEGMENTS[index];
  const mt = 1 - localT;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * localT;
  const c = 3 * mt * localT * localT;
  const d = localT * localT * localT;
  return {
    x: a * seg.p0[0] + b * seg.c1[0] + c * seg.c2[0] + d * seg.p1[0],
    y: a * seg.p0[1] + b * seg.c1[1] + c * seg.c2[1] + d * seg.p1[1],
  };
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const LOOP_DURATION_MS = 7000;
// The website's dot.t1-t4: `animation-delay` -0.35s/-0.7s/-1.05s/-1.4s of the 7s loop,
// at 8/6/5/4px diameter against the lead dot's 10px.
const TRAIL = [
  { offset: 0.05, r: 4, opacity: 0.7 },
  { offset: 0.1, r: 3, opacity: 0.5 },
  { offset: 0.15, r: 2.5, opacity: 0.35 },
  { offset: 0.2, r: 2, opacity: 0.2 },
] as const;

function RouteDot({
  progress,
  offset,
  r,
  opacity,
  color,
}: {
  progress: SharedValue<number>;
  offset: number;
  r: number;
  opacity: number;
  color: string;
}) {
  const animatedProps = useAnimatedProps(() => {
    const t = (((progress.get() - offset) % 1) + 1) % 1;
    const { x, y } = pointOnRoute(t);
    return { cx: x, cy: y };
  });
  return <AnimatedCircle animatedProps={animatedProps} r={r} fill={color} opacity={opacity} />;
}

// Ratios taken off the website's own lockup at its clamp maximum (86.4px word against a
// 420x120 route box), expressed per font-size unit so the pair scales together at any size.
// The vertical offset is the one deliberate departure: the site drops the route below the
// word, this sits it ~20% of a route-box higher so the trail runs behind the letters.
const ROUTE_W_PER_FONT_SIZE = 4.86;
const ROUTE_H_PER_FONT_SIZE = 1.39;
const ROUTE_TOP_PER_FONT_SIZE = 0.44;
const LINE_HEIGHT_RATIO = 1.25;

/** Cityroam wordmark — a port of cityroam-website's hero lockup: the "city"/"roam" word
 * in the brand display face over the winding route glyph, with an amber lead dot and
 * four fainter trailing dots actually travelling the curve. The route sits behind the
 * word and runs slightly wider than it, exactly as on the site. */
export function CityroamWordmark({
  size = 30,
  cityColor,
  roamColor = '#ffa63d',
}: {
  size?: number;
  cityColor: string;
  roamColor?: string;
}) {
  const base = {
    fontFamily: 'ClashDisplay_Bold',
    fontSize: size,
    lineHeight: size * LINE_HEIGHT_RATIO,
    letterSpacing: -0.02 * size,
  };
  const routeWidth = size * ROUTE_W_PER_FONT_SIZE;
  const routeHeight = size * ROUTE_H_PER_FONT_SIZE;
  const routeTop = size * ROUTE_TOP_PER_FONT_SIZE;
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    progress.set(withRepeat(withTiming(1, { duration: LOOP_DURATION_MS, easing: Easing.linear }), -1, false));
  }, [reducedMotion, progress]);

  return (
    <View style={{ width: routeWidth, height: routeTop + routeHeight, alignSelf: 'center' }}>
      <Svg style={{ position: 'absolute', left: 0, top: routeTop }} width={routeWidth} height={routeHeight} viewBox="0 0 560 160">
        <Path d={ROUTE_PATH_D} fill="none" stroke={cityColor} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="4 6" opacity={0.6} />
        {TRAIL.map((dot) => (
          <RouteDot key={dot.offset} progress={progress} offset={dot.offset} r={dot.r} opacity={dot.opacity} color={cityColor} />
        ))}
        <RouteDot progress={progress} offset={0} r={5} opacity={1} color={roamColor} />
        <Circle cx={6} cy={90} r={5} fill={roamColor} />
        <Polygon points="542,114 552,119 542,124" fill={roamColor} />
      </Svg>

      <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        <Text style={{ ...base, color: cityColor }}>city</Text>
        <Text style={{ ...base, color: roamColor }}>roam</Text>
      </View>
    </View>
  );
}
