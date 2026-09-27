const CAPTURE_REFERENCE_PREFIX = "#diary-capture-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeCaptureId(value: string) {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function captureReferenceHref(captureId: string) {
  const normalizedId = normalizeCaptureId(captureId.trim());
  if (!normalizedId) {
    throw new TypeError("Capture IDs must be UUIDs.");
  }

  return `${CAPTURE_REFERENCE_PREFIX}${normalizedId}`;
}

export function captureIdFromHref(href: string) {
  if (!href.startsWith(CAPTURE_REFERENCE_PREFIX)) return null;

  return normalizeCaptureId(href.slice(CAPTURE_REFERENCE_PREFIX.length));
}
