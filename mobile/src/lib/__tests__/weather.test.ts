import { compassDirection } from '@/lib/weather';

describe('compassDirection', () => {
  it('maps the 4 cardinal points', () => {
    expect(compassDirection(0)).toBe('N');
    expect(compassDirection(90)).toBe('E');
    expect(compassDirection(180)).toBe('S');
    expect(compassDirection(270)).toBe('W');
  });

  it('rounds to the nearest of 16 points', () => {
    expect(compassDirection(10)).toBe('N');
    expect(compassDirection(23)).toBe('NNE');
  });

  it('wraps 360 back to N', () => {
    expect(compassDirection(360)).toBe('N');
    expect(compassDirection(359)).toBe('N');
  });

  it('handles negative degrees', () => {
    expect(compassDirection(-10)).toBe('N');
  });

  it('returns a fallback string for a missing reading', () => {
    expect(compassDirection(null)).toBe('an unknown direction');
    expect(compassDirection(undefined)).toBe('an unknown direction');
  });
});
