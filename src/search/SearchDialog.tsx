import {
  type CompositionEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, CornerDownLeft, List, Plus, Search } from "lucide-react";

import { errorMessage } from "../errors";
import { formatShortcut } from "../shortcuts";
import { searchDocuments } from "./search";
import {
  type CaptureCommandId,
  capturePickerResults,
  matchingCaptureCommands,
  nextSelectableIndex,
  scopedCaptureDocuments,
} from "./captureCommands";
import { collectTagSuggestions, tagPrefixQuery } from "./tagSuggestions";
import type {
  CaptureSearchDocument,
  CaptureSearchResult,
  DiarySearchDocument,
  DiarySearchResult,
  SearchResult,
  SearchNoteContext,
} from "./types";

type SearchDialogProps = {
  open: boolean;
  searchShortcut: string;
  initialQuery?: string;
  onOpenChange: (open: boolean) => void;
  diaryDocuments: DiarySearchDocument[];
  captureDocuments: CaptureSearchDocument[];
  diaryLoading?: boolean;
  captureLoading?: boolean;
  diaryWarning?: string | null;
  captureWarning?: string | null;
  currentNote?: SearchNoteContext | null;
  onAddCapture?: CaptureAction;
  onRevealNoteCapture?: CaptureAction;
  onAfterClose?: () => void;
  onOpenDiary: (
    result: DiarySearchResult,
  ) => boolean | void | Promise<boolean | void>;
  onOpenCapture: (
    result: CaptureSearchResult,
  ) => boolean | void | Promise<boolean | void>;
};

type CaptureAction = (
  result: CaptureSearchResult,
  notePath: string,
) => boolean | void | Promise<boolean | void>;

type CaptureScope = {
  mode: CaptureCommandId;
  notePath: string;
  noteLabel: string;
};

const MAX_RESULTS = 100;

function resultKey(result: SearchResult) {
  return `${result.kind}:${result.id}`;
}

function HighlightedExcerpt({ result }: { result: SearchResult }) {
  if (result.excerptRanges.length === 0) return result.excerpt;

  const fragments: ReactNode[] = [];
  let cursor = 0;

  for (const [index, range] of result.excerptRanges.entries()) {
    const start = Math.max(cursor, Math.min(range.start, result.excerpt.length));
    const end = Math.max(start, Math.min(range.end, result.excerpt.length));

    if (start > cursor) {
      fragments.push(result.excerpt.slice(cursor, start));
    }
    if (end > start) {
      fragments.push(
        <mark
          key={`${start}-${end}-${index}`}
          className="bg-transparent font-medium text-foreground"
        >
          {result.excerpt.slice(start, end)}
        </mark>,
      );
    }
    cursor = end;
  }

  if (cursor < result.excerpt.length) {
    fragments.push(result.excerpt.slice(cursor));
  }

  return fragments;
}

function ResultOption({
  result,
  index,
  optionId,
  active,
  busy,
  alreadyAdded,
  onActivate,
  onChoose,
}: {
  result: SearchResult;
  index: number;
  optionId: string;
  active: boolean;
  busy: boolean;
  alreadyAdded: boolean;
  onActivate: (index: number) => void;
  onChoose: (result: SearchResult) => void;
}) {
  const metadata =
    result.kind === "diary" &&
    /^\d{1,2}-\d{1,2}-\d{4}\.(?:md|markdown)$/i.test(result.fileName)
      ? ""
      : result.metadata;
  const showExcerpt =
    Boolean(result.excerpt) &&
    result.excerpt !== result.title &&
    result.excerpt !== metadata;

  return (
    <button
      id={optionId}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={active}
      disabled={busy || alreadyAdded}
      aria-disabled={busy || alreadyAdded}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => { if (!busy && !alreadyAdded) onActivate(index); }}
      onClick={() => onChoose(result)}
      className={`group flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors disabled:opacity-55 ${
        active ? "bg-primary/[0.07]" : "hover:bg-primary/[0.045]"
      }`}
    >
      <span className="flex w-full min-w-0 items-baseline gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground/90 ${
            result.kind === "diary" ? "font-heading text-[15px]" : "font-medium"
          }`}
        >
          {result.title}
        </span>
        {metadata ? (
          <span className="diary-meta-text max-w-[45%] shrink-0 truncate text-muted-foreground">
            {metadata}
          </span>
        ) : null}
      </span>
      {alreadyAdded ? (
        <span className="diary-meta-text text-muted-foreground">Already in this note</span>
      ) : null}
      {showExcerpt ? (
        <span className="line-clamp-2 whitespace-pre-wrap text-xs leading-[1.1rem] text-foreground/60">
          <HighlightedExcerpt result={result} />
        </span>
      ) : null}
    </button>
  );
}

export default function SearchDialog({
  open,
  searchShortcut,
  initialQuery = "",
  onOpenChange,
  diaryDocuments,
  captureDocuments,
  diaryLoading = false,
  captureLoading = false,
  diaryWarning = null,
  captureWarning = null,
  currentNote = null,
  onAddCapture,
  onRevealNoteCapture,
  onAfterClose,
  onOpenDiary,
  onOpenCapture,
}: SearchDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement | null>(null);
  const openingRef = useRef(false);
  const actionEpoch = useRef(0);
  const openRef = useRef(open);
  const currentNoteRef = useRef(currentNote);
  openRef.current = open;
  currentNoteRef.current = currentNote;

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<CaptureScope | null>(null);
  const [generalQuery, setGeneralQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [composing, setComposing] = useState(false);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const busy = openingKey !== null;
  const linkedCaptureIds = currentNote?.captureIds ?? [];
  const linkedCaptures = useMemo(() => new Set(linkedCaptureIds), [linkedCaptureIds]);
  const scopedDocuments = useMemo(
    () => scope
      ? scopedCaptureDocuments(captureDocuments, scope.mode, linkedCaptureIds)
      : captureDocuments,
    [captureDocuments, scope, linkedCaptureIds],
  );
  const documents = useMemo(
    () => scope ? scopedDocuments : [...diaryDocuments, ...captureDocuments],
    [captureDocuments, diaryDocuments, scope, scopedDocuments],
  );
  const allTagSuggestions = useMemo(
    () => collectTagSuggestions(documents),
    [documents],
  );
  const tagPrefix = tagPrefixQuery(query);
  const exactTagExists = tagPrefix !== null &&
    allTagSuggestions.some((suggestion) => suggestion.tag === tagPrefix);
  const showingTagSuggestions = tagPrefix !== null && !exactTagExists;
  const tagSuggestions = useMemo(
    () => tagPrefix === null ? [] : allTagSuggestions
      .filter((suggestion) => suggestion.tag.startsWith(tagPrefix))
      .slice(0, MAX_RESULTS),
    [allTagSuggestions, tagPrefix],
  );
  const commands = useMemo(
    () => scope || !currentNote || showingTagSuggestions ? [] : matchingCaptureCommands(query)
      .filter((command) => command.id === "add-capture" ? Boolean(onAddCapture) : Boolean(onRevealNoteCapture)),
    [currentNote, onAddCapture, onRevealNoteCapture, query, scope, showingTagSuggestions],
  );
  const results = useMemo(() => {
    if (scope) return capturePickerResults(scopedDocuments, query, MAX_RESULTS);
    const ranked = searchDocuments(documents, query, MAX_RESULTS);
    return [
      ...ranked.filter((result) => result.kind === "diary"),
      ...ranked.filter((result) => result.kind === "capture"),
    ];
  }, [documents, query, scope, scopedDocuments]);
  const indexedResults = results.map((result, index) => ({ result, index: index + commands.length }));
  const diaryResults = indexedResults.filter((entry) => entry.result.kind === "diary");
  const captureResults = indexedResults.filter((entry) => entry.result.kind === "capture");
  const normalizedQuery = query.trim();
  const loading = captureLoading || (!scope && diaryLoading);
  const selectableIndexes = useMemo(() => {
    if (showingTagSuggestions) return tagSuggestions.map((_, index) => index);
    return [
      ...commands.map((_, index) => index),
      ...results.flatMap((result, index) =>
        scope?.mode === "add-capture" && result.kind === "capture" && linkedCaptures.has(result.captureId)
          ? [] : [index + commands.length],
      ),
    ];
  }, [commands, linkedCaptures, results, scope, showingTagSuggestions, tagSuggestions]);
  const activeCommand = !showingTagSuggestions && activeIndex >= 0 ? commands[activeIndex] : undefined;
  const activeResult = !showingTagSuggestions && activeIndex >= commands.length
    ? results[activeIndex - commands.length] : undefined;
  const activeTagSuggestion = showingTagSuggestions && activeIndex >= 0
    ? tagSuggestions[activeIndex] : undefined;
  const activeOptionId = activeIndex < 0 ? undefined
    : activeTagSuggestion ? `${listId}-tag-${activeIndex}`
    : activeCommand || activeResult ? `${listId}-option-${activeIndex}` : undefined;
  const title = scope
    ? scope.mode === "add-capture" ? `Add capture to ${scope.noteLabel}` : `Captures in ${scope.noteLabel}`
    : "Search diary and captures";

  useEffect(() => {
    actionEpoch.current += 1;
    openingRef.current = false;
    setOpeningKey(null);
    if (!open) return;
    setQuery(initialQuery);
    setGeneralQuery(initialQuery);
    setScope(null);
    setActiveIndex(-1);
    setComposing(false);
    setNavigationError(null);
  }, [initialQuery, open]);

  useEffect(() => () => { actionEpoch.current += 1; }, []);

  useEffect(() => {
    if (!scope || scope.notePath === currentNote?.path) return;
    actionEpoch.current += 1;
    openingRef.current = false;
    setOpeningKey(null);
    setScope(null);
    setQuery(generalQuery);
    setActiveIndex(-1);
    setNavigationError(null);
  }, [currentNote?.path, generalQuery, scope]);

  useEffect(() => {
    setActiveIndex((current) => selectableIndexes.includes(current)
      ? current : (selectableIndexes[0] ?? -1));
  }, [selectableIndexes]);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query, scope]);

  function returnToSearch() {
    if (openingRef.current) return;
    setScope(null);
    setQuery(generalQuery);
    setActiveIndex(-1);
    setNavigationError(null);
    inputRef.current?.focus();
  }

  function chooseCommand(mode: CaptureCommandId) {
    if (openingRef.current || !currentNote) return;
    setGeneralQuery(query);
    setScope({ mode, notePath: currentNote.path, noteLabel: currentNote.label });
    setQuery("");
    setActiveIndex(-1);
    setNavigationError(null);
    inputRef.current?.focus();
  }

  async function chooseResult(result: SearchResult) {
    if (openingRef.current || !openRef.current) return;
    if (scope && (result.kind !== "capture" || currentNote?.path !== scope.notePath)) return;
    if (scope?.mode === "add-capture" && result.kind === "capture" && linkedCaptures.has(result.captureId)) return;

    openingRef.current = true;
    const epoch = ++actionEpoch.current;
    setOpeningKey(resultKey(result));
    setNavigationError(null);
    const failureMessage = scope?.mode === "add-capture"
      ? "That capture could not be added to this note."
      : scope?.mode === "note-captures" ? "That capture could not be shown in this note."
      : "That result could not be opened.";
    const isCurrentAction = () => epoch === actionEpoch.current && openRef.current &&
      (!scope || currentNoteRef.current?.path === scope.notePath);

    try {
      let succeeded: boolean | void;
      if (scope && result.kind === "capture") {
        const action = scope.mode === "add-capture" ? onAddCapture : onRevealNoteCapture;
        succeeded = action ? await action(result, scope.notePath) : false;
      } else {
        succeeded = result.kind === "diary" ? await onOpenDiary(result) : await onOpenCapture(result);
      }
      if (!isCurrentAction()) return;
      if (succeeded !== false) onOpenChange(false);
      else setNavigationError(failureMessage);
    } catch (cause) {
      if (isCurrentAction()) setNavigationError(errorMessage(cause, failureMessage));
    } finally {
      if (epoch === actionEpoch.current) {
        openingRef.current = false;
        setOpeningKey(null);
      }
    }
  }

  function chooseTag(tag: string) {
    if (openingRef.current) return;
    setQuery(`#${tag}`);
    setActiveIndex(-1);
    setNavigationError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (composing || event.nativeEvent.isComposing || openingRef.current) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => nextSelectableIndex(selectableIndexes, current, event.key === "ArrowDown" ? 1 : -1));
        break;
      case "Home":
      case "End":
        if (selectableIndexes.length > 0) {
          event.preventDefault();
          setActiveIndex(event.key === "Home" ? selectableIndexes[0] : selectableIndexes[selectableIndexes.length - 1]);
        }
        break;
      case "Enter":
        event.preventDefault();
        if (activeTagSuggestion) chooseTag(activeTagSuggestion.tag);
        else if (activeCommand) chooseCommand(activeCommand.id);
        else if (activeResult) void chooseResult(activeResult);
        break;
    }
  }

  function beginComposition(_event: CompositionEvent<HTMLInputElement>) { setComposing(true); }
  function endComposition(_event: CompositionEvent<HTMLInputElement>) { setComposing(false); }

  function renderResult({ result, index }: { result: SearchResult; index: number }) {
    const active = index === activeIndex;
    const alreadyAdded = scope?.mode === "add-capture" && result.kind === "capture" && linkedCaptures.has(result.captureId);
    return (
      <div key={resultKey(result)} ref={(node) => {
        if (active) activeOptionRef.current = node?.firstElementChild as HTMLButtonElement | null;
      }}>
        <ResultOption
          result={result}
          index={index}
          optionId={`${listId}-option-${index}`}
          active={active}
          busy={busy}
          alreadyAdded={alreadyAdded}
          onActivate={setActiveIndex}
          onChoose={(chosen) => void chooseResult(chosen)}
        />
      </div>
    );
  }

  const resultCounts = [
    commands.length > 0 ? `${commands.length} ${commands.length === 1 ? "action" : "actions"}` : null,
    results.length > 0 || commands.length === 0 ? `${results.length} ${results.length === 1 ? "result" : "results"}` : null,
  ].filter(Boolean).join(", ");
  const resultAnnouncement = showingTagSuggestions
    ? `${tagSuggestions.length} matching ${tagSuggestions.length === 1 ? "tag" : "tags"}${loading ? ", still loading" : ""}.`
    : `${resultCounts}${loading ? ", still loading" : ""}.`;
  const footerAction = activeTagSuggestion ? "Filter" : activeCommand ? "Continue"
    : scope?.mode === "add-capture" ? "Add" : scope?.mode === "note-captures" ? "Show" : "Open";

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && openingRef.current) return;
      onOpenChange(nextOpen);
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/40" />
        <Dialog.Content
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!onAfterClose) return;
            event.preventDefault();
            requestAnimationFrame(() => { if (!openRef.current) onAfterClose(); });
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            if (openingRef.current || composing || event.isComposing) return;
            if (scope) returnToSearch();
            else onOpenChange(false);
          }}
          onInteractOutside={(event) => { if (openingRef.current) event.preventDefault(); }}
          className="fixed top-1/2 left-1/2 z-[91] flex min-h-[11rem] max-h-[min(36rem,calc(100vh-6rem))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/[0.09] outline-none"
        >
          <Dialog.Title id={titleId} className="sr-only">{title}</Dialog.Title>
          <Dialog.Description id={descriptionId} className="sr-only">
            {scope?.mode === "add-capture"
              ? "Search captures by text or hashtag. Press Enter to add a capture at your saved cursor position."
              : scope ? "Search captures already added to this note. Press Enter to show a capture in the note."
              : currentNote
                ? "Search all diary entries and saved captures, or choose an action for this note."
                : "Search all diary entries and saved captures."}
          </Dialog.Description>
          {scope ? (
            <div className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-0.5">
              <button
                type="button"
                aria-label="Back to search"
                disabled={busy}
                onClick={returnToSearch}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/[0.07] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-55"
              >
                <ArrowLeft aria-hidden="true" className="size-3.5" />
              </button>
              <span className="min-w-0 truncate text-xs font-medium text-foreground/80">{title}</span>
            </div>
          ) : null}
          <div className="flex h-12 shrink-0 items-center gap-2.5 px-3.5">
            <Search aria-hidden="true" className="size-4 shrink-0 text-foreground/35" strokeWidth={1.7} />
            <input
              ref={inputRef}
              type="search"
              value={query}
              role="combobox"
              aria-autocomplete="list"
              aria-label={scope ? "Search captures" : "Search diary and captures"}
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              readOnly={busy}
              placeholder={scope ? "Search captures or type # for tags" : "Search diary and captures"}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(-1);
                setNavigationError(null);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={beginComposition}
              onCompositionEnd={endComposition}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/75 [&::-webkit-search-cancel-button]:hidden"
            />
            <kbd className="shrink-0 rounded border border-foreground/[0.08] px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">{formatShortcut(searchShortcut)}</kbd>
          </div>
          <div className="h-px shrink-0 bg-foreground/[0.06]" />
          <p aria-live="polite" aria-atomic="true" className="sr-only">{resultAnnouncement}</p>
          <div
            id={listId}
            role="listbox"
            aria-label={scope ? title : "Search results"}
            aria-busy={busy || loading}
            className="diary-entry-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2"
          >
            {showingTagSuggestions ? (
              <section role="group" aria-label="Tags">
                <h3 className="diary-group-label px-2 pt-1 pb-1 text-muted-foreground">Tags</h3>
                <div role="presentation" className="space-y-0.5">
                  {tagSuggestions.map((suggestion, index) => {
                    const active = activeIndex === index;
                    return (
                      <button
                        key={suggestion.tag}
                        id={`${listId}-tag-${index}`}
                        ref={active ? activeOptionRef : undefined}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={active}
                        disabled={busy}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => chooseTag(suggestion.tag)}
                        className={`flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left outline-none transition-colors ${active ? "bg-primary/[0.07]" : "hover:bg-primary/[0.045]"}`}
                      >
                        <span className="diary-tag text-[13px]">#{suggestion.tag}</span>
                        <span className="diary-meta-text text-muted-foreground">{suggestion.count}</span>
                      </button>
                    );
                  })}
                </div>
                {tagSuggestions.length === 0 && !loading ? <p className="px-2 py-5 text-xs text-muted-foreground">No matching tags.</p> : null}
              </section>
            ) : (
              <>
                {commands.length > 0 ? (
                  <section role="group" aria-label="This note">
                    <h3 className="diary-group-label px-2 pt-1 pb-1 text-muted-foreground">This note</h3>
                    <div role="presentation" className="space-y-0.5">
                      {commands.map((command, index) => {
                        const active = activeIndex === index;
                        const Icon = command.id === "add-capture" ? Plus : List;
                        return (
                          <button
                            key={command.id}
                            id={`${listId}-option-${index}`}
                            ref={active ? activeOptionRef : undefined}
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-selected={active}
                            disabled={busy}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseMove={() => setActiveIndex(index)}
                            onClick={() => chooseCommand(command.id)}
                            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] text-foreground/90 outline-none transition-colors ${active ? "bg-primary/[0.07]" : "hover:bg-primary/[0.045]"}`}
                          >
                            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.7} />
                            {command.label}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
                {diaryResults.length > 0 ? (
                  <section role="group" aria-label="Diary" className={commands.length > 0 ? "mt-2" : ""}>
                    <h3 className="diary-group-label px-2 pt-1 pb-1 text-muted-foreground">Diary</h3>
                    <div role="presentation" className="space-y-0.5">{diaryResults.map(renderResult)}</div>
                  </section>
                ) : null}
                {captureResults.length > 0 ? (
                  <section role="group" aria-label="Captures" className={diaryResults.length > 0 || commands.length > 0 ? "mt-2" : ""}>
                    <h3 className="diary-group-label px-2 pt-1 pb-1 text-muted-foreground">{scope && !normalizedQuery ? "Recent captures" : "Captures"}</h3>
                    <div role="presentation" className="space-y-0.5">{captureResults.map(renderResult)}</div>
                  </section>
                ) : null}
                {results.length === 0 && commands.length === 0 && !loading ? (
                  <p className="px-2 py-5 text-xs text-muted-foreground">
                    {normalizedQuery ? `No results for “${normalizedQuery}”.`
                      : scope?.mode === "note-captures" ? "No captures have been added to this note."
                      : scope ? "No saved captures yet."
                      : "Type to search everything."}
                  </p>
                ) : null}
              </>
            )}
            {!scope && diaryLoading ? <p role="status" className="diary-meta-text px-2 pt-2 text-muted-foreground">Loading diary entries…</p> : null}
            {captureLoading ? <p role="status" className="diary-meta-text px-2 pt-2 text-muted-foreground">Loading captures…</p> : null}
            {!scope && diaryWarning ? <p className="diary-meta-text px-2 pt-2 text-muted-foreground">Diary: {diaryWarning}</p> : null}
            {captureWarning ? <p className="diary-meta-text px-2 pt-2 text-muted-foreground">Captures: {captureWarning}</p> : null}
            {navigationError ? <p role="alert" className="diary-meta-text px-2 pt-2 text-destructive">{navigationError}</p> : null}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-foreground/[0.06] px-3.5 py-2 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><CornerDownLeft aria-hidden="true" className="size-3" />{busy ? "Working…" : footerAction}</span>
            <span>Esc {scope ? "Back" : "Close"}</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
