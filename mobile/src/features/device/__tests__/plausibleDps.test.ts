import { dropImplausibleDps } from '@/features/device/deviceLink/plausibleDps';

describe('dropImplausibleDps', () => {
  it('drops the placeholder zeros in the first burst after a handshake', () => {
    // Real sequence from a board: dp12=0, dp20=0 first, then dp12=7920 five seconds later.
    expect(dropImplausibleDps({ '12': 0, '20': 0, '3': 100 })).toEqual({ '3': 100 });
    expect(dropImplausibleDps({ '12': 7920 })).toEqual({ '12': 7920 });
  });

  it('keeps a zero-valued reading that can genuinely be zero', () => {
    expect(dropImplausibleDps({ '2': 0, '5': 0 })).toEqual({ '2': 0, '5': 0 });
  });

  it('keeps an odometer lower than before, since the controller can fall back to an older total', () => {
    // Real case: the board reported 964.1 km on one day and 792.0 km two days later.
    expect(dropImplausibleDps({ '12': 7920 })).toEqual({ '12': 7920 });
  });
});
