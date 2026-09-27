import type { SavedCapture } from "../capture/types";
import { extractTextTags } from "../tags/tags";
import type { CaptureSearchDocument } from "./types";

function captureDateDetails(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return { label: "Unknown date", aliases: [] as string[] };
  }

  const label = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const monthAndDay = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
  }).format(date);

  return {
    label,
    aliases: [
      monthAndDay,
      `${date.getMonth() + 1}/${date.getDate()}`,
      `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`,
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    ],
  };
}

export function captureSearchDocument(
  capture: SavedCapture,
): CaptureSearchDocument {
  const capturedAt = capture.createdAt || capture.savedAt;
  const date = captureDateDetails(capturedAt);

  return {
    kind: "capture",
    id: `capture:${capture.captureId}`,
    captureId: capture.captureId,
    dateLabel: date.label,
    dateAliases: date.aliases,
    selectedText: capture.selectedText,
    note: capture.note,
    sourceTitle: capture.sourceTitle,
    sourceApp: capture.sourceApp || null,
    sourceUrl: capture.sourceUrl,
    tags: extractTextTags(capture.note),
    savedAt: capture.savedAt || capture.createdAt,
  };
}
