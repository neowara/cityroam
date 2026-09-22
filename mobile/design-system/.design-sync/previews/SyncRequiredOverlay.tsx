import { View, SyncRequiredOverlay } from 'cityroam-design-system';

export const Idle = () => (
  <View style={{ position: 'relative', width: 320, height: 180, overflow: 'hidden', borderRadius: 12, backgroundColor: '#eee' }}>
    <SyncRequiredOverlay onRetry={() => {}} retrying={false} />
  </View>
);

export const Retrying = () => (
  <View style={{ position: 'relative', width: 320, height: 180, overflow: 'hidden', borderRadius: 12, backgroundColor: '#eee' }}>
    <SyncRequiredOverlay onRetry={() => {}} retrying />
  </View>
);
