import { BOARD_DP_SCHEMA, dpWriteType, resolveEnumDps, resolveEnumLabel, toWireDpValue } from '@/features/device/boardDpSchema';

// The read path turns an enum index into its label, so that is what the pickers hold
// and hand back to the write path. The wire only accepts the index, and the native
// encoder calls toInt() on whatever it is given — a label reached it as a crash, not a
// rejected value, so every enum setting failed to save.
describe('enum datapoints survive a round trip', () => {
  const enumDpIds = Object.keys(BOARD_DP_SCHEMA).filter((id) => BOARD_DP_SCHEMA[id].range);

  it('covers the enum datapoints the board actually exposes', () => {
    expect(enumDpIds.length).toBeGreaterThan(0);
  });

  it.each(enumDpIds)('dp%s: index -> label -> index', (dpId) => {
    const range = BOARD_DP_SCHEMA[dpId].range!;
    range.forEach((label, index) => {
      expect(resolveEnumDps({ [dpId]: index })[dpId]).toBe(label);
      expect(toWireDpValue(dpId, label, BOARD_DP_SCHEMA)).toBe(index);
    });
  });

  it.each(enumDpIds)('dp%s is written as an enum', (dpId) => {
    expect(dpWriteType(dpId, BOARD_DP_SCHEMA)).toBe('enum');
  });

  it('leaves an already-numeric enum value alone', () => {
    const dpId = enumDpIds[0];
    expect(toWireDpValue(dpId, 1, BOARD_DP_SCHEMA)).toBe(1);
  });

  it('passes a label the schema does not know through untouched rather than writing 0', () => {
    const dpId = enumDpIds[0];
    expect(toWireDpValue(dpId, 'not-a-real-option', BOARD_DP_SCHEMA)).toBe('not-a-real-option');
  });

  it('leaves non-enum datapoints alone', () => {
    // A speed limit is a bounded numeric, not an enum — it must not be index-mapped.
    expect(toWireDpValue('108', 20, BOARD_DP_SCHEMA)).toBe(20);
    expect(toWireDpValue('108', '20', BOARD_DP_SCHEMA)).toBe('20');
  });
});

// The native ride journal stores an enum datapoint as the bare index the board sent,
// stringified — it has no access to this (JS-side) schema. Readers of the journal must
// resolve it back to a label, or it reaches the UI as a raw "2" (a real shipped bug:
// every mode chip, breakdown and legend rendered the index instead of "Speed").
describe('resolveEnumLabel maps a journal-stored raw index back to its label', () => {
  const enumDpIds = Object.keys(BOARD_DP_SCHEMA).filter((id) => BOARD_DP_SCHEMA[id].range);

  it.each(enumDpIds)('dp%s: stringified index -> label', (dpId) => {
    const range = BOARD_DP_SCHEMA[dpId].range!;
    range.forEach((label, index) => {
      expect(resolveEnumLabel(dpId, String(index))).toBe(label);
      expect(resolveEnumLabel(dpId, index)).toBe(label);
    });
  });

  it('resolves dp14 index 2 to the speed level, matching the schema order', () => {
    expect(resolveEnumLabel('14', '2')).toBe('level_3');
  });

  it('leaves an already-resolved label untouched', () => {
    expect(resolveEnumLabel('14', 'level_3')).toBe('level_3');
  });

  it('leaves an out-of-range index untouched rather than guessing at a label', () => {
    expect(resolveEnumLabel('14', '9')).toBe('9');
    expect(resolveEnumLabel('14', '-1')).toBe('-1');
  });

  it('leaves a non-enum datapoint untouched', () => {
    expect(resolveEnumLabel('108', '2')).toBe('2');
  });
});

// dp1 (board lock), dp8 (headlight), and dp13 (cruise control) carry no range and no
// min/max, same shape as autobrake/remote_power — without the explicit code check they
// fell through to the numeric 'value' default and a bool write would have been encoded
// wrong. dp8 was briefly (wrongly) given a 3-value range before live testing showed the
// board reports and accepts it as a plain bool, not an enum — see
// mobile/modules/board-ble/DATAPOINTS.md.
describe('lock, headlight, and cruise are written as bool switches', () => {
  it.each(['1', '8', '13'])('dp%s is written as a bool', (dpId) => {
    expect(dpWriteType(dpId, BOARD_DP_SCHEMA)).toBe('bool');
  });
});
