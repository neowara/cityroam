import { request } from '@/lib/api/client';

// Wire shape for POST /logs (backend's LogEvent model). deviceTime is sent as an
// ISO-8601 UTC string (new Date().toISOString()); `data` is optional stringified
// JSON. When `data` is undefined JSON.stringify omits the key entirely — the same
// wire shape the old raw fetch produced.
export type LogEntry = {
  deviceTime: string;
  tag: string;
  message: string;
  data?: string;
};

export const logsApi = {
  postLog: (entry: LogEntry) => request<void>('/logs', { method: 'POST', body: JSON.stringify(entry) }),
};
