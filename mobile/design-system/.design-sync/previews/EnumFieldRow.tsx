import { View, EnumFieldRow, Colors } from 'cityroam-design-system';

const { light } = Colors;

const schema = {
  '101': { id: '101', code: 'direction', name: 'Direction', type: 'enum', range: ['forward', 'backward'] },
};

function Row(props: { rawDps: Record<string, unknown>; drafts: Record<string, string | number>; justSaved?: boolean }) {
  return (
    <View style={{ width: 320, backgroundColor: light.surface, borderRadius: 12, paddingHorizontal: 14 }}>
      <EnumFieldRow
        label="Direction"
        dpId="101"
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
      />
    </View>
  );
}

// The segmented control's highlight pill always animates in from index 0 on
// mount, so the demo value must be the FIRST option ("forward") or the
// capture lands mid-spring on the wrong segment.
export const Canonical = () => <Row rawDps={{ '101': 'forward' }} drafts={{}} />;

// A save just landed — check mark shows next to the label.
export const JustSaved = () => <Row rawDps={{ '101': 'forward' }} drafts={{}} justSaved />;
