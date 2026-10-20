// A stable id for this browser, sent with every queued scan (events.device_id) so an audit can tell
// which tablet or PC a scan came from. Browser-only.

const KEY = "ct-device-id";
let cached: string | null = null;

export function getDeviceId(): string {
  if (cached) return cached;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) return (cached = stored);
    const id = crypto.randomUUID();
    window.localStorage.setItem(KEY, id);
    return (cached = id);
  } catch {
    // Storage blocked (private mode, for example): the id then lasts for this page only.
    return (cached ??= crypto.randomUUID());
  }
}
