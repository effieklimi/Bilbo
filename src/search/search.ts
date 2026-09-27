import type {
  CaptureMatchedField,
  CaptureSearchDocument,
  CaptureSearchResult,
  DiaryMatchedField,
  DiarySearchDocument,
  DiarySearchResult,
  SearchDocument,
  SearchMatchedField,
  SearchMatchRange,
  SearchResult,
} from "./types";
import {
  findTagMatches,
  isCompleteTagToken,
  normalizeTag,
} from "../tags/tags";
import { analyzeMarkdownSafely } from "../markdown/analyze";

const DEFAULT_SEARCH_RESULT_LIMIT = 100;
export const MAX_SEARCH_RESULT_LIMIT = 500;

const EXCERPT_LENGTH = 180;
const MARK = /\p{M}/u;
const WHITESPACE = /\s/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

type NormalizedText = {
  value: string;
  starts: number[];
  ends: number[];
};

type SearchField<Name extends SearchMatchedField = SearchMatchedField> = {
  name: Name;
  text: string;
  weight: number;
  normalized: NormalizedText;
};

type FieldMatch<Name extends SearchMatchedField = SearchMatchedField> = {
  field: SearchField<Name>;
  tokenIndexes: Map<string, number>;
};

type ParsedSearchQuery = {
  required: string[];
  excluded: string[];
  requiredTags: string[];
  excludedTags: string[];
  rankingPhrase: string;
};

function normalizeWithOffsets(input: string): NormalizedText {
  let value = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingWhitespace: { start: number; end: number } | null = null;

  for (let sourceStart = 0; sourceStart < input.length; ) {
    const codePoint = input.codePointAt(sourceStart);
    if (codePoint === undefined) break;

    const sourceCharacter = String.fromCodePoint(codePoint);
    const sourceEnd = sourceStart + sourceCharacter.length;
    const expanded = sourceCharacter.normalize("NFKD").toLowerCase();

    for (const character of expanded) {
      if (MARK.test(character)) continue;

      if (WHITESPACE.test(character)) {
        if (value.length > 0 && pendingWhitespace === null) {
          pendingWhitespace = { start: sourceStart, end: sourceEnd };
        } else if (pendingWhitespace !== null) {
          pendingWhitespace.end = sourceEnd;
        }
        continue;
      }

      if (pendingWhitespace !== null) {
        value += " ";
        starts.push(pendingWhitespace.start);
        ends.push(pendingWhitespace.end);
        pendingWhitespace = null;
      }

      value += character;
      for (let index = 0; index < character.length; index += 1) {
        starts.push(sourceStart);
        ends.push(sourceEnd);
      }
    }

    sourceStart = sourceEnd;
  }

  return { value, starts, ends };
}

/** Normalizes user-visible text exactly as the matcher does. */
export function normalizeSearchText(input: string) {
  return normalizeWithOffsets(input).value;
}

function parseSearchQuery(input: string): ParsedSearchQuery {
  const required: string[] = [];
  const excluded: string[] = [];
  const requiredTags: string[] = [];
  const excludedTags: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && WHITESPACE.test(input[cursor])) cursor += 1;
    if (cursor >= input.length) break;

    let exclude = false;
    if (input[cursor] === "-") {
      if (
        cursor + 1 >= input.length ||
        WHITESPACE.test(input[cursor + 1])
      ) {
        cursor += 1;
        continue;
      }

      exclude = true;
      cursor += 1;
    }

    let rawValue = "";
    let quoted = false;
    if (input[cursor] === '"') {
      quoted = true;
      cursor += 1;
      const start = cursor;

      while (cursor < input.length && input[cursor] !== '"') cursor += 1;
      rawValue = input.slice(start, cursor);
      if (input[cursor] === '"') cursor += 1;
    } else {
      const start = cursor;
      while (cursor < input.length && !WHITESPACE.test(input[cursor])) {
        cursor += 1;
      }
      rawValue = input.slice(start, cursor);
    }

    if (!quoted && rawValue.startsWith("#")) {
      if (!isCompleteTagToken(rawValue)) continue;

      const tag = normalizeTag(rawValue);
      const destination = exclude ? excludedTags : requiredTags;
      if (!destination.includes(tag)) destination.push(tag);
      continue;
    }

    const value = normalizeSearchText(rawValue);
    if (!value) continue;

    const destination = exclude ? excluded : required;
    if (!destination.includes(value)) destination.push(value);
  }

  return {
    required,
    excluded,
    requiredTags,
    excludedTags,
    rankingPhrase: required.join(" "),
  };
}

function collapsePlainText(value: string) {
  return value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function field<Name extends SearchMatchedField>(
  name: Name,
  value: string | null | undefined,
  weight: number,
  transform: (text: string) => string = collapsePlainText,
): SearchField<Name> | null {
  const text = transform(value ?? "");
  if (!text) return null;

  return {
    name,
    text,
    weight,
    normalized: normalizeWithOffsets(text),
  };
}

function compactFields<Name extends SearchMatchedField>(
  values: Array<SearchField<Name> | null>,
) {
  return values.filter((value): value is SearchField<Name> => value !== null);
}

function diaryFields(document: DiarySearchDocument) {
  return compactFields<DiaryMatchedField>([
    field("date", document.dateLabel, 150),
    ...(document.dateAliases ?? []).map((alias) => field("date", alias, 150)),
    field("fileName", document.fileName, 140),
    ...(document.fileNameAliases ?? []).map((alias) =>
      field("fileName", alias, 140),
    ),
    field(
      "body",
      document.searchText ?? analyzeMarkdownSafely(document.body).searchText,
      90,
    ),
  ]);
}

function captureFields(document: CaptureSearchDocument) {
  return compactFields<CaptureMatchedField>([
    field("date", document.dateLabel, 150),
    ...(document.dateAliases ?? []).map((alias) => field("date", alias, 150)),
    field("quote", document.selectedText, 100),
    field("note", document.note, 95),
    field("sourceTitle", document.sourceTitle, 55),
    field("sourceApp", document.sourceApp, 45),
    field("sourceUrl", document.sourceUrl, 35),
  ]);
}

function isWordBoundary(text: string, index: number) {
  if (index === 0) return true;

  const trailingCodeUnit = text.charCodeAt(index - 1);
  const hasSurrogatePair =
    index >= 2 &&
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff;
  const previousCharacter = text.slice(index - (hasSurrogatePair ? 2 : 1), index);

  return !WORD_CHARACTER.test(previousCharacter);
}

function beginsWithWordCharacter(value: string) {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

function findPrefixIndex(text: string, term: string, fromIndex = 0) {
  const requireWordBoundary = beginsWithWordCharacter(term);
  let index = text.indexOf(term, fromIndex);

  while (index >= 0) {
    if (!requireWordBoundary || isWordBoundary(text, index)) return index;
    index = text.indexOf(term, index + 1);
  }

  return -1;
}

function findTokenIndex(text: string, token: string, fromIndex = 0) {
  if (!token.startsWith("#") || !isCompleteTagToken(token)) {
    return findPrefixIndex(text, token, fromIndex);
  }

  const tag = normalizeTag(token);
  const match = findTagMatches(text).find(
    (candidate) => candidate.start >= fromIndex && candidate.tag === tag,
  );
  return match?.start ?? -1;
}

function tokenScore(fieldValue: string, token: string, index: number, weight: number) {
  let score = weight + Math.min(token.length, 24);

  if (fieldValue === token) score += 90;
  else if (index === 0) score += 28;

  if (isWordBoundary(fieldValue, index)) score += 18;
  score -= Math.min(12, Math.floor(index / 80));

  return score;
}

function evaluateFields<Name extends SearchMatchedField>(
  fields: SearchField<Name>[],
  tokens: string[],
  rankingPhrase: string,
) {
  const matches = fields.map<FieldMatch<Name>>((searchField) => ({
    field: searchField,
    tokenIndexes: new Map(
      tokens.flatMap((token) => {
        const index = findTokenIndex(searchField.normalized.value, token);
        return index < 0 ? [] : [[token, index] as const];
      }),
    ),
  }));

  let score = 0;
  for (const token of tokens) {
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const match of matches) {
      const index = match.tokenIndexes.get(token);
      if (index === undefined) continue;

      bestScore = Math.max(
        bestScore,
        tokenScore(
          match.field.normalized.value,
          token,
          index,
          match.field.weight,
        ),
      );
    }

    if (!Number.isFinite(bestScore)) return null;
    score += bestScore;
  }

  if (rankingPhrase) {
    for (const match of matches) {
      const phraseIndex = findPrefixIndex(
        match.field.normalized.value,
        rankingPhrase,
      );
      if (phraseIndex >= 0) {
        score += Math.round(match.field.weight * 0.35) + 30;
        if (match.field.normalized.value === rankingPhrase) score += 45;
        break;
      }
    }
  }

  const excerptMatch =
    tokens.length === 0
      ? matches.find((match) =>
          ["body", "quote", "note"].includes(match.field.name),
        ) ?? matches[0]
      : matches
          .filter((match) => match.tokenIndexes.size > 0)
          .sort((left, right) => {
            return (
              right.tokenIndexes.size - left.tokenIndexes.size ||
              right.field.weight - left.field.weight ||
              Math.min(...left.tokenIndexes.values()) -
                Math.min(...right.tokenIndexes.values())
            );
          })[0];

  if (!excerptMatch) return null;
  return { score, excerptMatch };
}

function containsExcludedTerm(
  fields: SearchField[],
  excludedTerms: readonly string[],
) {
  return excludedTerms.some((term) =>
    fields.some(
      (searchField) => findTokenIndex(searchField.normalized.value, term) >= 0,
    ),
  );
}

function allTokenRanges(fieldValue: NormalizedText, tokens: string[]) {
  const ranges: SearchMatchRange[] = [];

  for (const token of tokens) {
    let fromIndex = 0;
    let matchesForToken = 0;

    while (fromIndex <= fieldValue.value.length - token.length) {
      const index = findTokenIndex(fieldValue.value, token, fromIndex);
      if (index < 0) break;

      const start = fieldValue.starts[index];
      const end = fieldValue.ends[index + token.length - 1];
      if (start !== undefined && end !== undefined) ranges.push({ start, end });

      fromIndex = index + Math.max(1, token.length);
      matchesForToken += 1;
      if (matchesForToken >= 50) break;
    }
  }

  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function mergeRanges(ranges: SearchMatchRange[]) {
  const merged: SearchMatchRange[] = [];

  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function excerptWindow(text: string, anchor: SearchMatchRange) {
  if (text.length <= EXCERPT_LENGTH) {
    return { start: 0, end: text.length };
  }

  const contentLength = EXCERPT_LENGTH - 2;
  let start = Math.max(0, anchor.start - Math.floor(contentLength * 0.35));
  let end = Math.min(text.length, start + contentLength);
  start = Math.max(0, end - contentLength);

  if (start > 0) {
    const nextSpace = text.indexOf(" ", start);
    if (nextSpace >= 0 && nextSpace - start <= 24) start = nextSpace + 1;
  }

  if (end < text.length) {
    const previousSpace = text.lastIndexOf(" ", end);
    if (previousSpace > start && end - previousSpace <= 24) end = previousSpace;
  }

  return { start, end };
}

function createExcerpt(fieldMatch: FieldMatch, tokens: string[]) {
  const sourceRanges = allTokenRanges(fieldMatch.field.normalized, tokens);
  const anchor = sourceRanges[0] ?? { start: 0, end: 0 };
  const window = excerptWindow(fieldMatch.field.text, anchor);
  const prefix = window.start > 0 ? "…" : "";
  const suffix = window.end < fieldMatch.field.text.length ? "…" : "";
  const excerpt = `${prefix}${fieldMatch.field.text.slice(window.start, window.end)}${suffix}`;
  const offset = prefix.length - window.start;
  const excerptRanges = mergeRanges(
    sourceRanges
      .filter((range) => range.end > window.start && range.start < window.end)
      .map((range) => ({
        start: Math.max(window.start, range.start) + offset,
        end: Math.min(window.end, range.end) + offset,
      })),
  );

  return { excerpt, excerptRanges };
}

function shortTitle(value: string, fallback: string) {
  const title = collapsePlainText(value) || fallback;
  if (title.length <= 100) return title;
  return `${title.slice(0, 99).trimEnd()}…`;
}

function matchesTagFilters(
  documentTags: readonly string[],
  query: ParsedSearchQuery,
) {
  const tags = new Set(documentTags);
  return (
    query.requiredTags.every((tag) => tags.has(tag)) &&
    query.excludedTags.every((tag) => !tags.has(tag))
  );
}

function diaryResult(
  document: DiarySearchDocument,
  query: ParsedSearchQuery,
): DiarySearchResult | null {
  if (!matchesTagFilters(document.tags, query)) return null;

  const fields = diaryFields(document);
  if (containsExcludedTerm(fields, query.excluded)) return null;

  const evaluation = evaluateFields(fields, query.required, query.rankingPhrase);
  if (!evaluation) return null;

  const { excerpt, excerptRanges } = createExcerpt(
    evaluation.excerptMatch,
    query.required,
  );

  return {
    kind: "diary",
    id: document.id,
    path: document.path,
    fileName: document.fileName,
    dateLabel: document.dateLabel,
    modifiedAt: document.modifiedAt,
    title: document.dateLabel || document.fileName,
    metadata: document.fileName,
    excerpt,
    excerptRanges,
    matchedField: evaluation.excerptMatch.field.name,
    score: evaluation.score + query.requiredTags.length * 180,
    timestamp: document.modifiedAt,
  };
}

function captureResult(
  document: CaptureSearchDocument,
  query: ParsedSearchQuery,
): CaptureSearchResult | null {
  if (!matchesTagFilters(document.tags, query)) return null;

  const fields = captureFields(document);
  if (containsExcludedTerm(fields, query.excluded)) return null;

  const evaluation = evaluateFields(fields, query.required, query.rankingPhrase);
  if (!evaluation) return null;

  const { excerpt, excerptRanges } = createExcerpt(
    evaluation.excerptMatch,
    query.required,
  );
  const source = document.sourceTitle || document.sourceApp;
  const metadata = [source, document.dateLabel]
    .filter((value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
    )
    .join(" · ");

  return {
    kind: "capture",
    id: document.id,
    captureId: document.captureId,
    dateLabel: document.dateLabel,
    selectedText: document.selectedText,
    note: document.note,
    sourceTitle: document.sourceTitle,
    sourceApp: document.sourceApp,
    sourceUrl: document.sourceUrl,
    savedAt: document.savedAt,
    title: shortTitle(
      document.selectedText || document.note || source || "",
      "Capture",
    ),
    metadata,
    excerpt,
    excerptRanges,
    matchedField: evaluation.excerptMatch.field.name,
    score: evaluation.score + query.requiredTags.length * 180,
    timestamp: document.savedAt,
  };
}

/**
 * Searches the supplied local snapshot. Every result represents one document;
 * `limit` is a global cap across both diary entries and captures.
 */
export function searchDocuments(
  documents: readonly SearchDocument[],
  query: string,
  limit = DEFAULT_SEARCH_RESULT_LIMIT,
): SearchResult[] {
  const parsedQuery = parseSearchQuery(query);
  if (
    parsedQuery.required.length === 0 &&
    parsedQuery.excluded.length === 0 &&
    parsedQuery.requiredTags.length === 0 &&
    parsedQuery.excludedTags.length === 0
  ) {
    return [];
  }

  const resultLimit = Math.min(
    MAX_SEARCH_RESULT_LIMIT,
    Math.max(
      0,
      Number.isNaN(limit) ? DEFAULT_SEARCH_RESULT_LIMIT : Math.floor(limit),
    ),
  );
  if (resultLimit === 0) return [];

  return documents
    .map((document) =>
      document.kind === "diary"
        ? diaryResult(document, parsedQuery)
        : captureResult(document, parsedQuery),
    )
    .filter((result): result is SearchResult => result !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.timestamp - left.timestamp ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, resultLimit);
}
