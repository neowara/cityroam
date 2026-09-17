import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: { flex: 1 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  link: { fontSize: 13, opacity: 0.9 },
  // Bottom padding clears the floating tab bar.
  content: { padding: 20, paddingBottom: 160, gap: 4 },
  section: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
    opacity: 0.6,
  },
  label: { fontSize: 13, marginTop: 10, marginBottom: 4, opacity: 0.8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, gap: 8 },
  rowLabel: { fontSize: 15, flexShrink: 1 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#8884', borderRadius: 10, padding: 12, fontSize: 15 },
  cardGap: { gap: 8 },
  button: { marginTop: 16, borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonNoMargin: { marginTop: 0 },
  buttonText: { color: '#fff', fontWeight: '600' },
  smallButton: { borderRadius: 8, paddingVertical: 7, paddingHorizontal: 14 },
  smallButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  status: { marginTop: 10, fontSize: 13, flexShrink: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  statusRowInline: { marginTop: 0 },
  statusInline: { marginTop: 0 },
  statusError: { color: '#e5484d' },
  linkText: { fontSize: 12, marginTop: 6, marginBottom: 4 },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  notificationRow: { paddingVertical: 8, gap: 3 },
  notificationLink: { fontSize: 12, fontWeight: '600', marginTop: 2 },
});

export const choiceStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8884',
    overflow: 'hidden',
  },
  chipText: { fontSize: 13 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
});

export const modalStyles = StyleSheet.create({
  card: { maxHeight: '80%' },
});
