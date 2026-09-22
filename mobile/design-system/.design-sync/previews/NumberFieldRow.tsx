import { View, NumberFieldRow, Colors } from 'cityroam-design-system';

const { light } = Colors;

const schema = {
  '2': { id: '2', code: 'speed', name: 'Max speed', type: 'obj', min: 0, max: 60, step: 1, scale: 0, unit: 'km/h' },
};

function Row(props: { rawDps: Record<string, unknown>; drafts: Record<string, string | number>; justSaved?: boolean }) {
  return (
    <View style={{ width: 320, backgroundColor: light.surface, borderRadius: 12, paddingHorizontal: 14 }}>
      <NumberFieldRow
        label="Max speed"
        dpId="2"
        rawDps={props.rawDps}
        drafts={props.drafts}
        schema={schema}
        accentColor="#ffa63d"
        inkDim={light.inkDim}
        text={light.text}
        good={light.good}
        justSaved={!!props.justSaved}
        onChange={() => {}}
        last
        fallbackUnit="km/h"
      />
    </View>
  );
}

// Settled state: current value matches raw, no draft pending.
export const Canonical = () => <Row rawDps={{ '2': 25 }} drafts={{}} />;

// A pending edit hasn't been saved yet — row value renders in the accent color.
export const PendingChange = () => <Row rawDps={{ '2': 25 }} drafts={{ '2': 32 }} />;

// Just confirmed a save — check mark appears next to the value.
export const JustSaved = () => <Row rawDps={{ '2': 32 }} drafts={{}} justSaved />;
