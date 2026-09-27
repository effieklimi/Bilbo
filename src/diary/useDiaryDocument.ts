import {
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { writeTextFile } from "@tauri-apps/plugin-fs";

import type { CaptureReferenceWorkspace } from "../capture/referenceIndex";
import { errorMessage } from "../errors";
import { errorCode, logEvent, privateAlias, updateDiagnosticState } from "../diagnostics/logger";
import { createOperation, type OperationContext } from "../diagnostics/operation";
import type { MarkdownFile } from "./files";

const AUTOSAVE_DELAY_MS = 750;

type SaveRequest = {
  path: string;
  snapshot: string;
  diaryDate: string | null;
  referenceWorkspace: CaptureReferenceWorkspace | null;
  pending: boolean;
  promise: Promise<boolean>;
  operation: OperationContext;
};

type UseDiaryDocumentOptions = {
  referenceWorkspaceRef: MutableRefObject<CaptureReferenceWorkspace | null>;
  setError: (value: SetStateAction<string | null>) => void;
  onPathSaved: (path: string) => void;
  onReferencesSaved: () => void;
  onReferenceError: (cause: unknown) => void;
};

export function useDiaryDocument({
  referenceWorkspaceRef,
  setError,
  onPathSaved,
  onReferencesSaved,
  onReferenceError,
}: UseDiaryDocumentOptions) {
  const [selectedFile, setSelectedFile] = useState<MarkdownFile | null>(null);
  const [content, setContent] = useState("");
  const selectedFileRef = useRef<MarkdownFile | null>(null);
  const contentRef = useRef("");
  const savedContentRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCountRef = useRef(0);
  const lastSaveRequestRef = useRef<SaveRequest | null>(null);
  const lastSaveAtRef = useRef<number | null>(null);
  const lastPublishedStateRef = useRef<string | null>(null);
  const saveCurrentSnapshotRef = useRef<(trigger?: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );

  const publishState = useCallback(() => {
    const state = {
      noteId: selectedFileRef.current ? privateAlias("note", selectedFileRef.current.path) : null,
      dirty: contentRef.current !== savedContentRef.current,
      pendingSaveCount: pendingSaveCountRef.current,
      lastSaveAt: lastSaveAtRef.current,
    };
    const signature = JSON.stringify(state);
    if (signature === lastPublishedStateRef.current) return;
    lastPublishedStateRef.current = signature;
    updateDiagnosticState("diary", state);
  }, []);
  useEffect(publishState, [publishState]);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current === null) return;

    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  const scheduleAutosave = useCallback(() => {
    clearSaveTimer();
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveCurrentSnapshotRef.current("autosave");
    }, AUTOSAVE_DELAY_MS);
  }, [clearSaveTimer]);

  const enqueueSave = useCallback(
    (file: MarkdownFile, snapshot: string, trigger: string) => {
      const path = file.path;
      const diaryDate = file.diaryDate?.dateKey ?? null;
      const referenceWorkspace = referenceWorkspaceRef.current;
      const lastRequest = lastSaveRequestRef.current;

      if (
        lastRequest?.pending &&
        lastRequest.path === path &&
        lastRequest.snapshot === snapshot &&
        lastRequest.diaryDate === diaryDate &&
        lastRequest.referenceWorkspace === referenceWorkspace
      ) {
        logEvent("debug", "note.save.started", { phase: "reused", trigger, pendingSaveCount: pendingSaveCountRef.current }, lastRequest.operation);
        return lastRequest.promise;
      }

      const operation = createOperation();
      const queuedAt = performance.now();
      const noteId = privateAlias("note", path);
      setError(null);
      pendingSaveCountRef.current += 1;
      publishState();
      logEvent("debug", "note.save.started", { phase: "queued", trigger, noteId, pendingSaveCount: pendingSaveCountRef.current }, operation);

      const request: SaveRequest = {
        path,
        snapshot,
        diaryDate,
        referenceWorkspace,
        pending: true,
        promise: Promise.resolve(false),
        operation,
      };

      const task = saveQueueRef.current.then(async () => {
        const startedAt = performance.now();
        let markdownSaved = false;
        logEvent("debug", "note.save.started", { phase: "write", trigger, noteId, queueWaitMs: Math.round(startedAt - queuedAt) }, operation);
        try {
          await writeTextFile(path, snapshot);
          markdownSaved = true;
          lastSaveAtRef.current = Date.now();
          logEvent("info", "note.save.finished", { outcome: "success", stage: "markdown", noteId, trigger, durationMs: Math.round(performance.now() - startedAt) }, operation);
          onPathSaved(path);

          if (selectedFileRef.current?.path === path) {
            savedContentRef.current = snapshot;

            const latestRequest = lastSaveRequestRef.current;
            const latestContent = contentRef.current;
            const latestContentAlreadyQueued =
              latestRequest?.pending &&
              latestRequest.path === path &&
              latestRequest.snapshot === latestContent;

            if (
              latestContent !== snapshot &&
              saveTimerRef.current === null &&
              !latestContentAlreadyQueued
            ) {
              scheduleAutosave();
            }
          }

          publishState();
          if (diaryDate && referenceWorkspace) {
            try {
              await referenceWorkspace.savedSnapshot(
                path,
                diaryDate,
                snapshot,
                operation,
              );
              if (referenceWorkspaceRef.current === referenceWorkspace) {
                onReferencesSaved();
              }
            } catch (cause) {
              onReferenceError(cause);
            }
          }

          return true;
        } catch (cause) {
          logEvent("error", "note.save.finished", { outcome: "failed", stage: markdownSaved ? "after_write" : "markdown", markdownSaved, noteId, trigger, errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
          setError(errorMessage(cause, "The diary entry could not be saved."));
          return false;
        } finally {
          request.pending = false;
          pendingSaveCountRef.current -= 1;
          publishState();
        }
      });

      request.promise = task;
      lastSaveRequestRef.current = request;
      saveQueueRef.current = task.then(
        () => undefined,
        () => undefined,
      );

      return task;
    },
    [
      onPathSaved,
      onReferenceError,
      onReferencesSaved,
      referenceWorkspaceRef,
      scheduleAutosave,
      setError,
      publishState,
    ],
  );

  const saveCurrentSnapshot = useCallback((trigger = "flush") => {
    const file = selectedFileRef.current;
    if (!file) return Promise.resolve(true);

    const snapshot = contentRef.current;
    if (
      snapshot === savedContentRef.current &&
      pendingSaveCountRef.current === 0
    ) {
      return Promise.resolve(true);
    }

    return enqueueSave(file, snapshot, trigger);
  }, [enqueueSave]);
  saveCurrentSnapshotRef.current = saveCurrentSnapshot;

  const flushPendingSave = useCallback(async (action = "flush") => {
    clearSaveTimer();

    while (selectedFileRef.current) {
      const saving = saveCurrentSnapshotRef.current(action);
      const saveOperation = lastSaveRequestRef.current?.operation;
      const saved = await saving;
      if (!saved) {
        // Blur has already happened; only callers that await the result gate
        // navigation or closing on a successful flush.
        if (action !== "blur" && action !== "flush") {
          logEvent("warn", "note.action_blocked", { action, reason: "save_failed", pendingSaveCount: pendingSaveCountRef.current }, saveOperation);
        }
        return false;
      }

      if (
        contentRef.current === savedContentRef.current &&
        pendingSaveCountRef.current === 0
      ) {
        return true;
      }

      clearSaveTimer();
    }

    return true;
  }, [clearSaveTimer]);

  const load = useCallback(
    (file: MarkdownFile | null, body = "") => {
      clearSaveTimer();
      selectedFileRef.current = file;
      contentRef.current = body;
      savedContentRef.current = body;
      setSelectedFile(file);
      setContent(body);
      publishState();
    },
    [clearSaveTimer, publishState],
  );

  const updateSelectedFile = useCallback((file: MarkdownFile) => {
    if (selectedFileRef.current?.path !== file.path) return;
    selectedFileRef.current = file;
    setSelectedFile(file);
  }, []);

  const changeEditorContent = useCallback(
    (nextContent: string, initialMarkdownNormalize: boolean) => {
      contentRef.current = nextContent;
      setContent(nextContent);

      if (initialMarkdownNormalize) {
        savedContentRef.current = nextContent;
        publishState();
        return;
      }

      publishState();
      scheduleAutosave();
    },
    [publishState, scheduleAutosave],
  );

  const hasPendingSave = useCallback(
    () =>
      saveTimerRef.current !== null ||
      pendingSaveCountRef.current > 0 ||
      contentRef.current !== savedContentRef.current,
    [],
  );

  return {
    selectedFile,
    content,
    selectedFileRef,
    contentRef,
    load,
    updateSelectedFile,
    clearSaveTimer,
    flushPendingSave,
    changeEditorContent,
    hasPendingSave,
  };
}
