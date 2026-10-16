// Opt out of onnxruntime-node telemetry before the native library loads.
// ORT reads ORT_DISABLE_TELEMETRY once at init (1/true/yes/on/y). That stops the
// uploader, events, and the persistent device ID under
// ~/.cache/Microsoft/DeveloperTools/.onnxruntime/deviceid (or $XDG_CACHE_HOME/…).
// Import this module (or call disableOrtTelemetry) before any onnxruntime-node load.

const DISABLE = new Set(['1', 'true', 'yes', 'on', 'y']);

/** True when the value is an ORT-recognized disable flag. */
export function isOrtTelemetryDisabled(value?: string | null): boolean {
  const raw = arguments.length > 0 ? value : process.env.ORT_DISABLE_TELEMETRY;
  if (raw == null || raw === '') return false;
  return DISABLE.has(raw.trim().toLowerCase());
}

/**
 * Sets `ORT_DISABLE_TELEMETRY=1` unless the user already opted out with a
 * recognized disable value. Idempotent; does not overwrite an existing disable.
 */
export function disableOrtTelemetry(): void {
  if (isOrtTelemetryDisabled()) return;
  process.env.ORT_DISABLE_TELEMETRY = '1';
}

disableOrtTelemetry();
