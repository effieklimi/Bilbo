import type { SavedCapture } from "./types";

type CaptureDisplayFields = Pick<
  SavedCapture,
  "note" | "selectedText" | "sourceApp" | "sourceTitle" | "sourceUrl"
>;

export function capturePreview(capture: CaptureDisplayFields) {
  if (capture.selectedText) return `"${capture.selectedText}"`;
  if (capture.note) return capture.note;
  return "Untitled capture";
}

export function captureSourceLabel(capture: CaptureDisplayFields) {
  return (
    capture.sourceTitle ||
    capture.sourceApp ||
    capture.sourceUrl ||
    "Unknown source"
  );
}
