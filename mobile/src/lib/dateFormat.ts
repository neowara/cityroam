// Shared "Aug 23 · 12:56 PM" format so Rides, Activity, and Trip detail don't drift independently.
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}
