import type { ReactNode } from "react";

import { findTagMatches } from "./tags";

type TaggedTextProps = {
  children: string;
  onSearchTag: (tag: string) => void;
};

export default function TaggedText({
  children,
  onSearchTag,
}: TaggedTextProps) {
  const matches = findTagMatches(children);
  if (matches.length === 0) return children;

  const fragments: ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) fragments.push(children.slice(cursor, match.start));

    fragments.push(
      <button
        key={`${match.start}:${match.end}`}
        type="button"
        title={`Search ${match.text}`}
        aria-label={`Search tag ${match.text}`}
        onClick={() => onSearchTag(match.tag)}
        className="diary-tag rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current/35"
      >
        {match.text}
      </button>,
    );
    cursor = match.end;
  }

  if (cursor < children.length) fragments.push(children.slice(cursor));
  return fragments;
}

