export type DiarySearchDocument = {
  kind: "diary";
  id: string;
  path: string;
  fileName: string;
  fileNameAliases?: readonly string[];
  dateLabel: string;
  dateAliases?: readonly string[];
  body: string;
  searchText?: string;
  tags: readonly string[];
  modifiedAt: number;
};

export type CaptureSearchDocument = {
  kind: "capture";
  id: string;
  captureId: string;
  dateLabel: string;
  dateAliases?: readonly string[];
  selectedText: string;
  note: string;
  sourceTitle: string | null;
  sourceApp: string | null;
  sourceUrl: string | null;
  tags: readonly string[];
  savedAt: number;
};

export type SearchDocument = DiarySearchDocument | CaptureSearchDocument;

export type SearchNoteContext = {
  path: string;
  label: string;
  captureIds: readonly string[];
};

export type DiaryMatchedField = "date" | "fileName" | "body";

export type CaptureMatchedField =
  | "date"
  | "quote"
  | "note"
  | "sourceTitle"
  | "sourceApp"
  | "sourceUrl";

export type SearchMatchedField = DiaryMatchedField | CaptureMatchedField;

export type SearchMatchRange = {
  /** Inclusive UTF-16 offset into `SearchResult.excerpt`. */
  start: number;
  /** Exclusive UTF-16 offset into `SearchResult.excerpt`. */
  end: number;
};

type SearchResultBase = {
  id: string;
  title: string;
  metadata: string;
  excerpt: string;
  excerptRanges: SearchMatchRange[];
  matchedField: SearchMatchedField;
  score: number;
  timestamp: number;
};

export type DiarySearchResult = SearchResultBase & {
  kind: "diary";
  path: string;
  fileName: string;
  dateLabel: string;
  modifiedAt: number;
  matchedField: DiaryMatchedField;
};

export type CaptureSearchResult = SearchResultBase & {
  kind: "capture";
  captureId: string;
  dateLabel: string;
  selectedText: string;
  note: string;
  sourceTitle: string | null;
  sourceApp: string | null;
  sourceUrl: string | null;
  savedAt: number;
  matchedField: CaptureMatchedField;
};

export type SearchResult = DiarySearchResult | CaptureSearchResult;
