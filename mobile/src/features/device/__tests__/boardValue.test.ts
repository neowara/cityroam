import { humanizeEnumValue, decodeScaled, encodeScaled, formatScaled, scaledValue, formatDpValue } from '@/features/device/boardValue';

describe('humanizeEnumValue', () => {
  it('title-cases a single word', () => {
    expect(humanizeEnumValue('forward')).toBe('Forward');
    expect(humanizeEnumValue('km')).toBe('Km');
  });

  it('splits underscore codes into words', () => {
    expect(humanizeEnumValue('level_1')).toBe('Level 1');
    expect(humanizeEnumValue('ride_mode')).toBe('Ride Mode');
  });

  it('handles empty words without crashing', () => {
    expect(humanizeEnumValue('a__b')).toBe('A  B');
  });
});

describe('decodeScaled / encodeScaled', () => {
  it('is a no-op at scale 0 or undefined', () => {
    expect(decodeScaled(1234)).toBe(1234);
    expect(decodeScaled(1234, 0)).toBe(1234);
    expect(encodeScaled(12.34)).toBe(12);
    expect(encodeScaled(12.34, 0)).toBe(12);
  });

  it('decodes raw integers by 10^scale', () => {
    expect(decodeScaled(1234, 2)).toBeCloseTo(12.34, 5);
    expect(decodeScaled(215, 1)).toBeCloseTo(21.5, 5);
  });

  it('encodes display values back to raw integers', () => {
    expect(encodeScaled(12.34, 2)).toBe(1234);
    expect(encodeScaled(21.5, 1)).toBe(215);
  });
});

describe('formatScaled', () => {
  it('formats with fixed scale decimals', () => {
    expect(formatScaled(1234, 2)).toBe('12.34');
    expect(formatScaled(215, 1)).toBe('21.5');
  });

  it('formats without scale as a plain integer string', () => {
    expect(formatScaled(42)).toBe('42');
    expect(formatScaled(42, 0)).toBe('42');
  });
});

describe('scaledValue', () => {
  it('returns null for non-number values', () => {
    expect(scaledValue('2', 'nope')).toBeNull();
    expect(scaledValue('2', null)).toBeNull();
    expect(scaledValue('2', true)).toBeNull();
  });

  it('decodes numeric values at the given scale', () => {
    expect(scaledValue('20', 1234, 2)).toBeCloseTo(12.34, 5);
    expect(scaledValue('2', 215, 1)).toBeCloseTo(21.5, 5);
    expect(scaledValue('3', 99)).toBe(99);
  });
});

describe('formatDpValue', () => {
  it('formats numbers with an optional unit', () => {
    expect(formatDpValue('3', 87, { unit: '%' })).toBe('87%');
    expect(formatDpValue('3', 87)).toBe('87');
  });

  it('applies scale before attaching the unit', () => {
    expect(formatDpValue('20', 1234, { unit: 'V', scale: 1 })).toBe('123.4V');
  });

  it('renders booleans as On/Off', () => {
    expect(formatDpValue('8', true)).toBe('On');
    expect(formatDpValue('8', false)).toBe('Off');
  });

  it('stringifies any other value', () => {
    expect(formatDpValue('11', 'km')).toBe('km');
    expect(formatDpValue('11', null)).toBe('null');
  });
});
