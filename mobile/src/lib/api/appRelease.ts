import { requestPublic } from '@/lib/api/client';

export type LatestRelease = {
  version: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  assetName: string;
  sizeBytes: number;
  sha256: string | null;
};

// GET /app/latest-release and POST /app/releases/{version}/download-url are public, with
// no login required, because an update check has to reach a rider who can't sign in.
// requestPublic never attaches a Bearer token and never triggers the 401-clears-session
// path, unlike every other call in this file.
export const appReleaseApi = {
  /** `undefined` when there's no usable release (the backend's own 204) — never throws
   * for "nothing to report," only for a genuine network/backend failure. */
  latestRelease: () => requestPublic<LatestRelease | undefined>('/app/latest-release'),
  /** Mints a short-lived signed download URL for the given version — only ever the
   * latest release; the backend 404s for anything else. Resolve this right before
   * starting the download, not ahead of time — it expires in minutes. */
  releaseDownloadUrl: (version: string) =>
    requestPublic<{ url: string }>(`/app/releases/${encodeURIComponent(version)}/download-url`, { method: 'POST' }),
};
