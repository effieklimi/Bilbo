import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isQuoteNode } from "@lexical/rich-text";
import {
  $createParagraphNode,
  $findMatchingParent,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  mergeRegister,
  type ElementNode,
  type RangeSelection,
} from "lexical";
import { addComposerChild$, realmPlugin } from "@mdxeditor/editor";

function quoteContaining(selectionPoint: RangeSelection["anchor"]) {
  return $findMatchingParent(selectionPoint.getNode(), $isQuoteNode);
}

function insertQuoteLine(
  selection: RangeSelection,
  event: KeyboardEvent | null,
) {
  if (
    !event ||
    event.isComposing ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false;
  }

  const anchorQuote = quoteContaining(selection.anchor);
  const focusQuote = quoteContaining(selection.focus);
  if (!anchorQuote || !focusQuote || !anchorQuote.is(focusQuote)) return false;

  event.preventDefault();
  selection.insertLineBreak();
  return true;
}

function caretIsAtEndOf(selection: RangeSelection, element: ElementNode) {
  const { anchor } = selection;
  const anchorNode = anchor.getNode();

  if (anchorNode.is(element)) {
    return (
      anchor.type === "element" && anchor.offset === element.getChildrenSize()
    );
  }

  const lastDescendant = element.getLastDescendant();
  if (!lastDescendant || !anchorNode.is(lastDescendant)) return false;

  return anchor.offset === lastDescendant.getTextContentSize();
}

function directChildOf(element: ElementNode, descendant: ElementNode) {
  let child: ElementNode = descendant;

  while (child.getParent() && !child.getParent()!.is(element)) {
    const parent = child.getParent();
    if (!$isElementNode(parent)) return null;
    child = parent;
  }

  return child.getParent()?.is(element) ? child : null;
}

function exitEmptyQuoteLine(selection: RangeSelection) {
  if (!selection.isCollapsed()) return false;

  const anchorNode = selection.anchor.getNode();
  const quote = quoteContaining(selection.anchor);
  if (!quote || !caretIsAtEndOf(selection, quote)) return false;

  const paragraph = $createParagraphNode();

  if (quote.getTextContentSize() === 0) {
    quote.replace(paragraph);
    paragraph.selectStart();
    return true;
  }

  const lastChild = quote.getLastChild();
  if ($isLineBreakNode(lastChild)) {
    lastChild.remove();
  } else {
    const anchorElement = $isElementNode(anchorNode) ? anchorNode : null;
    const emptyChild = anchorElement
      ? directChildOf(quote, anchorElement)
      : null;

    if (!emptyChild?.is(lastChild) || emptyChild.getTextContentSize() !== 0) {
      return false;
    }

    emptyChild.remove();
  }

  if (quote.getTextContentSize() === 0) {
    quote.replace(paragraph);
  } else {
    quote.insertAfter(paragraph);
  }
  paragraph.selectStart();
  return true;
}

function QuoteEditing() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event) => {
            const selection = $getSelection();
            return $isRangeSelection(selection)
              ? insertQuoteLine(selection, event)
              : false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_BACKSPACE_COMMAND,
          (event) => {
            const selection = $getSelection();
            if (
              !$isRangeSelection(selection) ||
              !exitEmptyQuoteLine(selection)
            ) {
              return false;
            }

            event.preventDefault();
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor],
  );

  return null;
}

export const quoteEditingPlugin = realmPlugin({
  init(realm) {
    realm.pub(addComposerChild$, QuoteEditing);
  },
});
