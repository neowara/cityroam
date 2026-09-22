import { View, AppModal, ConfirmModalBody } from 'cityroam-design-system';
import { AlertTriangleIcon, LogOutIcon } from './_icons';

// See AppModal.tsx's Spacer comment — same fixed-position containing-block fix.
const Spacer = () => <View style={{ height: 640, width: 1 }} />;

export const Default = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}}>
      <ConfirmModalBody
        icon={<AlertTriangleIcon size={28} color="#ffa63d" />}
        title="Delete this ride?"
        body="This can't be undone. The ride and its route will be permanently removed."
        confirmLabel="Delete"
        onConfirm={() => {}}
        destructive
      />
    </AppModal>
  </>
);

export const NonDestructive = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}}>
      <ConfirmModalBody
        icon={<LogOutIcon size={28} color="#ffa63d" />}
        title="Log out?"
        body="You can always sign back in later — your rides stay saved."
        confirmLabel="Log out"
        onConfirm={() => {}}
      />
    </AppModal>
  </>
);
