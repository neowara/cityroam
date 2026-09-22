import { View, AppModal, StatTile } from 'cityroam-design-system';

// AppModal renders react-native-web's Modal (position: fixed). The review
// harness's single-card wrapper (`.ds-single { transform: translateZ(0) }`)
// becomes the CSS containing block for fixed descendants, and with no other
// in-flow content the wrapper collapses to 0 height — which collapses the
// fixed modal along with it (see NOTES.md). A same-size, invisible in-flow
// spacer alongside it fixes the wrapper's height without touching AppModal.
const Spacer = () => <View style={{ height: 640, width: 1 }} />;

export const Basic = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}} showCloseButton>
      <View style={{ padding: 16, gap: 8 }}>
        <StatTile label="Distance" value="12.4" sub="km" />
        <StatTile label="Duration" value="34" sub="min" />
      </View>
    </AppModal>
  </>
);

export const WithHeaderAndFooter = () => (
  <>
    <Spacer />
    <AppModal
      visible
      onRequestClose={() => {}}
      showCloseButton
      header={
        <View style={{ padding: 16, paddingBottom: 0 }}>
          <StatTile label="Ride summary" value="Ride #482" />
        </View>
      }
      footer={
        <View style={{ padding: 16, backgroundColor: '#ffa63d', borderRadius: 10, alignItems: 'center' }}>
          <StatTile label="" value="Save" />
        </View>
      }>
      <View style={{ padding: 16 }}>
        <StatTile label="Distance" value="12.4" sub="km" />
      </View>
    </AppModal>
  </>
);

export const FullScreen = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}} variant="fullScreen" showCloseButton>
      <View style={{ padding: 16, gap: 8 }}>
        <StatTile label="Distance" value="12.4" sub="km" />
        <StatTile label="Duration" value="34" sub="min" />
        <StatTile label="Avg speed" value="18.2" sub="km/h" />
      </View>
    </AppModal>
  </>
);
