import { fromMarkdown } from "mdast-util-from-markdown";
import { errorCode, logEvent } from "../diagnostics/logger";

import { captureIdFromHref } from "../capture/referenceHref";
import { findTagMatches } from "../tags/syntax";

type MarkdownNode = {
  type?: string;
  value?: unknown;
  url?: unknown;
  alt?: unknown;
  identifier?: unknown;
  children?: unknown;
};

export type MarkdownAnalysis = {
  searchText: string;
  tags: string[];
  captureIds: string[];
};

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const CAPTURE_REFERENCE_LINK =
  /\[[^\]\r\n]*\]\(\s*#diary-capture-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\s*\)/g;
let lastFallbackLoggedAt: number | null = null;

function children(node: MarkdownNode) {
  return Array.isArray(node.children)
    ? node.children.filter(
        (child): child is MarkdownNode =>
          child !== null && typeof child === "object",
      )
    : [];
}

function inlineText(node: MarkdownNode): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return typeof node.value === "string" ? node.value : "";
    case "html":
    case "thematicBreak":
      return "";
    case "break":
      return "\n";
    case "image": {
      const alt = typeof node.alt === "string" ? node.alt : "";
      const url = typeof node.url === "string" ? node.url : "";
      return `${alt} ${url}`.trim();
    }
    case "link": {
      const url = typeof node.url === "string" ? node.url : "";
      if (captureIdFromHref(url)) return "";

      const label = children(node).map(inlineText).join("");
      return `${label} ${url}`.trim();
    }
    case "definition": {
      const identifier =
        typeof node.identifier === "string" ? node.identifier : "";
      const url = typeof node.url === "string" ? node.url : "";
      return `${identifier} ${url}`.trim();
    }
    case "root":
    case "blockquote":
    case "list":
    case "listItem":
      return children(node).map(inlineText).join("\n");
    default:
      return children(node).map(inlineText).join("");
  }
}

function fallbackSearchText(markdown: string) {
  return markdown
    .replace(CAPTURE_REFERENCE_LINK, " ")
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/~~~[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}(?:[-+*>]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\|/g, " ")
    .replace(CONTROL_CHARACTERS, " ");
}

export function analyzeMarkdown(markdown: string): MarkdownAnalysis {
  const root = fromMarkdown(markdown) as MarkdownNode;
  const tags: string[] = [];
  const captureIds: string[] = [];
  const seenTags = new Set<string>();
  const seenCaptureIds = new Set<string>();

  function visit(node: MarkdownNode) {
    if (node.type === "text" && typeof node.value === "string") {
      for (const match of findTagMatches(node.value)) {
        if (!seenTags.has(match.tag)) {
          seenTags.add(match.tag);
          tags.push(match.tag);
        }
      }
    }

    if (node.type === "link" && typeof node.url === "string") {
      const captureId = captureIdFromHref(node.url);
      if (captureId && !seenCaptureIds.has(captureId)) {
        seenCaptureIds.add(captureId);
        captureIds.push(captureId);
      }
    }

    for (const child of children(node)) visit(child);
  }

  visit(root);
  return {
    searchText: inlineText(root),
    tags,
    captureIds,
  };
}

export function analyzeMarkdownSafely(markdown: string): MarkdownAnalysis {
  try {
    return analyzeMarkdown(markdown);
  } catch (cause) {
    const now = Date.now();
    if (lastFallbackLoggedAt === null || now - lastFallbackLoggedAt >= 60_000) {
      lastFallbackLoggedAt = now;
      logEvent("warn", "editor.failed", { boundary: "markdown_analysis", outcome: "fallback", errorCode: errorCode(cause), tagsAvailable: false, captureReferencesAvailable: false });
    }
    return {
      searchText: fallbackSearchText(markdown),
      tags: [],
      captureIds: [],
    };
  }
}
