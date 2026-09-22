import { View, AppModal, ChecklistModalBody } from 'cityroam-design-system';
import { AlertTriangleIcon, MapPinIcon } from './_icons';

// ChecklistModalBody is body content meant to go inside AppModal (like
// ConfirmModalBody). See AppModal.tsx's Spacer comment — same fixed-position
// containing-block fix.
const Spacer = () => <View style={{ height: 640, width: 1 }} />;

const TRIPS = [
  { key: 'trip-1', label: 'Sept 12 · Riverside loop · 8.2 km' },
  { key: 'trip-2', label: 'Sept 9 · Downtown commute · 4.1 km' },
  { key: 'trip-3', label: 'Sept 4 · Harbor trail · 11.6 km' },
];

export const PartiallySelected = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}}>
      <ChecklistModalBody
        icon={<AlertTriangleIcon size={28} color="#ffa63d" />}
        title={(n) => `Restore ${n} trips?`}
        bodyText="Restored trips return to your ride history and count toward totals again."
        items={TRIPS}
        selectedKeys={new Set(['trip-1', 'trip-3'])}
        onToggleItem={() => {}}
        onToggleSelectAll={() => {}}
        confirmLabel={(n) => `Restore ${n}`}
        onConfirm={() => {}}
      />
    </AppModal>
  </>
);

export const AllSelected = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}}>
      <ChecklistModalBody
        icon={<MapPinIcon size={28} color="#ffa63d" />}
        title={(n) => `Delete ${n} trips?`}
        bodyText="This can't be undone. Deleted trips are permanently removed."
        items={TRIPS}
        selectedKeys={new Set(TRIPS.map((t) => t.key))}
        onToggleItem={() => {}}
        onToggleSelectAll={() => {}}
        confirmLabel={(n) => `Delete ${n}`}
        onConfirm={() => {}}
      />
    </AppModal>
  </>
);

export const Pending = () => (
  <>
    <Spacer />
    <AppModal visible onRequestClose={() => {}}>
      <ChecklistModalBody
        icon={<AlertTriangleIcon size={28} color="#ffa63d" />}
        title={(n) => `Restore ${n} trips?`}
        bodyText="Restored trips return to your ride history and count toward totals again."
        items={TRIPS}
        selectedKeys={new Set(['trip-1', 'trip-2'])}
        onToggleItem={() => {}}
        onToggleSelectAll={() => {}}
        confirmLabel={(n) => `Restore ${n}`}
        onConfirm={() => {}}
        confirmPending
        confirmPendingLabel="Restoring…"
      />
    </AppModal>
  </>
);
