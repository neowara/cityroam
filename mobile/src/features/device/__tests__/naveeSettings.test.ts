import { NAVEE_MODE_DRIVE, NAVEE_MODE_ECO, NAVEE_SETTING_SECTIONS } from '@/features/device/navee/settings';

function field(key: string) {
  return NAVEE_SETTING_SECTIONS.flatMap((section) => section.fields).find((f) => f.key === key);
}

describe('navee setting options', () => {
  // Captured from the vendor app driving a real V40i Pro: picking Low, Medium and High
  // sent 0x53 with 30, 60 and 90. The scooter accepts any byte here and reports it back
  // unchanged, so a wrong scale looks like it worked while disabling the regen.
  it('energy recovery sends the strengths the scooter expects', () => {
    const ers = field('energyRecovery');
    if (ers?.kind !== 'choice') throw new Error('energy recovery should be a choice field');
    expect(ers.options(null)).toEqual([
      { value: 30, label: 'Low' },
      { value: 60, label: 'Medium' },
      { value: 90, label: 'High' },
    ]);
  });

  // Walking is a push-along assist, not a riding level — it has its own switch on the
  // settings screen (sharing the FAB's useNaveeWalkAssist), not a third option here.
  it('ride mode offers eco and drive only, not walking', () => {
    const rideMode = field('rideMode');
    if (rideMode?.kind !== 'choice') throw new Error('rideMode should be a choice field');
    expect(rideMode.options(null)).toEqual([
      { value: NAVEE_MODE_ECO, label: 'Eco' },
      { value: NAVEE_MODE_DRIVE, label: 'Drive' },
    ]);
  });
});
