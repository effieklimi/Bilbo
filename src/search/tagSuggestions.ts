import { normalizeTag } from "../tags/tags";
import type { SearchDocument } from "./types";

export type TagSuggestion = {
  tag: string;
  count: number;
};

export function collectTagSuggestions(
  documents: readonly SearchDocument[],
): TagSuggestion[] {
  const counts = new Map<string, number>();

  for (const document of documents) {
    for (const tag of new Set(document.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
    (left, right) =>
      right.count - left.count || left.tag.localeCompare(right.tag),
  );
}

export function tagPrefixQuery(query: string) {
  const trimmed = query.trim();
  if (!/^#[\p{L}\p{N}\p{M}_-]*$/u.test(trimmed)) return null;
  return normalizeTag(trimmed);
}
