import { expect, test } from "bun:test";
import {
  capturePickerResults,
  matchingCaptureCommands,
  nextSelectableIndex,
  scopedCaptureDocuments,
} from "../src/search/captureCommands";
import { searchDocuments } from "../src/search/search";
import { collectTagSuggestions } from "../src/search/tagSuggestions";
import type { CaptureSearchDocument } from "../src/search/types";

function capture(captureId: string, overrides: Partial<CaptureSearchDocument> = {}): CaptureSearchDocument {
  return {
    kind: "capture",
    id: `document-${captureId}`,
    captureId,
    dateLabel: "12 September 2026",
    selectedText: "A saved quote",
    note: "",
    sourceTitle: "Example article",
    sourceApp: "Browser",
    sourceUrl: "https://example.com",
    tags: [],
    savedAt: 100,
    ...overrides,
  };
}

test("capture actions are discoverable by labels, partial words and insertion language", () => {
  expect(matchingCaptureCommands("").map((command) => command.id)).toEqual(["add-capture", "note-captures"]);
  for (const query of ["add capture", "insert capture", "Add Capt", "attach capture"]) {
    expect(matchingCaptureCommands(query).map((command) => command.id)).toEqual(["add-capture"]);
  }
  expect(matchingCaptureCommands("captures in this note").map((command) => command.id)).toEqual(["note-captures"]);
  expect(matchingCaptureCommands("#capture")).toEqual([]);
  expect(matchingCaptureCommands("unrelated quotation")).toEqual([]);
});

test("empty capture pickers show most recent captures, preserving ordinary empty search behavior", () => {
  const documents = [
    capture("old", { savedAt: 1 }),
    capture("new", { savedAt: 3 }),
    capture("middle", { savedAt: 2 }),
  ];
  expect(capturePickerResults(documents, " ", 2).map((result) => result.captureId)).toEqual(["new", "middle"]);
  expect(documents.map((document) => document.captureId)).toEqual(["old", "new", "middle"]);
  expect(searchDocuments(documents, "")).toEqual([]);
});

test("recent results retain source details and offer useful fallbacks for captures without a quote", () => {
  const [result] = capturePickerResults([capture("note", {
    selectedText: "",
    note: "A note\n\nwith context",
    sourceTitle: null,
    sourceApp: "Notes",
  })], "");
  expect(result.title).toBe("A note with context");
  expect(result.metadata).toBe("Notes · 12 September 2026");
  expect(result.captureId).toBe("note");
  expect(result.note).toBe("A note\n\nwith context");
  expect(result.matchedField).toBe("note");
  expect(result.excerptRanges).toEqual([]);
});

test("scoped searching retains ordinary text and tag filtering", () => {
  const documents = [
    capture("linked", { tags: ["research"], selectedText: "Plant growth experiment" }),
    capture("different-tag", { tags: ["garden"], selectedText: "Plant growth experiment" }),
    capture("different-text", { tags: ["research"], selectedText: "Ocean currents" }),
  ];
  expect(capturePickerResults(documents, "#research plant").map((result) => result.captureId)).toEqual(["linked"]);
  expect(capturePickerResults(documents, "#research -ocean").map((result) => result.captureId)).toEqual(["linked"]);
});

test("note captures and their tag suggestions only contain captures linked by capture ID", () => {
  const documents = [
    capture("linked", { tags: ["research"] }),
    capture("outside", { tags: ["other"] }),
  ];
  const scoped = scopedCaptureDocuments(documents, "note-captures", ["linked", "deleted"]);
  expect(scoped.map((document) => document.captureId)).toEqual(["linked"]);
  expect(collectTagSuggestions(scoped)).toEqual([{ tag: "research", count: 1 }]);
  expect(scopedCaptureDocuments(documents, "add-capture", ["linked"])).toBe(documents);
  expect(scopedCaptureDocuments(documents, "note-captures", [])).toEqual([]);
});

test("keyboard navigation skips unavailable captures and handles all-linked results", () => {
  expect(nextSelectableIndex([1, 3], -1, 1)).toBe(1);
  expect(nextSelectableIndex([1, 3], 1, 1)).toBe(3);
  expect(nextSelectableIndex([1, 3], 3, 1)).toBe(1);
  expect(nextSelectableIndex([1, 3], 1, -1)).toBe(3);
  expect(nextSelectableIndex([1, 3], -1, -1)).toBe(3);
  expect(nextSelectableIndex([], 0, 1)).toBe(-1);
});
