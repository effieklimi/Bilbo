import { normalizeSearchText, searchDocuments } from "./search";
import type { CaptureSearchDocument, CaptureSearchResult } from "./types";

export type CaptureCommandId = "add-capture" | "note-captures";

export const CAPTURE_COMMANDS = [
  {
    id: "add-capture",
    label: "Add capture to this note…",
    searchTerms: "add insert attach capture captures to this current note",
  },
  {
    id: "note-captures",
    label: "Captures in this note",
    searchTerms: "show find view captures capture in this current note",
  },
] as const;

export function matchingCaptureCommands(query: string) {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  return CAPTURE_COMMANDS.filter((command) =>
    tokens.every((token) =>
      command.searchTerms.split(" ").some((word) =>
        word === token || (!["in", "to", "this"].includes(token) && word.startsWith(token)),
      ),
    ),
  );
}

export function scopedCaptureDocuments(
  documents: readonly CaptureSearchDocument[],
  mode: CaptureCommandId,
  linkedCaptureIds: readonly string[],
) {
  if (mode === "add-capture") return documents;
  const linked = new Set(linkedCaptureIds);
  return documents.filter((document) => linked.has(document.captureId));
}

function plainText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, length: number) {
  return value.length <= length
    ? value
    : `${value.slice(0, length - 1).trimEnd()}…`;
}

/** Empty capture pickers show recent items without changing ordinary search. */
export function capturePickerResults(
  documents: readonly CaptureSearchDocument[],
  query: string,
  limit = 100,
): CaptureSearchResult[] {
  if (query.trim()) {
    return searchDocuments(documents, query, limit).filter(
      (result): result is CaptureSearchResult => result.kind === "capture",
    );
  }

  return [...documents]
    .sort((left, right) => right.savedAt - left.savedAt || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit))
    .map((document) => {
      const source = document.sourceTitle || document.sourceApp;
      const content = plainText(document.selectedText || document.note || source || "Capture");
      const metadata = [source, document.dateLabel]
        .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
        .join(" · ");
      return {
        ...document,
        title: truncate(content, 100),
        metadata,
        excerpt: truncate(content, 180),
        excerptRanges: [],
        matchedField: document.selectedText ? "quote" : document.note ? "note" : "sourceTitle",
        score: 0,
        timestamp: document.savedAt,
      };
    });
}

/** Skip unavailable options, including captures already added to this note. */
export function nextSelectableIndex(
  selectableIndexes: readonly number[],
  current: number,
  direction: 1 | -1,
) {
  if (selectableIndexes.length === 0) return -1;
  const position = selectableIndexes.indexOf(current);
  if (position < 0) {
    return direction === 1 ? selectableIndexes[0] : selectableIndexes[selectableIndexes.length - 1];
  }
  return selectableIndexes[
    (position + direction + selectableIndexes.length) % selectableIndexes.length
  ];
}
