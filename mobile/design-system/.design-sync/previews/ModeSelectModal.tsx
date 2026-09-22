import { View, ModeSelectModal } from 'cityroam-design-system';

// See AppModal.tsx's Spacer comment — same fixed-position containing-block fix.
const Spacer = () => <View style={{ height: 640, width: 1 }} />;

export const RideSelected = () => (
  <>
    <Spacer />
    <ModeSelectModal visible current="ride" onSelect={() => {}} onClose={() => {}} />
  </>
);

export const TurboSelected = () => (
  <>
    <Spacer />
    <ModeSelectModal visible current="turbo" onSelect={() => {}} onClose={() => {}} />
  </>
);
