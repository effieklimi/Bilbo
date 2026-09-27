import { expect, test } from "bun:test";

import { formatCaptureMarkdown } from "../src/capture/formatCaptureMarkdown";
import { extractCaptureIds } from "../src/capture/references";
import type { SavedCapture } from "../src/capture/types";
import { analyzeMarkdown } from "../src/markdown/analyze";

const capture: SavedCapture = {
  captureId: "11111111-1111-4111-8111-111111111111",
  selectedText: "A useful quotation",
  note: "My thought #writing",
  sourceApp: "Browser",
  sourceBundleId: null,
  sourceTitle: "Original article",
  sourceUrl: "https://example.com/article",
  captureMethod: "accessibility",
  createdAt: 1,
  updatedAt: 1,
  savedAt: 1,
  assignedDates: [],
};

test("capture insertion keeps the source and tracking reference without a visible separator", () => {
  const markdown = formatCaptureMarkdown(capture);
  expect(markdown).toContain("[Original article](<https://example.com/article>)");
  expect(markdown).not.toContain(" · ");
  expect(extractCaptureIds(markdown)).toEqual([capture.captureId]);
  const analysis = analyzeMarkdown(markdown);
  expect(analysis.tags).toEqual(["writing"]);
  expect(analysis.searchText).toContain("A useful quotation");
  expect(analysis.searchText).not.toContain("Capture");
});

test("source-free captures keep their identity and note text", () => {
  for (const selectedText of [capture.selectedText, ""]) {
    const markdown = formatCaptureMarkdown({ ...capture, selectedText, sourceUrl: null });
    expect(extractCaptureIds(markdown)).toEqual([capture.captureId]);
    expect(analyzeMarkdown(markdown).searchText).toContain("My thought #writing");
    expect(markdown).not.toContain("Original article");
  }
});

test("legacy capture references continue to identify the same capture", () => {
  const markdown = `> Quotation\n>\n> [Original article](https://example.com/article) · [Capture](#diary-capture-${capture.captureId})\n`;
  expect(extractCaptureIds(markdown)).toEqual([capture.captureId]);
  expect(analyzeMarkdown(markdown).searchText).not.toContain("Capture");
});
