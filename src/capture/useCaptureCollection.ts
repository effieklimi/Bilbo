import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { errorMessage } from "../errors";
import { createOperation } from "../diagnostics/operation";
import { errorCode, logEvent, updateDiagnosticState } from "../diagnostics/logger";
import { CAPTURE_SHORTCUT_CHANGED_EVENT, getCaptureShortcutStatus, listCaptures } from "./api";
import type { CaptureShortcutStatus, SavedCapture } from "./types";

export function useCaptureCollection(referenceIndexRevision: number) {
  const requestRef = useRef(0);
  const shortcutRevisionRef = useRef(0);
  const loadFailedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const [captures, setCaptures] = useState<SavedCapture[]>([]);
  const [shortcutStatus, setShortcutStatus] =
    useState<CaptureShortcutStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (showLoading = false) => {
    const operation = createOperation();
    const started = performance.now();
    const request = ++requestRef.current;
    const shortcutRevision = shortcutRevisionRef.current;
    if (showLoading) setLoading(true);
    setError(null);
    logEvent("debug", "capture.archive", { action: "reload", outcome: "started", loading: showLoading }, operation);

    try {
      const [records, status] = await Promise.all([
        listCaptures(operation),
        getCaptureShortcutStatus(operation),
      ]);
      if (requestRef.current !== request) {
        logEvent("debug", "capture.archive", { action: "reload", outcome: "superseded", durationMs: Math.round(performance.now() - started) }, operation);
        return false;
      }

      setCaptures(records);
      if (shortcutRevision === shortcutRevisionRef.current) setShortcutStatus(status);
      setReady(true);
      setError(null);
      logEvent(loadFailedRef.current || !hasLoadedRef.current ? "info" : "debug", "capture.archive", { action: "reload", outcome: loadFailedRef.current ? "recovered" : "success", count: records.length, durationMs: Math.round(performance.now() - started) }, operation);
      loadFailedRef.current = false;
      hasLoadedRef.current = true;
      return true;
    } catch (cause) {
      logEvent("error", "capture.archive", { action: "reload", outcome: "failed", reason: requestRef.current !== request ? "superseded" : "current_request", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - started) }, operation);
      if (requestRef.current !== request) return false;
      loadFailedRef.current = true;

      setError(errorMessage(cause, "Captures could not be loaded."));
      return false;
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<CaptureShortcutStatus>(CAPTURE_SHORTCUT_CHANGED_EVENT, ({ payload }) => {
      if (disposed) return;
      shortcutRevisionRef.current += 1;
      setShortcutStatus(payload);
    }).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else unlisten = unsubscribe;
    }).catch((cause) => {
      logEvent("error", "capture.archive", { action: "shortcut_listener", outcome: "failed", errorCode: errorCode(cause) });
      if (!disposed) setError(errorMessage(cause, "Could not watch the capture shortcut."));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void reload();

    function refreshAfterFocus() {
      void reload();
    }

    window.addEventListener("focus", refreshAfterFocus);
    return () => {
      requestRef.current += 1;
      window.removeEventListener("focus", refreshAfterFocus);
    };
  }, [referenceIndexRevision, reload]);

  useEffect(() => {
    updateDiagnosticState("captureArchive", { count: captures.length, loading, ready, hasError: error !== null, shortcutAvailable: shortcutStatus?.available ?? null });
  }, [captures.length, loading, ready, error, shortcutStatus?.available]);

  const update = useCallback((updated: SavedCapture) => {
    requestRef.current += 1;
    setCaptures((current) =>
      current.map((capture) =>
        capture.captureId === updated.captureId ? updated : capture,
      ),
    );
    setReady(true);
    setLoading(false);
    setError(null);
  }, []);

  const remove = useCallback((captureId: string) => {
    requestRef.current += 1;
    setCaptures((current) =>
      current.filter((capture) => capture.captureId !== captureId),
    );
    setReady(true);
    setLoading(false);
    setError(null);
  }, []);

  return {
    captures,
    shortcutStatus,
    loading,
    ready,
    error,
    reload,
    update,
    remove,
  };
}
