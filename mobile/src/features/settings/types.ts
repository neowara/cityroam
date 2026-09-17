import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react-native';

export const GROUP_KEYS = [
  'account',
  'connection',
  'tracking',
  'notifications',
  'health',
  'appearance',
  'widget',
  'advanced',
  'about',
] as const;

export type GroupKey = (typeof GROUP_KEYS)[number];

export type SettingsGroup = {
  key: GroupKey;
  label: string;
  icon: LucideIcon;
  /** Short summary shown on the hub tile. */
  status?: string;
  content: ReactNode;
  /** Modals the group owns. Rendered at the screen root so they work while the hub is showing. */
  overlay?: ReactNode;
};
