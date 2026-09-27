import type { SavedCapture } from "./types";

type CaptureGroup = {
  key: string;
  label: string;
  captures: SavedCapture[];
};

export function captureDate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatCaptureTime(value: number) {
  const date = captureDate(value);
  if (!date) return "Unknown time";

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatCaptureDay(date: Date, today: Date) {
  const dateKey = localDayKey(date);
  if (dateKey === localDayKey(today)) return "Today";

  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  if (dateKey === localDayKey(yesterday)) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear()
      ? {}
      : { year: "numeric" as const }),
  }).format(date);
}

export function groupCapturesByDay(captures: SavedCapture[]) {
  const today = new Date();
  const groups = new Map<string, CaptureGroup>();

  for (const capture of captures) {
    const date = captureDate(capture.createdAt);
    const key = date ? localDayKey(date) : "unknown";
    const existing = groups.get(key);

    if (existing) {
      existing.captures.push(capture);
      continue;
    }

    groups.set(key, {
      key,
      label: date ? formatCaptureDay(date, today) : "Unknown date",
      captures: [capture],
    });
  }

  return Array.from(groups.values());
}
