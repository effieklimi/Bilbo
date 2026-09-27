import {
  CHECK_LIST,
  HEADING,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type ElementTransformer,
  type Transformer,
} from "@lexical/markdown";
import { $isListItemNode, $isListNode } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { addComposerChild$, realmPlugin } from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_SPACE_COMMAND,
  type LexicalNode,
  mergeRegister,
} from "lexical";
import { useEffect } from "react";

const THEMATIC_BREAK_ON_ENTER: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node) => ($isHorizontalRuleNode(node) ? "***" : null),
  regExp: /^(---|\*\*\*|___)$/,
  replace: (parentNode, _children, _match, isImport) => {
    const line = $createHorizontalRuleNode();

    if (isImport || parentNode.getNextSibling() !== null) {
      parentNode.replace(line);
    } else {
      parentNode.insertBefore(line);
    }

    line.selectNext();
  },
  triggerOnEnter: true,
  type: "element",
};

const markdownTransformers: Transformer[] = [
  THEMATIC_BREAK_ON_ENTER,
  {
    ...HEADING,
    regExp: /^(#{1,6})$/,
  },
  {
    ...QUOTE,
    regExp: /^>$/,
  },
  {
    ...UNORDERED_LIST,
    regExp: /^(\s*)-$/,
  },
  {
    ...ORDERED_LIST,
    regExp: /^(\s*)(\d{1,})\.$/,
  },
  {
    ...CHECK_LIST,
    regExp: /^(\s*)-\s(\[(\s|x)?\])$/i,
  },
  STRIKETHROUGH,
];

function EnterMarkdownShortcuts() {
  return <MarkdownShortcutPlugin transformers={markdownTransformers} />;
}

function findListItem(node: LexicalNode) {
  let current: LexicalNode | null = node;

  while (current !== null) {
    if ($isListItemNode(current)) {
      return current;
    }
    current = current.getParent();
  }

  return null;
}

function TaskListShortcuts() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const convertTaskMarker = (event: KeyboardEvent | null) => {
      const selection = $getSelection();

      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return false;
      }

      const anchorNode = selection.anchor.getNode();
      if (!$isTextNode(anchorNode)) {
        return false;
      }

      const listItem = findListItem(anchorNode);
      const list = listItem?.getParent();
      if (
        listItem === null ||
        !$isListNode(list) ||
        list.getListType() !== "bullet"
      ) {
        return false;
      }

      const marker = listItem.getTextContent().match(/^\[( |x)\]$/i);
      if (
        marker === null ||
        anchorNode.getTextContent() !== marker[0] ||
        selection.anchor.offset !== marker[0].length
      ) {
        return false;
      }

      event?.preventDefault();
      anchorNode.setTextContent("");
      list.setListType("check");
      listItem.setChecked(marker[1].toLowerCase() === "x");
      listItem.selectStart();
      return true;
    };

    return mergeRegister(
      editor.registerCommand(
        KEY_SPACE_COMMAND,
        convertTaskMarker,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event?.shiftKey) {
            return false;
          }
          return convertTaskMarker(event);
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor]);

  return null;
}

export const enterMarkdownShortcutsPlugin = realmPlugin({
  init(realm) {
    realm.pub(addComposerChild$, [EnterMarkdownShortcuts, TaskListShortcuts]);
  },
});
