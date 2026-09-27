import { useEffect } from "react";
import {
  HashtagNode,
  registerLexicalHashtag,
  type HashtagConfig,
} from "@lexical/hashtag";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  addComposerChild$,
  addLexicalNode$,
  realmPlugin,
} from "@mdxeditor/editor";

import { findTagMatches } from "../tags/tags";

const hashtagConfig: HashtagConfig = {
  getHashtagMatch(text) {
    const match = findTagMatches(text)[0];
    return match ? { start: match.start, end: match.end } : null;
  },
};

function HashtagEntities() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () => registerLexicalHashtag(editor, hashtagConfig),
    [editor],
  );

  return null;
}

export const hashtagPlugin = realmPlugin({
  init(realm) {
    realm.pub(addLexicalNode$, HashtagNode);
    realm.pub(addComposerChild$, HashtagEntities);
  },
});

