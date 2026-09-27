import { useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";

import type { DiaryDate } from "../diaryDates";
import { errorMessage } from "../errors";
import { createOperation } from "../diagnostics/operation";
import { logEvent } from "../diagnostics/logger";
import TaggedText from "../tags/TaggedText";
import {
  deleteCapture,
  openCaptureSource,
  updateCaptureNote,
} from "./api";
import { groupCapturesByDay } from "./dateGroups";
import { captureSourceLabel } from "./display";
import { newestLinkedDateKeys } from "./dateLinks";
import LinkedNotesPopover from "./LinkedNotesPopover";
import type { CaptureShortcutStatus, SavedCapture } from "./types";

export type CaptureRevealRequest = {
  captureId: string;
  requestId: number;
};

type CaptureArchiveProps = {
  className?: string;
  captures: SavedCapture[];
  shortcutStatus: CaptureShortcutStatus | null;
  loading: boolean;
  captureDataReady: boolean;
  loadError: string | null;
  onReload: (showLoading?: boolean) => Promise<boolean>;
  onCaptureUpdated: (capture: SavedCapture) => void;
  onCaptureDeleted: (captureId: string) => void;
  onEditingChange?: (editing: boolean) => void;
  diaryTargets: DiaryDate[];
  onOpenDiaryDate: (dateKey: string, captureId: string) => void;
  onSearchTag: (tag: string) => void;
  revealRequest?: CaptureRevealRequest | null;
  onRevealHandled?: (request: CaptureRevealRequest) => void;
};

const missingCaptureError = "That capture is no longer available.";

export default function CaptureArchive({
  className = "",
  captures,
  shortcutStatus,
  loading,
  captureDataReady,
  loadError,
  onReload,
  onCaptureUpdated,
  onCaptureDeleted,
  onEditingChange,
  diaryTargets,
  onOpenDiaryDate,
  onSearchTag,
  revealRequest = null,
  onRevealHandled,
}: CaptureArchiveProps) {
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [revealedCapture, setRevealedCapture] =
    useState<CaptureRevealRequest | null>(null);
  const captureElementsRef = useRef(new Map<string, HTMLElement>());
  const handledRevealKeyRef = useRef<string | null>(null);
  const revealHighlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onEditingChange?.(editingId !== null || busyId !== null);
    return () => onEditingChange?.(false);
  }, [editingId, busyId, onEditingChange]);

  useEffect(() => {
    return () => {
      if (revealHighlightTimerRef.current !== null) {
        window.clearTimeout(revealHighlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!revealRequest || loading || !captureDataReady) return;

    const requestKey = `${revealRequest.requestId}:${revealRequest.captureId}`;
    if (handledRevealKeyRef.current === requestKey) return;
    handledRevealKeyRef.current = requestKey;

    const captureElement = captureElementsRef.current.get(
      revealRequest.captureId,
    );

    if (!captureElement) {
      logEvent("warn", "capture.archive", { action: "reveal", captureId: revealRequest.captureId, outcome: "missing" });
      setRevealedCapture(null);
      setError(missingCaptureError);
      onRevealHandled?.(revealRequest);
      return;
    }

    setError((current) =>
      current === missingCaptureError ? null : current,
    );
    setRevealedCapture(revealRequest);

    if (revealHighlightTimerRef.current !== null) {
      window.clearTimeout(revealHighlightTimerRef.current);
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    captureElement.scrollIntoView({
      block: "center",
      behavior: reducedMotion ? "auto" : "smooth",
    });

    let focusCompleted = false;
    const focusFrame = window.requestAnimationFrame(() => {
      focusCompleted = true;
      captureElement.focus({ preventScroll: true });
      logEvent("info", "capture.archive", { action: "reveal", captureId: revealRequest.captureId, outcome: "success" });
      onRevealHandled?.(revealRequest);
    });

    revealHighlightTimerRef.current = window.setTimeout(() => {
      setRevealedCapture((current) =>
        current?.requestId === revealRequest.requestId ? null : current,
      );
      revealHighlightTimerRef.current = null;
    }, reducedMotion ? 900 : 1800);

    return () => {
      window.cancelAnimationFrame(focusFrame);

      // React's development Strict Mode immediately cleans up and re-runs
      // effects. Let that second pass handle a request whose focus frame did
      // not get a chance to run.
      if (
        !focusCompleted &&
        handledRevealKeyRef.current === requestKey
      ) {
        handledRevealKeyRef.current = null;
      }
    };
  }, [
    captureDataReady,
    captures,
    loading,
    onRevealHandled,
    revealRequest,
  ]);

  async function retryLoad() {
    setError(null);
    await onReload(true);
  }

  function beginEditing(capture: SavedCapture) {
    logEvent("debug", "capture.archive", { action: "edit_opened", captureId: capture.captureId });
    setEditingId(capture.captureId);
    setEditingNote(capture.note);
    setConfirmDeleteId(null);
    setError(null);
  }

  async function saveEditedNote(capture: SavedCapture) {
    const operation = createOperation();
    setBusyId(capture.captureId);
    setError(null);

    try {
      const updated = await updateCaptureNote(capture.captureId, editingNote, operation);
      onCaptureUpdated(updated);
      setEditingId(null);
    } catch (cause) {
      setError(errorMessage(cause, "The note could not be updated."));
    } finally {
      setBusyId(null);
    }
  }

  async function removeCapture(captureId: string) {
    const operation = createOperation();
    setBusyId(captureId);
    setError(null);

    try {
      await deleteCapture(captureId, operation);
      onCaptureDeleted(captureId);
      setConfirmDeleteId(null);
      if (editingId === captureId) setEditingId(null);
    } catch (cause) {
      setError(errorMessage(cause, "The capture could not be deleted."));
    } finally {
      setBusyId(null);
    }
  }

  async function openSource(url: string) {
    const operation = createOperation();
    setError(null);

    try {
      await openCaptureSource(url, operation);
    } catch (cause) {
      setError(errorMessage(cause, "The source could not be opened."));
    }
  }

  const mutating = busyId !== null;
  const captureGroups = groupCapturesByDay(captures);
  const diaryTargetsByDate = new Map(
    diaryTargets.map((target) => [target.dateKey, target]),
  );

  return (
    <section
      aria-labelledby="capture-archive-heading"
      className={`min-h-0 bg-background text-foreground ${className}`}
    >
      <div className="diary-frame">
        <div className="px-20 pt-8 pb-12 max-[35rem]:px-8">
          <header>
            <h2
              id="capture-archive-heading"
              className="diary-page-title"
            >
              Captures
            </h2>
          </header>

          {error || loadError || shortcutStatus?.error ? (
            <p role="alert" className="mt-4 text-xs text-destructive">
              {error || loadError || shortcutStatus?.error}
            </p>
          ) : null}

          {loading ? (
            <div role="status" className="py-10 text-sm text-muted-foreground">
              Loading captures…
            </div>
          ) : captures.length === 0 ? (
            <div className="py-10 text-sm text-muted-foreground">
              <p>No captures yet.</p>
              {error || loadError ? (
                <button
                  type="button"
                  onClick={() => void retryLoad()}
                  className="mt-3 rounded-md px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-primary/[0.06]"
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {captureGroups.map((group) => (
                <section
                  key={group.key}
                  aria-labelledby={`capture-group-${group.key}`}
                >
                  <h3
                    id={`capture-group-${group.key}`}
                    className="diary-section-title mb-3 text-foreground/65"
                  >
                    {group.label}
                  </h3>
                  <ol className="space-y-3">
                    {group.captures.map((capture) => {
                      const editing = editingId === capture.captureId;
                      const busy = busyId === capture.captureId;
                      const confirmingDelete =
                        confirmDeleteId === capture.captureId;
                      const sourceLabel = captureSourceLabel(capture);
                      const linkedDateKeys = newestLinkedDateKeys(
                        capture.assignedDates,
                      );

                      return (
                        <li key={capture.captureId}>
                          <article
                            ref={(element) => {
                              if (element) {
                                captureElementsRef.current.set(
                                  capture.captureId,
                                  element,
                                );
                              } else {
                                captureElementsRef.current.delete(
                                  capture.captureId,
                                );
                              }
                            }}
                            tabIndex={-1}
                            className={`capture-archive-card ${
                              revealedCapture?.captureId === capture.captureId
                                ? "capture-archive-revealed"
                                : ""
                            }`}
                          >
                            {capture.selectedText ? (
                              <blockquote className="diary-capture-quotation whitespace-pre-wrap">
                                <span aria-hidden="true">&quot;</span>
                                {capture.selectedText}
                                <span aria-hidden="true">&quot;</span>
                              </blockquote>
                            ) : null}

                            <div className="diary-capture-source-line min-w-0">
                              {capture.sourceUrl ? (
                                <button
                                  type="button"
                                  title={capture.sourceUrl}
                                  aria-label={`Open source: ${sourceLabel}`}
                                  onClick={() =>
                                    void openSource(capture.sourceUrl!)
                                  }
                                  className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-left align-bottom transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
                                >
                                  <Link2
                                    aria-hidden="true"
                                    className="size-3.5 shrink-0 text-foreground/40"
                                    strokeWidth={1.75}
                                  />
                                  <span className="truncate">{sourceLabel}</span>
                                </button>
                              ) : (
                                <span className="block truncate" title={sourceLabel}>
                                  {sourceLabel}
                                </span>
                              )}
                            </div>

                            {editing ? (
                              <label className="diary-capture-note diary-capture-note-start block">
                                <span className="sr-only">Capture note</span>
                                <textarea
                                  autoFocus
                                  value={editingNote}
                                  disabled={mutating}
                                  onChange={(event) =>
                                    setEditingNote(event.currentTarget.value)
                                  }
                                  className="block min-h-24 w-full resize-y rounded-lg border border-foreground/10 bg-background/50 px-3 py-2 outline-none transition-colors focus:border-foreground/25 disabled:opacity-60"
                                />
                              </label>
                            ) : capture.note ? (
                              <p className="diary-capture-note diary-capture-note-start whitespace-pre-wrap">
                                <TaggedText onSearchTag={onSearchTag}>
                                  {capture.note}
                                </TaggedText>
                              </p>
                            ) : capture.selectedText ? null : (
                              <p className="diary-capture-note diary-capture-note-start text-muted-foreground">
                                No thought added.
                              </p>
                            )}

                            <footer className="diary-meta-text mt-4 flex min-w-0 flex-wrap items-center justify-end gap-x-1 gap-y-2 text-foreground/60">
                              <LinkedNotesPopover
                                dateKeys={linkedDateKeys}
                                targetsByDate={diaryTargetsByDate}
                                onOpenDate={(dateKey) =>
                                  onOpenDiaryDate(dateKey, capture.captureId)
                                }
                              />

                              {editing ? (
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={mutating}
                                    onClick={() => setEditingId(null)}
                                    className="rounded-md px-2 py-1 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={mutating}
                                    onClick={() => void saveEditedNote(capture)}
                                    className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-60"
                                  >
                                    {busy ? "Saving…" : "Save"}
                                  </button>
                                </div>
                              ) : confirmingDelete ? (
                                <div className="flex shrink-0 items-center gap-1">
                                  <span className="mr-1">Delete this capture?</span>
                                  <button
                                    type="button"
                                    disabled={mutating}
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="rounded-md px-2 py-1 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
                                  >
                                    Keep
                                  </button>
                                  <button
                                    type="button"
                                    disabled={mutating}
                                    onClick={() =>
                                      void removeCapture(capture.captureId)
                                    }
                                    className="rounded-md bg-destructive px-2.5 py-1 font-medium text-white disabled:opacity-60"
                                  >
                                    {busy ? "Deleting…" : "Delete"}
                                  </button>
                                </div>
                              ) : (
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={mutating}
                                    onClick={() => beginEditing(capture)}
                                    className="rounded-md px-2 py-1 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    disabled={mutating}
                                    onClick={() => {
                                      setConfirmDeleteId(capture.captureId);
                                      setEditingId(null);
                                    }}
                                    className="rounded-md px-2 py-1 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </footer>
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
