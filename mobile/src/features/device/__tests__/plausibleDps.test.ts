import { dropImplausibleDps } from '@/features/device/deviceLink/plausibleDps';

describe('dropImplausibleDps', () => {
  it('drops the placeholder zeros in the first burst after a handshake', () => {
    // Real sequence from a board: dp12=0, dp20=0 first, then dp12=7920 five seconds later.
    expect(dropImplausibleDps(null, { '12': 0, '20': 0, '3': 100 })).toEqual({ '3': 100 });
    expect(dropImplausibleDps({ '3': 100 }, { '12': 7920 })).toEqual({ '12': 7920 });
  });

  it('keeps a zero-valued reading that can genuinely be zero', () => {
    expect(dropImplausibleDps({ '12': 7920 }, { '2': 0, '5': 0 })).toEqual({ '2': 0, '5': 0 });
  });

  it('never lets the odometer count down', () => {
    expect(dropImplausibleDps({ '12': 8159 }, { '12': 8100, '2': 30 })).toEqual({ '2': 30 });
    expect(dropImplausibleDps({ '12': 8159 }, { '12': 8160 })).toEqual({ '12': 8160 });
  });
});
