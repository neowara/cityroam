import { View, SliderRow, Colors } from 'cityroam-design-system';

const { light } = Colors;

function Row(props: {
  value: number;
  draft: number;
  confirmed?: boolean;
  justSaved?: boolean;
}) {
  return (
    <View style={{ width: 320, backgroundColor: light.surface, borderRadius: 12, paddingHorizontal: 14 }}>
      <SliderRow
        label="Ride level"
        dpId="14"
        value={props.value}
        draft={props.draft}
        range={{ min: 1, max: 5, step: 1 }}
        unit=""
        confirmed={props.confirmed ?? true}
        accentColor="#ffa63d"
        inkDim={light.inkDim}
        text={light.text}
        warn={light.warn}
        good={light.good}
        justSaved={!!props.justSaved}
        onChange={() => {}}
        resetKey={0}
      />
    </View>
  );
}

// Settled, confirmed value with no pending draft.
export const Canonical = () => <Row value={3} draft={3} />;

// Device hasn't confirmed this setting yet — the "unconfirmed" warning badge shows.
export const Unconfirmed = () => <Row value={3} draft={3} confirmed={false} />;

// A save just landed — check mark next to the accent-colored value.
export const JustSaved = () => <Row value={4} draft={4} justSaved />;
