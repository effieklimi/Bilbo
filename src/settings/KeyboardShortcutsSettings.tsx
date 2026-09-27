import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  CAPTURE_SHORTCUT_CHANGED_EVENT,
  getCaptureShortcutStatus,
  setCaptureShortcut,
  setCaptureShortcutRecording as recordingMode,
} from "../capture/api";
import {
  DEFAULT_CAPTURE_SHORTCUT,
  shortcutFromKeyboardEvent as captureShortcutFromEvent,
} from "../capture/shortcut";
import type { CaptureShortcutStatus } from "../capture/types";
import { createOperation, type OperationContext } from "../diagnostics/operation";
import { errorCode, logEvent, updateDiagnosticState } from "../diagnostics/logger";
import { errorMessage } from "../errors";
import {
  appShortcutDefinitions,
  formatShortcut,
  readAppShortcuts,
  setShortcutRecording,
  shortcutFromKeyboardEvent,
  validateGlobalCaptureShortcut,
  validateShortcut,
  watchAppShortcuts,
  writeAppShortcuts,
  type AppShortcutId,
} from "../shortcuts";

type ShortcutId = "capture" | AppShortcutId;
type RecorderPhase = "idle" | "starting" | "recording" | "saving";
type ShortcutError = { id: ShortcutId; message: string };

const rows = [{ id: "capture" as const, label: "Capture" }, ...appShortcutDefinitions];
const actionClassName = "diary-supporting-text rounded-lg px-3 py-1.5 text-foreground/75 transition-colors enabled:hover:bg-primary/[0.06] enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50";

export default function KeyboardShortcutsSettings() {
  const native = isTauri();
  const [shortcuts, setShortcuts] = useState(readAppShortcuts);
  const [captureStatus, setCaptureStatus] = useState<CaptureShortcutStatus | null>(null);
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [error, setError] = useState<ShortcutError | null>(null);
  const mountedRef = useRef(false);
  const phaseRef = useRef<RecorderPhase>("idle");
  const recordingIdRef = useRef<ShortcutId | null>(null);
  const sessionRef = useRef(0);
  const pendingShortcutRef = useRef<ReturnType<typeof shortcutFromKeyboardEvent>>(null);
  const captureRevisionRef = useRef(0);
  const operationRef = useRef<OperationContext | null>(null);

  useEffect(() => watchAppShortcuts(setShortcuts), []);

  const changePhase = useCallback((next: RecorderPhase) => {
    phaseRef.current = next;
    if (!mountedRef.current) return;
    setPhase(next);
    setShortcutRecording(next !== "idle");
    if (next === "idle") {
      recordingIdRef.current = null;
      setRecordingId(null);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (phaseRef.current === "idle") return;
    sessionRef.current += 1;
    pendingShortcutRef.current = null;
    setShortcutRecording(false);
    const id = recordingIdRef.current ?? "capture";
    if (mountedRef.current && phaseRef.current === "recording") setError(null);
    if (phaseRef.current !== "saving") changePhase("idle");
    if (!native) return;
    void recordingMode(false, operationRef.current ?? createOperation()).catch((cause) => {
      if (mountedRef.current) {
        setError({ id, message: errorMessage(cause, "Could not resume the capture shortcut.") });
      }
    });
  }, [changePhase, native]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    if (native) {
      void listen<CaptureShortcutStatus>(CAPTURE_SHORTCUT_CHANGED_EVENT, ({ payload }) => {
        if (!disposed) {
          captureRevisionRef.current += 1;
          setCaptureStatus(payload);
        }
      }).then((unsubscribe) => {
        if (disposed) unsubscribe();
        else unlisten = unsubscribe;
      }).catch((cause) => {
        logEvent("error", "settings.change", { setting: "capture_shortcut", action: "listen", outcome: "failed", errorCode: errorCode(cause) });
        if (!disposed) setError({ id: "capture", message: errorMessage(cause, "Could not watch the capture shortcut.") });
      });
      const revision = captureRevisionRef.current;
      void getCaptureShortcutStatus().then((status) => {
        if (!disposed && revision === captureRevisionRef.current) setCaptureStatus(status);
      }).catch((cause) => {
        logEvent("error", "settings.change", { setting: "capture_shortcut", action: "read", outcome: "failed", errorCode: errorCode(cause) });
        if (!disposed) setError({ id: "capture", message: errorMessage(cause, "Could not load the capture shortcut.") });
      });
    }
    window.addEventListener("blur", stopRecording);
    return () => {
      disposed = true;
      mountedRef.current = false;
      window.removeEventListener("blur", stopRecording);
      unlisten?.();
      stopRecording();
    };
  }, [native, stopRecording]);

  useEffect(() => {
    updateDiagnosticState("keyboardShortcuts", {
      phase, shortcutAvailable: captureStatus?.available ?? null,
      hasShortcutError: error !== null || captureStatus?.error != null,
    });
  }, [phase, captureStatus, error]);

  async function startRecording(id: ShortcutId) {
    if (phaseRef.current !== "idle" || (id === "capture" && !native)) return;
    const session = ++sessionRef.current;
    pendingShortcutRef.current = null;
    const operation = createOperation();
    operationRef.current = operation;
    recordingIdRef.current = id;
    setRecordingId(id);
    setError(null);
    changePhase("starting");
    try {
      let currentCaptureShortcut = captureStatus?.shortcut ?? DEFAULT_CAPTURE_SHORTCUT;
      if (native) {
        // Pause global capture even when recording a local shortcut, so the
        // existing capture chord can be checked without opening its window.
        await recordingMode(true, operation);
        const status = await getCaptureShortcutStatus(operation);
        currentCaptureShortcut = status.shortcut;
        if (mountedRef.current && session === sessionRef.current) setCaptureStatus(status);
      }
      if (mountedRef.current && session === sessionRef.current) {
        changePhase("recording");
        const pending = pendingShortcutRef.current;
        pendingShortcutRef.current = null;
        if (pending) await applyShortcut(pending, id, currentCaptureShortcut);
      }
    } catch (cause) {
      if (mountedRef.current && session === sessionRef.current) {
        setError({ id, message: errorMessage(cause, "Could not start changing this shortcut.") });
        stopRecording();
      }
    }
  }

  async function recordShortcut(event: KeyboardEvent<HTMLButtonElement>, id: ShortcutId) {
    if (phaseRef.current === "idle" || recordingIdRef.current !== id) return;
    if (event.key === "Tab") {
      stopRecording();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    if (phaseRef.current === "saving") return;

    const result = id === "capture"
      ? captureShortcutFromEvent(event.nativeEvent)
      : shortcutFromKeyboardEvent(event.nativeEvent);
    if (!result) return;
    if (phaseRef.current === "starting") {
      // The prompt is already visible; remember the first chord while global
      // capture is being paused, then validate it against the fresh status.
      pendingShortcutRef.current ??= result;
      return;
    }
    await applyShortcut(result, id, captureStatus?.shortcut ?? DEFAULT_CAPTURE_SHORTCUT);
  }

  async function applyShortcut(
    result: NonNullable<ReturnType<typeof shortcutFromKeyboardEvent>>,
    id: ShortcutId,
    currentCaptureShortcut: string,
  ) {
    const preferences = readAppShortcuts();
    const validationError = "error" in result ? result.error : id === "capture"
      ? validateGlobalCaptureShortcut(result.shortcut, preferences)
      : validateShortcut(result.shortcut, id, preferences, currentCaptureShortcut);
    if (validationError || "error" in result) {
      setError({ id, message: validationError ?? "Choose another shortcut." });
      logEvent("warn", "settings.change", { setting: id, action: "validate_shortcut", outcome: "rejected" }, operationRef.current ?? undefined);
      return;
    }

    changePhase("saving");
    setError(null);
    const operation = operationRef.current ?? createOperation();
    try {
      if (id === "capture") {
        captureRevisionRef.current += 1;
        const status = await setCaptureShortcut(result.shortcut, operation);
        if (mountedRef.current) setCaptureStatus(status);
      } else {
        writeAppShortcuts({ ...preferences, [id]: result.shortcut });
        logEvent("info", "settings.change", { setting: id, action: "shortcut_changed", shortcut: result.shortcut, outcome: "success" }, operation);
      }
    } catch (cause) {
      logEvent("error", "settings.change", { setting: id, action: "shortcut_changed", outcome: "failed", errorCode: errorCode(cause) }, operation);
      if (mountedRef.current) setError({ id, message: errorMessage(cause, "Could not save this shortcut. Choose another.") });
    } finally {
      // A departed recorder already queued its release. Do not let a stale
      // save completion stop a newly mounted recorder.
      if (mountedRef.current) {
        if (native) {
          try {
            await recordingMode(false, operation);
          } catch (cause) {
            if (mountedRef.current) setError({ id, message: errorMessage(cause, "Could not resume the capture shortcut.") });
          }
        }
        changePhase("idle");
      }
    }
  }

  return (
    <section aria-labelledby="keyboard-shortcuts-heading" className="mt-8">
      <h3 id="keyboard-shortcuts-heading" className="diary-section-title text-foreground/65">
        Keyboard shortcuts
      </h3>
      <div className="mt-3">
        {rows.map(({ id, label }) => {
          const active = recordingId === id;
          const message = error?.id === id ? error.message : id === "capture" ? captureStatus?.error : null;
          const shortcut = id === "capture" ? captureStatus?.shortcut : shortcuts[id];
          return (
            <div key={id}>
              <div className="flex min-h-11 items-center justify-between gap-4">
                <span className="diary-supporting-text text-foreground/75">{label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  {active && (phase === "recording" || phase === "starting") ? (
                    <button type="button" onClick={stopRecording} className={actionClassName}>Cancel</button>
                  ) : null}
                  <button
                    type="button"
                    disabled={(id === "capture" && !native) || (phase !== "idle" && !active)}
                    aria-label={active && (phase === "starting" || phase === "recording") ? `Press a shortcut for ${label}` : `Change ${label.toLowerCase()} shortcut`}
                    aria-description={shortcut ? `Current shortcut: ${formatShortcut(shortcut)}` : undefined}
                    aria-describedby={message ? `keyboard-shortcut-error-${id}` : undefined}
                    aria-busy={active && (phase === "starting" || phase === "saving")}
                    data-shortcut-recorder={active && phase !== "idle" ? "true" : undefined}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      void startRecording(id);
                    }}
                    onKeyDown={(event) => { void recordShortcut(event, id); }}
                    onBlur={stopRecording}
                    className={`${actionClassName} min-w-16 bg-primary/[0.06]`}
                  >
                    {active && phase !== "idle"
                      ? phase === "saving" ? "Saving…" : "Press shortcut…"
                      : <kbd className="font-sans tracking-wide">{shortcut ? formatShortcut(shortcut) : native ? "…" : "Unavailable"}</kbd>}
                  </button>
                </div>
              </div>
              {message ? <p id={`keyboard-shortcut-error-${id}`} role="alert" className="mt-1 mb-2 text-xs text-destructive">{message}</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
