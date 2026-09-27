const INTERFACE_ZOOM_KEY = "diary.interfaceZoom";

export const DEFAULT_INTERFACE_ZOOM = 1;
export const INTERFACE_ZOOM_STEP = 0.1;
const MIN_INTERFACE_ZOOM = 0.8;
const MAX_INTERFACE_ZOOM = 1.5;

export function normalizeInterfaceZoom(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_INTERFACE_ZOOM;

  const clamped = Math.min(
    MAX_INTERFACE_ZOOM,
    Math.max(MIN_INTERFACE_ZOOM, value),
  );

  return Math.round(clamped * 10) / 10;
}

export function readInterfaceZoom() {
  try {
    const storedZoom = window.localStorage.getItem(INTERFACE_ZOOM_KEY);

    return storedZoom === null
      ? DEFAULT_INTERFACE_ZOOM
      : normalizeInterfaceZoom(Number(storedZoom));
  } catch {
    return DEFAULT_INTERFACE_ZOOM;
  }
}

export function writeInterfaceZoom(zoom: number) {
  try {
    window.localStorage.setItem(
      INTERFACE_ZOOM_KEY,
      String(normalizeInterfaceZoom(zoom)),
    );
  } catch {
    // Zoom still works for this session when persistent storage is unavailable.
  }
}
