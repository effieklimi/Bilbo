import { useLayoutEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { addComposerChild$, realmPlugin } from "@mdxeditor/editor";

import { captureIdFromHref } from "../capture/referenceHref";

const REFERENCE_CLASS = "diary-capture-reference";
const SEPARATOR_CLASS = "diary-capture-separator";
const EMPTY_FOOTER_CLASS = "diary-capture-empty-footer";
const SOURCE_CLASS = "diary-capture-source";
const LAYOUT_CLASS = "diary-capture-layout";
const QUOTATION_CLASS = "diary-capture-quotation";
const SOURCE_LINE_CLASS = "diary-capture-source-line";
const NOTE_CLASS = "diary-capture-note";
const NOTE_START_CLASS = "diary-capture-note-start";
const SOURCE_TITLE_ATTRIBUTE = "data-diary-capture-title";
const DECORATION_CLASSES = [
  REFERENCE_CLASS,
  SEPARATOR_CLASS,
  EMPTY_FOOTER_CLASS,
  SOURCE_CLASS,
  LAYOUT_CLASS,
  QUOTATION_CLASS,
  SOURCE_LINE_CLASS,
  NOTE_CLASS,
  NOTE_START_CLASS,
];
const FORMATTING_ELEMENTS = new Set([
  "SPAN",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "STRIKE",
  "DEL",
  "CODE",
  "MARK",
  "SUB",
  "SUP",
]);

function clearDecorations(root: HTMLElement) {
  for (const source of root.querySelectorAll(`[${SOURCE_TITLE_ATTRIBUTE}]`)) {
    if (source.getAttribute("title") === source.getAttribute(SOURCE_TITLE_ATTRIBUTE)) {
      source.removeAttribute("title");
    }
    source.removeAttribute(SOURCE_TITLE_ATTRIBUTE);
  }
  for (const element of root.querySelectorAll<HTMLElement>(
    DECORATION_CLASSES.map((name) => `.${name}`).join(","),
  )) {
    element.classList.remove(...DECORATION_CLASSES);
  }
}

/** Inline formatting is transparent; links, images, and other objects are not. */
function inlineTokens(container: Element): Node[] {
  const tokens: Node[] = [];

  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) tokens.push(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    if (FORMATTING_ELEMENTS.has(element.tagName)) {
      element.childNodes.forEach(visit);
    } else {
      tokens.push(element);
    }
  }

  container.childNodes.forEach(visit);
  return tokens;
}

function hideLegacySeparator(reference: HTMLAnchorElement, paragraph: Element) {
  const tokens = inlineTokens(paragraph);
  const index = tokens.indexOf(reference);
  const separator = tokens[index - 1];
  const source = tokens[index - 2];
  if (
    separator?.nodeType !== Node.TEXT_NODE ||
    !/^\s*·\s*$/.test(separator.textContent ?? "") ||
    source?.nodeType !== Node.ELEMENT_NODE ||
    (source as Element).tagName !== "A" ||
    !(source as Element).hasAttribute("href") ||
    captureIdFromHref((source as Element).getAttribute("href") ?? "")
  ) {
    return;
  }

  // Lexical wraps text in an element. Hide only a wrapper containing this
  // generated separator, leaving any surrounding text the user added intact.
  let wrapper = separator.parentElement;
  let separatorElement: HTMLElement | null = null;
  while (wrapper && wrapper !== paragraph) {
    if (!FORMATTING_ELEMENTS.has(wrapper.tagName)) break;
    const wrapperTokens = inlineTokens(wrapper);
    if (wrapperTokens.length !== 1 || wrapperTokens[0] !== separator) break;
    separatorElement = wrapper;
    wrapper = wrapper.parentElement;
  }
  separatorElement?.classList.add(SEPARATOR_CLASS);
}

function decorateSourceLink(reference: HTMLAnchorElement, paragraph: Element) {
  const tokens = inlineTokens(paragraph);
  const index = tokens.indexOf(reference);
  const preceding = tokens[index - 1];
  const hasSeparator = preceding?.nodeType === Node.TEXT_NODE &&
    /^\s*·\s*$/.test(preceding.textContent ?? "");
  const source = tokens[index - (hasSeparator ? 2 : 1)];
  if (
    source instanceof HTMLAnchorElement &&
    source.hasAttribute("href") &&
    !captureIdFromHref(source.getAttribute("href") ?? "")
  ) {
    source.classList.add(SOURCE_CLASS);
    const title = source.textContent?.trim();
    if (title && !source.hasAttribute("title")) {
      source.setAttribute("title", title);
      source.setAttribute(SOURCE_TITLE_ATTRIBUTE, title);
    }
    return source;
  }
  return null;
}

function hasVisibleContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(node.textContent?.trim());
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;

  const element = node as Element;
  if (
    element.classList.contains(REFERENCE_CLASS) ||
    element.classList.contains(SEPARATOR_CLASS) ||
    element.tagName === "BR"
  ) {
    return false;
  }

  if (!FORMATTING_ELEMENTS.has(element.tagName)) return true;
  return Array.from(element.childNodes).some(hasVisibleContent);
}

function decorateCaptureLayout(
  quote: HTMLElement,
  footer: HTMLElement,
  reference: HTMLAnchorElement,
  source: HTMLAnchorElement | null,
) {
  const paragraphs = Array.from(quote.children);
  // Preserve custom structures and edited footers in their original order.
  if (paragraphs.at(-1) !== footer || paragraphs.some((p) => p.tagName !== "P")) return;
  const footerTokens = inlineTokens(footer).filter((token) => {
    if (token === reference || token === source) return false;
    return !(source && token.nodeType === Node.TEXT_NODE && /^\s*·\s*$/.test(token.textContent ?? ""));
  });
  if (footerTokens.length) return;

  const content = paragraphs.slice(0, -1);
  let quotationEnd = -1;
  // Generated captures wrap the excerpt in quotes, including multi-paragraph
  // excerpts. Unfinished/edited quotations keep their existing presentation.
  const firstText = content[0]?.textContent?.trim() ?? "";
  if (firstText.startsWith('"')) {
    let quoteCount = 0;
    quotationEnd = content.findIndex((p, index) => {
      const text = p.textContent?.trim() ?? "";
      quoteCount += text.match(/"/g)?.length ?? 0;
      return text.endsWith('"') && quoteCount % 2 === 0 && (index > 0 || text.length > 1);
    });
    if (quotationEnd < 0) return;
  }

  quote.classList.add(LAYOUT_CLASS);
  footer.classList.add(SOURCE_LINE_CLASS);
  content.slice(0, quotationEnd + 1).forEach((p) => p.classList.add(QUOTATION_CLASS));
  const notes = content.slice(quotationEnd + 1);
  notes.forEach((p) => p.classList.add(NOTE_CLASS));
  if (quotationEnd >= 0 || source) {
    notes.find((p) => Array.from(p.childNodes).some(hasVisibleContent))?.classList.add(NOTE_START_CLASS);
  }
}

/** Preserve reference metadata in Lexical and Markdown; change only its display. */
export function decorateCaptureReferences(root: HTMLElement) {
  clearDecorations(root);
  const footers = new Set<HTMLElement>();

  for (const reference of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!captureIdFromHref(reference.getAttribute("href") ?? "")) continue;
    reference.classList.add(REFERENCE_CLASS);

    const paragraph = reference.closest<HTMLElement>("p");
    const quote = paragraph?.parentElement;
    if (!paragraph || quote?.tagName !== "BLOCKQUOTE") continue;

    const source = decorateSourceLink(reference, paragraph);
    hideLegacySeparator(reference, paragraph);
    if (quote.lastElementChild === paragraph) {
      footers.add(paragraph);
      decorateCaptureLayout(quote, paragraph, reference, source);
    }
  }

  for (const footer of footers) {
    if (!Array.from(footer.childNodes).some(hasVisibleContent)) {
      footer.classList.add(EMPTY_FOOTER_CLASS);
    }
  }
}

function CaptureReferenceDecoration() {
  const [editor] = useLexicalComposerContext();

  useLayoutEffect(() => {
    let root = editor.getRootElement();
    const refresh = () => {
      if (root) decorateCaptureReferences(root);
    };
    const unregisterUpdate = editor.registerUpdateListener(refresh);
    const unregisterRoot = editor.registerRootListener((next, previous) => {
      if (previous) clearDecorations(previous);
      root = next;
      refresh();
    });

    return () => {
      unregisterUpdate();
      unregisterRoot();
    };
  }, [editor]);

  return null;
}

export const captureReferencePlugin = realmPlugin({
  init(realm) {
    realm.pub(addComposerChild$, CaptureReferenceDecoration);
  },
});
