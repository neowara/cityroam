import { ScreenHeader } from 'cityroam-design-system';
import { MapPinIcon, SettingsIcon } from './_icons';

export const TripsScreen = () => <ScreenHeader icon={MapPinIcon} title="Trips" />;

export const SettingsScreen = () => <ScreenHeader icon={SettingsIcon} title="Settings" />;

export const LongTitle = () => <ScreenHeader icon={MapPinIcon} title="Ride history and stats" />;
