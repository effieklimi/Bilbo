import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode } from "@lexical/link";
import { addComposerChild$, realmPlugin, type RealmPlugin } from "@mdxeditor/editor";
import {
  $createParagraphNode,
  $findMatchingParent,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isSelectionCapturedInDecoratorInput,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  getNearestEditorFromDOMNode,
  mergeRegister,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";

import { captureIdFromHref } from "../capture/referenceHref";

export type CommandPaletteSelection = {
  plugin: RealmPlugin;
  save: () => void;
  restore: (options?: { collapse?: boolean }) => boolean;
  clear: () => void;
};

function isValidPoint(point: RangeSelection["anchor"]) {
  const node = $getNodeByKey(point.key);
  if (!node?.isAttached() || point.offset < 0) return false;

  return point.type === "text"
    ? $isTextNode(node) && point.offset <= node.getTextContentSize()
    : $isElementNode(node) && point.offset <= node.getChildrenSize();
}

function validRange(selection: ReturnType<typeof $getSelection>) {
  return $isRangeSelection(selection) &&
    isValidPoint(selection.anchor) &&
    isValidPoint(selection.focus)
    ? selection
    : null;
}

/** Keep one controller for the note editor's lifetime, and add its plugin once. */
export function createCommandPaletteSelection(): CommandPaletteSelection {
  let editor: LexicalEditor | null = null;
  let lastSelection: RangeSelection | null = null;
  let savedSelection: RangeSelection | null = null;

  function clear() {
    lastSelection = null;
    savedSelection = null;
  }

  function SelectionBridge() {
    const [rootEditor] = useLexicalComposerContext();

    useEffect(() => {
      editor = rootEditor;
      clear();

      function rememberSelection() {
        const selection = $getSelection();
        const range = validRange(selection);
        if (range) lastSelection = range.clone();
        // A null selection is expected when the palette takes focus. A node
        // selection instead means the user deliberately left a text caret.
        else if (selection !== null) lastSelection = null;
      }

      const unregister = mergeRegister(
        rootEditor.registerUpdateListener(({ editorState }) => {
          editorState.read(rememberSelection);
        }),
        rootEditor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          (_, activeEditor) => {
            if (activeEditor === rootEditor) rememberSelection();
            else lastSelection = null;
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
      );

      return () => {
        unregister();
        if (editor === rootEditor) {
          editor = null;
          clear();
        }
      };
    }, [rootEditor]);

    return null;
  }

  return {
    plugin: realmPlugin({
      init(realm) {
        realm.pub(addComposerChild$, SelectionBridge);
      },
    })(),
    clear,
    save() {
      const currentEditor = editor;
      if (!currentEditor) return;

      currentEditor.read("latest", () => {
        const rootElement = currentEditor.getRootElement();
        const activeElement = rootElement?.ownerDocument.activeElement;
        const anchor = rootElement?.ownerDocument.getSelection()?.anchorNode;
        // CodeMirror and nested editors have their own selection models. Do
        // not reuse a stale root caret when the command starts inside one.
        const inNestedEditor = activeElement && rootElement?.contains(activeElement) &&
          getNearestEditorFromDOMNode(activeElement) !== currentEditor;
        const inDecorator = anchor && rootElement?.contains(anchor) &&
          $isSelectionCapturedInDecoratorInput(anchor, activeElement);
        if (inNestedEditor || inDecorator) {
          savedSelection = null;
          return;
        }

        const selection = $getSelection();
        const range = validRange(selection);
        savedSelection = (range ?? (selection === null ? lastSelection : null))?.clone() ?? null;
      });
    },
    restore({ collapse = false } = {}) {
      const currentEditor = editor;
      const rootElement = currentEditor?.getRootElement();
      if (!currentEditor || !rootElement || !currentEditor.isEditable()) return false;

      // Call after the dialog's focus trap has gone away. The discrete update
      // makes the saved position available to a following insertMarkdown call.
      rootElement.focus({ preventScroll: true });
      currentEditor.update(() => {
        const selection = validRange(savedSelection)?.clone() ?? null;
        if (selection) {
          if (collapse) {
            const { key, offset, type } = selection.focus;
            selection.anchor.set(key, offset, type);
          }
          $setSelection(selection);
        } else {
          const root = $getRoot();
          const last = root.getLastDescendant();
          const reference = last && $findMatchingParent(last, (node) =>
            $isLinkNode(node) && captureIdFromHref(node.getURL()) !== null,
          );
          if (reference) {
            // The last capture reference is hidden metadata. Insert after its
            // card instead of placing the palette's fallback caret inside it.
            const paragraph = $createParagraphNode();
            root.append(paragraph);
            paragraph.selectStart();
          } else {
            root.selectEnd();
          }
        }
        // MDXEditor inserts into its active editor. Explicitly announce the
        // root selection, including when focus previously belonged to a nested editor.
        currentEditor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
      }, { discrete: true });
      savedSelection = null;
      return true;
    },
  };
}
