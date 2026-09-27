const TAG_START = /[\p{L}\p{N}]/u;
const TAG_CONTINUATION = /[\p{L}\p{N}\p{M}]/u;
const TAG_BOUNDARY_BLOCKERS = /[\p{L}\p{N}\p{M}_#&/\\]/u;

export type TagMatch = {
  tag: string;
  text: string;
  start: number;
  end: number;
};

function characterBefore(text: string, index: number) {
  if (index <= 0) return "";

  const trailingCodeUnit = text.charCodeAt(index - 1);
  const hasSurrogatePair =
    index >= 2 &&
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff;

  return text.slice(index - (hasSurrogatePair ? 2 : 1), index);
}

function nextCharacter(text: string, index: number) {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

export function normalizeTag(value: string) {
  const withoutHash = value.startsWith("#") ? value.slice(1) : value;
  return withoutHash.normalize("NFKC").toLowerCase();
}

export function findTagMatches(text: string): TagMatch[] {
  const matches: TagMatch[] = [];

  for (let cursor = 0; cursor < text.length; ) {
    const character = nextCharacter(text, cursor);
    if (character !== "#") {
      cursor += character.length || 1;
      continue;
    }

    const previous = characterBefore(text, cursor);
    const first = nextCharacter(text, cursor + 1);
    if (
      !first ||
      !TAG_START.test(first) ||
      (previous && TAG_BOUNDARY_BLOCKERS.test(previous))
    ) {
      cursor += 1;
      continue;
    }

    let end = cursor + 1 + first.length;
    while (end < text.length) {
      const candidate = nextCharacter(text, end);
      if (TAG_CONTINUATION.test(candidate)) {
        end += candidate.length;
        continue;
      }

      if (candidate === "-" || candidate === "_") {
        const afterConnector = nextCharacter(text, end + candidate.length);
        if (afterConnector && TAG_START.test(afterConnector)) {
          end += candidate.length;
          continue;
        }
      }

      break;
    }

    const authored = text.slice(cursor, end);
    matches.push({
      tag: normalizeTag(authored),
      text: authored,
      start: cursor,
      end,
    });
    cursor = end;
  }

  return matches;
}

export function extractTextTags(text: string) {
  return Array.from(new Set(findTagMatches(text).map((match) => match.tag)));
}

export function isCompleteTagToken(value: string) {
  const matches = findTagMatches(value);
  return (
    matches.length === 1 &&
    matches[0].start === 0 &&
    matches[0].end === value.length
  );
}

export function tagSearchQuery(tag: string) {
  return `#${normalizeTag(tag)}`;
}
