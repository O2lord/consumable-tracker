// Device clocks drift, and a tablet can be hours out. A queued scan keeps the time the device said it
// happened (events.occurred_at), next to the server's own time (events.recorded_at), so audits can see
// both. The one thing the server will not accept is a time in the future, which would put a scan after
// events that had not happened yet: that is clamped to the server's time and flagged.
// Pure: no I/O.

export const MAX_FUTURE_MS = 5 * 60 * 1000;

export function clampOccurredAt(
  deviceTime: Date,
  serverNow: Date,
  maxFutureMs = MAX_FUTURE_MS,
): { at: Date; skewed: boolean } {
  if (Number.isNaN(deviceTime.getTime())) return { at: serverNow, skewed: true };
  if (deviceTime.getTime() > serverNow.getTime() + maxFutureMs) return { at: serverNow, skewed: true };
  return { at: deviceTime, skewed: false };
}
