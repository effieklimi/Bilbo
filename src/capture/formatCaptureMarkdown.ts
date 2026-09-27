import type { SavedCapture } from "./types";
import { captureReferenceHref } from "./references";

function cleanBlockText(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function escapePlainText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]{}<>|~&])/g, "\\$1")
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, "$1\\$2")
        .replace(/^(\s{0,3})([-+])(?=\s|-{2,}\s*$)/, "$1\\$2")
        .replace(/^(\s{0,3}\d{1,9})([.)])(?=\s)/, "$1\\$2"),
    )
    .join("\n");
}

function cleanLinkLabel(value: string) {
  return escapePlainText(value.replace(/\s+/g, " ").trim());
}

function safeHttpUrl(value: string | null) {
  if (!value?.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    // Angle-bracket link destinations can contain balanced or unbalanced
    // parentheses. Encode the few characters that could terminate or escape
    // that destination if a platform URL parser leaves them intact.
    return url.href
      .replace(/\\/g, "%5C")
      .replace(/</g, "%3C")
      .replace(/>/g, "%3E");
  } catch {
    return null;
  }
}

function sourceMarkdown(capture: SavedCapture) {
  const url = safeHttpUrl(capture.sourceUrl);
  if (!url) return null;

  const labelSource =
    capture.sourceTitle?.trim() || capture.sourceApp?.trim() || url;

  return `[${cleanLinkLabel(labelSource)}](<${url}>)`;
}

function quoteSelectedText(value: string) {
  return `"${escapePlainText(value)}"`;
}

function blockquoteMarkdown(sections: string[]) {
  return sections
    .join("\n\n")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Creates a portable Markdown snapshot of a capture for insertion into a
 * diary entry. The returned fragment ends with a blank line so the editor can
 * place the caret in ordinary prose immediately after it.
 */
export function formatCaptureMarkdown(capture: SavedCapture) {
  const selectedText = cleanBlockText(capture.selectedText);
  const note = escapePlainText(cleanBlockText(capture.note));
  const source = sourceMarkdown(capture);
  // The editor hides this reference; it keeps capture-to-note tracking portable.
  const reference = `[Capture](${captureReferenceHref(capture.captureId)})`;
  const sections: string[] = [];

  if (selectedText) sections.push(quoteSelectedText(selectedText));
  if (note) sections.push(note);
  sections.push(source ? `${source} ${reference}` : reference);

  return `${blockquoteMarkdown(sections)}\n\n`;
}
