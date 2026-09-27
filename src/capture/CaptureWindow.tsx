import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Link2 } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { createOperation, type OperationContext } from "../diagnostics/operation";
import { errorCode, logEvent, updateDiagnosticState } from "../diagnostics/logger";
import { errorMessage } from "../errors";
import { watchTheme } from "../theme";
import {
  formatShortcut,
  isShortcutRecording,
  matchesShortcut,
  readAppShortcuts,
  watchAppShortcuts,
} from "../shortcuts";
import {
  cancelCapture,
  CAPTURE_CLOSE_REQUESTED_EVENT,
  CAPTURE_DRAFT_READY_EVENT,
  getCaptureDraft,
  isCaptureAccessibilityTrusted,
  openAccessibilitySettings,
  openCaptureSource,
  saveCapture,
  updateCaptureDraft,
} from "./api";
import type { CaptureDraft } from "./types";

const NOTE_BACKUP_KEY = "diary.capture-draft-note";
const NOTE_PERSIST_DELAY_MS = 450;
type WindowStatus = "loading" | "ready" | "saving" | "cancelling";

type NoteBackup = {
  draftId: string;
  note: string;
};

type PermissionStatus = {
  draftId: string;
  trusted: boolean;
};

function cleanSourceTitle(
  title: string | null | undefined,
  sourceApp: string | null | undefined,
) {
  const normalizedTitle = title?.trim();
  const normalizedApp = sourceApp?.trim();
  if (!normalizedTitle) return null;
  if (!normalizedApp) return normalizedTitle;

  for (const separator of [" - ", " — ", " – "]) {
    const appSuffixStart = normalizedTitle.lastIndexOf(
      `${separator}${normalizedApp}`,
    );
    if (appSuffixStart > 0) {
      return normalizedTitle.slice(0, appSuffixStart).trim();
    }
  }

  return normalizedTitle;
}

function sourceHostname(url: string | null | undefined) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "Local file";
    return parsed.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function useDiaryTheme() {
  useEffect(() => watchTheme(), []);
}

function readNoteBackup(draftId: string, operation: OperationContext) {
  try {
    const raw = window.localStorage.getItem(NOTE_BACKUP_KEY);
    if (!raw) return null;

    const value = JSON.parse(raw) as Partial<NoteBackup>;
    return value.draftId === draftId && typeof value.note === "string"
      ? value.note
      : null;
  } catch (cause) {
    logEvent("error", "capture.backup", { action: "read", draftId, outcome: "failed", errorCode: errorCode(cause) }, operation);
    return null;
  }
}

let backupWriteFailed = false;

function writeNoteBackup(draftId: string, note: string, operation: OperationContext) {
  try {
    window.localStorage.setItem(
      NOTE_BACKUP_KEY,
      JSON.stringify({ draftId, note } satisfies NoteBackup),
    );
    if (backupWriteFailed) {
      logEvent("info", "capture.backup", { action: "write", draftId, outcome: "recovered" }, operation);
      backupWriteFailed = false;
    }
  } catch (cause) {
    if (!backupWriteFailed) logEvent("error", "capture.backup", { action: "write", draftId, outcome: "failed", errorCode: errorCode(cause) }, operation);
    backupWriteFailed = true;
    // The SQLite draft queue below remains the primary durability path.
  }
}

function clearNoteBackup(draftId: string, operation: OperationContext) {
  try {
    const raw = window.localStorage.getItem(NOTE_BACKUP_KEY);
    if (!raw) return;

    const value = JSON.parse(raw) as Partial<NoteBackup>;
    if (value.draftId === draftId) {
      window.localStorage.removeItem(NOTE_BACKUP_KEY);
    }
  } catch (cause) {
    logEvent("error", "capture.backup", { action: "clear", draftId, outcome: "failed", errorCode: errorCode(cause) }, operation);
    try {
      window.localStorage.removeItem(NOTE_BACKUP_KEY);
    } catch (cleanupCause) {
      logEvent("error", "capture.backup", { action: "clear_retry", draftId, outcome: "failed", errorCode: errorCode(cleanupCause) }, operation);
      throw cleanupCause;
    }
  }
}

export default function CaptureWindow() {
  useDiaryTheme();
  const [shortcuts, setShortcuts] = useState(readAppShortcuts);
  useEffect(() => watchAppShortcuts(setShortcuts), []);

  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<WindowStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [permissionStatus, setPermissionStatus] =
    useState<PermissionStatus | null>(null);
  const draftRef = useRef<CaptureDraft | null>(null);
  const noteRef = useRef("");
  const actionInFlightRef = useRef(false);
  const notePersistTimerRef = useRef<number | null>(null);
  const notePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const statusRef = useRef<WindowStatus>("loading");
  const persistedNoteRef = useRef("");
  const pendingSaveCountRef = useRef(0);
  const lastSaveAtRef = useRef<number | null>(null);
  const draftPersistFailedRef = useRef(false);

  const publishCaptureState = useCallback(() => {
    const currentDraft = draftRef.current;
    updateDiagnosticState("captureFrontend", {
      draftId: currentDraft?.draftId ?? null,
      operationId: currentDraft?.operation.operationId ?? null,
      status: statusRef.current,
      dirty: currentDraft !== null && noteRef.current !== persistedNoteRef.current,
      pendingSaveCount: pendingSaveCountRef.current,
      lastSaveAt: lastSaveAtRef.current,
    });
  }, []);

  useEffect(() => {
    statusRef.current = status;
    publishCaptureState();
  }, [status, publishCaptureState]);

  const clearNotePersistTimer = useCallback(() => {
    if (notePersistTimerRef.current === null) return;

    window.clearTimeout(notePersistTimerRef.current);
    notePersistTimerRef.current = null;
  }, []);

  const acceptDraft = useCallback(
    (incomingDraft: CaptureDraft) => {
      const currentDraft = draftRef.current;
      const sameDraft = currentDraft?.draftId === incomingDraft.draftId;
      const backedUpNote = readNoteBackup(incomingDraft.draftId, incomingDraft.operation);
      const nextDraft = sameDraft
        ? { ...incomingDraft, note: noteRef.current }
        : { ...incomingDraft, note: backedUpNote ?? incomingDraft.note };

      if (!sameDraft) {
        clearNotePersistTimer();
        persistedNoteRef.current = incomingDraft.note;
        lastSaveAtRef.current = null;
        draftPersistFailedRef.current = false;
        noteRef.current = nextDraft.note;
        setNote(nextDraft.note);
      }

      draftRef.current = nextDraft;
      logEvent("info", "capture.draft", {
        action: "accepted", draftId: nextDraft.draftId, sameDraft,
        captureMethod: nextDraft.captureMethod,
        permissionRequired: nextDraft.permissionRequired,
        captureWarningPresent: nextDraft.captureError !== null,
        hasSelection: nextDraft.selectedText.length > 0,
        hasUrl: nextDraft.sourceUrl !== null,
      }, nextDraft.operation);
      if (!sameDraft && backedUpNote !== null) {
        logEvent("info", "capture.backup", { action: "restored", draftId: nextDraft.draftId }, nextDraft.operation);
      }
      publishCaptureState();
      setDraft(nextDraft);
      setStatus((currentStatus) =>
        currentStatus === "saving" || currentStatus === "cancelling"
          ? currentStatus
          : "ready",
      );
      setError(null);
      setDraftWarning(null);
    },
    [clearNotePersistTimer, publishCaptureState],
  );

  const restoreDraft = useCallback(async () => {
    const operation = createOperation();
    const restoredDraft = await getCaptureDraft(operation);
    logEvent("info", "capture.draft", { action: "restore", outcome: "success", present: restoredDraft !== null }, restoredDraft?.operation ?? operation);

    if (restoredDraft) {
      acceptDraft(restoredDraft);
    } else if (!draftRef.current) {
      window.localStorage.removeItem(NOTE_BACKUP_KEY);
      setStatus("ready");
    }
  }, [acceptDraft]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    async function initialize() {
      const stopListening = await listen<CaptureDraft>(
        CAPTURE_DRAFT_READY_EVENT,
        (event) => {
          if (disposed) return;
          logEvent("info", "capture.received", { draftId: event.payload.draftId }, event.payload.operation);
          acceptDraft(event.payload);
        },
      );

      if (disposed) {
        stopListening();
        return;
      }

      unlisten = stopListening;
      logEvent("info", "capture.window", { action: "listener_ready" });
      await restoreDraft();
    }

    void initialize().catch((cause) => {
      logEvent("error", "capture.window", { action: "initialize", outcome: "failed", errorCode: errorCode(cause) });
      if (!disposed && !draftRef.current) {
        setError(errorMessage(cause, "The capture could not be loaded."));
        setStatus("ready");
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [acceptDraft, restoreDraft]);

  useEffect(
    () => () => {
      clearNotePersistTimer();
    },
    [clearNotePersistTimer],
  );

  useEffect(() => {
    if (!draft?.permissionRequired) return;

    const draftId = draft.draftId;
    const operation = draft.operation;
    let disposed = false;
    let checking = false;

    async function refreshPermissionStatus() {
      if (checking) return;
      checking = true;

      try {
        const trusted = await isCaptureAccessibilityTrusted(operation);
        if (disposed) return;

        setPermissionStatus((current) =>
          current?.draftId === draftId && current.trusted === trusted
            ? current
            : { draftId, trusted },
        );
      } catch {
        // Keep the conservative draft snapshot if the live check is unavailable.
      } finally {
        checking = false;
      }
    }

    function refreshWhenFocused() {
      void refreshPermissionStatus();
    }

    void refreshPermissionStatus();
    const refreshInterval = window.setInterval(refreshPermissionStatus, 750);
    window.addEventListener("focus", refreshWhenFocused);

    return () => {
      disposed = true;
      window.clearInterval(refreshInterval);
      window.removeEventListener("focus", refreshWhenFocused);
    };
  }, [draft?.draftId, draft?.permissionRequired, draft?.operation]);

  const queueNotePersist = useCallback((
    draftId: string,
    nextNote: string,
    operation: OperationContext,
  ) => {
    const queuedAt = performance.now();
    pendingSaveCountRef.current += 1;
    publishCaptureState();
    logEvent("debug", "capture.draft", { action: "persist_queued", draftId, pendingSaveCount: pendingSaveCountRef.current }, operation);
    const persist = notePersistQueueRef.current.then(async () => {
      if (draftRef.current?.draftId !== draftId) {
        logEvent("debug", "capture.draft", { action: "persist", draftId, outcome: "skipped", reason: "draft_changed" }, operation);
        return;
      }

      await updateCaptureDraft(draftId, nextNote, operation);
      const recovered = draftRef.current?.draftId === draftId && draftPersistFailedRef.current;
      if (draftRef.current?.draftId === draftId) {
        persistedNoteRef.current = nextNote;
        lastSaveAtRef.current = Date.now();
        draftPersistFailedRef.current = false;
      }
      logEvent(recovered ? "info" : "debug", "capture.draft", {
        action: "persist", draftId,
        outcome: recovered ? "recovered" : "success",
        durationMs: Math.round(performance.now() - queuedAt),
      }, operation);
    });

    const trackedPersist = persist.finally(() => {
      pendingSaveCountRef.current -= 1;
      publishCaptureState();
    });
    notePersistQueueRef.current = trackedPersist.then(() => undefined, () => undefined);

    void trackedPersist
      .then(() => setDraftWarning(null))
      .catch((cause) => {
        logEvent("error", "capture.draft", { action: "persist", draftId, outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - queuedAt) }, operation);
        if (draftRef.current?.draftId === draftId) {
          draftPersistFailedRef.current = true;
          setDraftWarning(
            errorMessage(
              cause,
              "This draft could not be preserved yet. Your text is still here.",
            ),
          );
        }
      });
  }, [publishCaptureState]);

  const persistCurrentNote = useCallback(() => {
    const currentDraft = draftRef.current;
    if (!currentDraft || actionInFlightRef.current) return;

    clearNotePersistTimer();
    queueNotePersist(
      currentDraft.draftId, noteRef.current, currentDraft.operation,
    );
  }, [clearNotePersistTimer, queueNotePersist]);

  useEffect(() => {
    function persistWhenHidden() {
      if (document.visibilityState === "hidden") persistCurrentNote();
    }

    window.addEventListener("blur", persistCurrentNote);
    document.addEventListener("visibilitychange", persistWhenHidden);
    return () => {
      window.removeEventListener("blur", persistCurrentNote);
      document.removeEventListener("visibilitychange", persistWhenHidden);
    };
  }, [persistCurrentNote]);

  function changeNote(nextNote: string) {
    const currentDraft = draftRef.current;
    if (!currentDraft) return;

    noteRef.current = nextNote;
    draftRef.current = { ...currentDraft, note: nextNote };
    setNote(nextNote);
    writeNoteBackup(currentDraft.draftId, nextNote, currentDraft.operation);
    publishCaptureState();
    setError(null);
    clearNotePersistTimer();
    notePersistTimerRef.current = window.setTimeout(() => {
      notePersistTimerRef.current = null;
      queueNotePersist(currentDraft.draftId, nextNote, currentDraft.operation);
    }, NOTE_PERSIST_DELAY_MS);
  }

  const hideAndReset = useCallback(async (completedDraftId: string, operation: OperationContext) => {
    try {
      await getCurrentWindow().hide();
      logEvent("info", "capture.window", { action: "hide", draftId: completedDraftId, outcome: "success" }, operation);
    } catch (cause) {
      logEvent("error", "capture.window", { action: "hide", draftId: completedDraftId, outcome: "failed", errorCode: errorCode(cause) }, operation);
      throw cause;
    }
    clearNotePersistTimer();
    clearNoteBackup(completedDraftId, operation);
    draftRef.current = null;
    noteRef.current = "";
    setDraft(null);
    setNote("");
    setError(null);
    setDraftWarning(null);
    setPermissionStatus(null);
    actionInFlightRef.current = false;
    setStatus("ready");
    publishCaptureState();
  }, [clearNotePersistTimer, publishCaptureState]);

  const submitCapture = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (
      !currentDraft ||
      status !== "ready" ||
      actionInFlightRef.current
    ) {
      return;
    }

    actionInFlightRef.current = true;
    const noteToSave = noteRef.current;
    clearNotePersistTimer();
    setStatus("saving");
    setError(null);
    const started = performance.now();
    let committed = false;
    pendingSaveCountRef.current += 1;
    publishCaptureState();
    logEvent("info", "capture.save.started", { draftId: currentDraft.draftId, pendingSaveCount: pendingSaveCountRef.current }, currentDraft.operation);

    try {
      await notePersistQueueRef.current;
      await saveCapture(
        currentDraft.draftId, noteToSave, currentDraft.operation,
      );
      committed = true;
      persistedNoteRef.current = noteToSave;
      lastSaveAtRef.current = Date.now();
      logEvent("info", "capture.save.finished", { draftId: currentDraft.draftId, outcome: "committed", durationMs: Math.round(performance.now() - started) }, currentDraft.operation);
      await hideAndReset(currentDraft.draftId, currentDraft.operation);
    } catch (cause) {
      if (!committed) {
        logEvent("error", "capture.save.finished", { draftId: currentDraft.draftId, outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - started) }, currentDraft.operation);
      }
      actionInFlightRef.current = false;
      setError(errorMessage(cause, "The capture could not be saved."));
      setStatus("ready");
    } finally {
      pendingSaveCountRef.current -= 1;
      publishCaptureState();
    }
  }, [clearNotePersistTimer, hideAndReset, publishCaptureState, status]);

  const discardCapture = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (status !== "ready" || actionInFlightRef.current) {
      return;
    }

    if (!currentDraft) {
      const operation = createOperation();
      try {
        await getCurrentWindow().hide();
        logEvent("info", "capture.window", { action: "hide_empty", outcome: "success" }, operation);
      } catch (cause) {
        logEvent("error", "capture.window", { action: "hide_empty", outcome: "failed", errorCode: errorCode(cause) }, operation);
        throw cause;
      }
      return;
    }

    actionInFlightRef.current = true;
    clearNotePersistTimer();
    setStatus("cancelling");
    setError(null);
    const started = performance.now();
    let discarded = false;
    logEvent("info", "capture.draft", { action: "discard", draftId: currentDraft.draftId, outcome: "started" }, currentDraft.operation);

    try {
      await notePersistQueueRef.current;
      await cancelCapture(currentDraft.draftId, currentDraft.operation);
      discarded = true;
      logEvent("info", "capture.draft", { action: "discard", draftId: currentDraft.draftId, outcome: "success", durationMs: Math.round(performance.now() - started) }, currentDraft.operation);
      await hideAndReset(currentDraft.draftId, currentDraft.operation);
    } catch (cause) {
      if (!discarded) logEvent("error", "capture.draft", { action: "discard", draftId: currentDraft.draftId, outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - started) }, currentDraft.operation);
      actionInFlightRef.current = false;
      setError(errorMessage(cause, "The capture could not be cancelled."));
      setStatus("ready");
    }
  }, [clearNotePersistTimer, hideAndReset, status]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen(CAPTURE_CLOSE_REQUESTED_EVENT, () => {
      logEvent("debug", "capture.window", { action: "close_requested" }, draftRef.current?.operation);
      if (!disposed) void discardCapture();
    })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((cause) => {
        logEvent("error", "capture.window", { action: "close_listener", outcome: "failed", errorCode: errorCode(cause) });
        if (!disposed) {
          setError(
            errorMessage(
              cause,
              "The window close control is unavailable; use Cancel instead.",
            ),
          );
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [discardCapture]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (isShortcutRecording(event.target) || event.isComposing || event.repeat) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void discardCapture();
        return;
      }

      if (matchesShortcut(event, shortcuts.saveCapture)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void submitCapture();
      }
    }

    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [discardCapture, submitCapture, shortcuts.saveCapture]);

  async function openPermissionSettings() {
    if (openingSettings) return;

    setOpeningSettings(true);
    setError(null);

    try {
      await openAccessibilitySettings(draftRef.current?.operation ?? createOperation());
    } catch (cause) {
      setError(
        errorMessage(cause, "Accessibility settings could not be opened."),
      );
    } finally {
      setOpeningSettings(false);
    }
  }

  async function openSource(url: string) {
    setError(null);

    try {
      await openCaptureSource(url, draftRef.current?.operation ?? createOperation());
    } catch (cause) {
      setError(errorMessage(cause, "The capture source could not be opened."));
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCapture();
  }

  const busy = status === "saving" || status === "cancelling";
  const accessibilityTrusted =
    draft?.permissionRequired === true &&
    permissionStatus?.draftId === draft.draftId &&
    permissionStatus.trusted;
  const permissionStillRequired =
    draft?.permissionRequired === true && !accessibilityTrusted;
  const showCaptureNotice =
    permissionStillRequired ||
    (draft?.permissionRequired === false &&
      Boolean(draft.captureError));
  const sourceLabel =
    cleanSourceTitle(draft?.sourceTitle, draft?.sourceApp) ||
    draft?.sourceApp?.trim() ||
    null;
  const sourceHost = sourceHostname(draft?.sourceUrl);
  const sourceSummary =
    sourceLabel &&
    sourceHost &&
    sourceLabel.toLowerCase() !== sourceHost.toLowerCase()
      ? `${sourceLabel} · ${sourceHost}`
      : sourceLabel || sourceHost || draft?.sourceUrl || null;

  return (
    <main className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {/* Keep the border inside the native window's corners, independent of theme radii. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-px z-50 rounded-[16px] border border-foreground/20"
      />
      <header
        data-tauri-drag-region
        className="h-10 shrink-0 select-none"
      >
        <h1
          id="capture-window-title"
          data-tauri-drag-region
          className="sr-only"
        >
          Capture
        </h1>
      </header>

      {status === "loading" ? (
        <div
          role="status"
          className="grid min-h-0 flex-1 place-items-center px-6 text-sm text-muted-foreground"
        >
          Loading capture…
        </div>
      ) : !draft ? (
        <div className="grid min-h-0 flex-1 place-items-center px-8 text-center text-sm text-muted-foreground">
          <div>
            <p>{error || "Waiting for a capture…"}</p>
            {error ? (
              <button
                type="button"
                onClick={() => {
                  setStatus("loading");
                  setError(null);
                  void restoreDraft().catch((cause) => {
                    setError(
                      errorMessage(cause, "The capture could not be loaded."),
                    );
                    setStatus("ready");
                  });
                }}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
              >
                Try again
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <form
          aria-labelledby="capture-window-title"
          aria-busy={busy}
          onSubmit={submitForm}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="diary-entry-scroll min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-4">
            {showCaptureNotice ? (
              <div className="mb-4 flex items-center gap-2.5 rounded-2xl bg-primary/[0.08] p-2 text-xs text-foreground shadow-sm">
                {permissionStillRequired ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 pl-1 font-heading text-[50px] leading-none text-foreground select-none"
                  >
                    !
                  </span>
                ) : null}
                <p className="min-w-0 flex-1 py-0.5 pr-1">
                  {permissionStillRequired ? (
                    <>
                      <span>
                        Accessibility access is required to capture selected
                        text and page details. You can still save this note
                        without it.{" "}
                      </span>
                      <button
                        type="button"
                        disabled={openingSettings}
                        onClick={() => void openPermissionSettings()}
                        className="font-medium text-foreground underline decoration-foreground/25 underline-offset-4 transition-colors hover:decoration-foreground/60 disabled:opacity-50"
                      >
                        {openingSettings
                          ? "Opening settings…"
                          : "Open Accessibility Settings"}
                      </button>
                <span>. Once enabled, cancel and use your capture shortcut again.</span>
                    </>
                  ) : (
                    draft.captureError
                  )}
                </p>
              </div>
            ) : null}

            {draft.selectedText ? (
              <section
                aria-label="Captured text"
                className="diary-entry-scroll max-h-[6.65rem] overflow-y-auto pr-1"
              >
                <blockquote className="whitespace-pre-wrap font-heading text-lg font-medium leading-[1.45] tracking-[-0.005em]">
                  <span aria-hidden="true">&quot;</span>
                  {draft.selectedText}
                  <span aria-hidden="true">&quot;</span>
                </blockquote>
              </section>
            ) : null}

            {sourceSummary ? (
              <section
                aria-label="Source"
                className="diary-supporting-text mt-3 min-w-0 truncate text-muted-foreground"
              >
                {draft.sourceUrl ? (
                  <button
                    type="button"
                    title={draft.sourceUrl}
                    aria-label={`Open source: ${sourceSummary}`}
                    onClick={() => void openSource(draft.sourceUrl!)}
                    className="inline-flex max-w-full items-center gap-2 rounded-sm text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Link2
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-foreground/45"
                      strokeWidth={1.75}
                    />
                    <span className="truncate">{sourceSummary}</span>
                  </button>
                ) : (
                  <p className="truncate">{sourceSummary}</p>
                )}
              </section>
            ) : null}

            <div className="mt-4">
              <textarea
                aria-label="Your thought"
                autoFocus
                value={note}
                disabled={busy}
                onChange={(event) => changeNote(event.currentTarget.value)}
                onBlur={persistCurrentNote}
                placeholder="Write what came to mind…"
                spellCheck
                className="block min-h-[112px] w-full resize-none rounded-xl border border-border/70 bg-transparent px-4 py-3 text-[15px] leading-6 outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-foreground/25 disabled:opacity-70"
              />
            </div>

            {draftWarning || error ? (
              <div className="mt-2 space-y-1">
                {draftWarning ? (
                  <p
                    role="status"
                    className="text-xs text-amber-700 dark:text-amber-300"
                  >
                    {draftWarning}
                  </p>
                ) : null}
                {error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <footer className="flex shrink-0 items-center justify-between px-6 pt-3 pb-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void discardCapture()}
              className="h-8 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50"
            >
              {status === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              <span>{status === "saving" ? "Saving…" : "Save"}</span>
              {status !== "saving" ? (
                <kbd className="font-sans text-[10px] opacity-55">{formatShortcut(shortcuts.saveCapture)}</kbd>
              ) : null}
            </button>
          </footer>
        </form>
      )}
    </main>
  );
}
