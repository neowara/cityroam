import { Text as RNText, type TextStyle } from 'react-native';

import { Text } from '@/components/Themed';
import { MODE_META, MODE_ORDER, type Mode } from '@/lib/mode';

// A mode mention rendered in the mode's own colour — the single reusable way to show a
// mode name ("Eco", "Ride", "Speed", "Turbo") in running text, so every mention across
// the app is colour-coded consistently and can't drift from MODE_META. Replaces the
// ad-hoc `<Text style={{ color: MODE_META[m]?.color }}>{MODE_META[m]?.label}</Text>`
// snippets that used to be scattered around (TripByModeModule, RangeEstimateModule,
// planner, board-config, ...).

type ModeTextProps = {
  /** The mode key ("eco" | "ride" | "speed" | "turbo") or any raw mode string. */
  mode: string;
  /** When true (a mixed-mode trip), blend the mode colours into the word itself. */
  mixed?: boolean;
  /** The modes the ride's device has (its device profile) — a mixed ride only blends
   *  those. Defaults to every mode. */
  modes?: readonly Mode[];
  /** Render the label lowercased (for mid-sentence mentions like "the mode you rode"). */
  lowercase?: boolean;
  /** Override the rendered word (e.g. "Mixed modes" for a mixed-mode chip) — colouring
   *  still follows `mode`/`mixed`, only the text differs from MODE_META[mode].label. */
  label?: string;
  /** Extra text styling — font size, weight, etc. Colour is always the mode's own. */
  style?: TextStyle | TextStyle[];
};

/** Split a string into `n` roughly-equal parts (for the mixed-mode colour blend). */
function splitInto(str: string, n: number): string[] {
  if (n <= 1 || str.length === 0) return [str];
  const parts: string[] = [];
  const base = Math.ceil(str.length / n);
  for (let i = 0; i < n; i++) {
    const part = str.slice(i * base, Math.min((i + 1) * base, str.length));
    if (part.length === 0) break;
    parts.push(part);
  }
  return parts;
}

export function ModeText({ mode, mixed = false, modes = MODE_ORDER, lowercase = false, label, style }: ModeTextProps) {
  const meta = MODE_META[mode];
  const baseLabel = label ?? meta?.label ?? mode;
  const renderedLabel = lowercase ? baseLabel.toLowerCase() : baseLabel;

  if (mixed) {
    // Blend the device's mode colours into the word: split the label into one segment
    // per mode and tint each with that mode's colour, slowest mode first.
    const colors = modes.map((m) => MODE_META[m].color);
    const segments = splitInto(renderedLabel, colors.length);
    return (
      <Text style={style}>
        {segments.map((seg, i) => (
          <RNText key={i} style={{ color: colors[i % colors.length], fontWeight: '600' }}>
            {seg}
          </RNText>
        ))}
      </Text>
    );
  }

  return <Text style={[style, { color: meta?.color }]}>{renderedLabel}</Text>;
}
