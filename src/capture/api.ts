import { errorCode, logEvent, updateDiagnosticState } from "../diagnostics/logger";
import {
  createOperation,
  invokeWithOperation,
  type OperationContext,
} from "../diagnostics/operation";
import type {
  CaptureDraft,
  CaptureReferenceIndexEntry,
  CaptureShortcutStatus,
  SavedCapture,
} from "./types";

export const CAPTURE_DRAFT_READY_EVENT = "capture-draft-ready";
export const CAPTURE_CLOSE_REQUESTED_EVENT = "capture-close-requested";
export const CAPTURE_SHORTCUT_CHANGED_EVENT = "capture-shortcut-changed";

type CapturePermissionStatus = {
  accessibilityTrusted: boolean;
};

function newestFirst(captures: SavedCapture[]) {
  return captures.sort(
    (left, right) =>
      (right.savedAt || right.createdAt) -
      (left.savedAt || left.createdAt),
  );
}

export function getCaptureDraft(operation = createOperation()) {
  return invokeWithOperation<CaptureDraft | null>("get_capture_draft", {}, operation);
}

export function updateCaptureDraft(
  draftId: string,
  note: string,
  operation: OperationContext,
) {
  return invokeWithOperation<CaptureDraft>(
    "update_capture_draft", { draftId, note }, operation,
  );
}

export function saveCapture(
  draftId: string,
  note: string,
  operation: OperationContext,
) {
  return invokeWithOperation<SavedCapture>(
    "save_capture", { draftId, note }, operation,
  );
}

export function cancelCapture(draftId: string, operation: OperationContext) {
  return invokeWithOperation<void>("cancel_capture", { draftId }, operation);
}

let lastPermission: boolean | "unavailable" | undefined;
let lastPermissionError: string | undefined;

export async function isCaptureAccessibilityTrusted(operation = createOperation()) {
  const started = performance.now();
  try {
    const status = await invokeWithOperation<CapturePermissionStatus>(
      "get_capture_permission_status", {}, operation,
    );
    const trusted = status.accessibilityTrusted;
    if (lastPermission !== trusted) {
      logEvent("info", lastPermission === undefined ? "permission.checked" : "permission.changed", {
        setting: "accessibility", trusted, outcome: lastPermission === "unavailable" ? "recovered" : "success",
        durationMs: Math.round(performance.now() - started),
      }, operation);
    }
    lastPermission = trusted;
    lastPermissionError = undefined;
    updateDiagnosticState("capturePermission", { accessibilityTrusted: trusted, checkedAt: Date.now(), status: "available" });
    return trusted;
  } catch (cause) {
    const code = errorCode(cause);
    if (lastPermission !== "unavailable" || lastPermissionError !== code) {
      logEvent("error", "permission.checked", {
        setting: "accessibility", outcome: "failed", errorCode: code,
        durationMs: Math.round(performance.now() - started),
      }, operation);
    }
    lastPermission = "unavailable";
    lastPermissionError = code;
    updateDiagnosticState("capturePermission", { accessibilityTrusted: null, checkedAt: Date.now(), status: "unavailable" });
    throw cause;
  }
}

async function loggedCommand<T>(
  command: string,
  args: Record<string, unknown>,
  operation: OperationContext,
  event: string,
  fields: Record<string, unknown>,
): Promise<T> {
  const started = performance.now();
  logEvent("debug", event, { ...fields, outcome: "started" }, operation);
  try {
    const result = await invokeWithOperation<T>(command, args, operation);
    logEvent("info", event, { ...fields, outcome: "success", durationMs: Math.round(performance.now() - started) }, operation);
    return result;
  } catch (cause) {
    logEvent("error", event, { ...fields, outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - started) }, operation);
    throw cause;
  }
}

export function openAccessibilitySettings(operation = createOperation()) {
  return loggedCommand<void>("open_accessibility_settings", {}, operation, "external.open", { destinationKind: "accessibility_settings" });
}

export function openCaptureSource(url: string, operation = createOperation()) {
  return loggedCommand<void>("open_capture_source", { url }, operation, "external.open", { destinationKind: "capture_source" });
}

export async function listCaptures(operation = createOperation()) {
  return newestFirst(await invokeWithOperation<SavedCapture[]>("list_captures", {}, operation));
}

export function updateCaptureNote(captureId: string, note: string, operation = createOperation()) {
  return loggedCommand<SavedCapture>("update_capture_note", { captureId, note }, operation, "capture.archive", { action: "update_note", captureId });
}

export function deleteCapture(captureId: string, operation = createOperation()) {
  return loggedCommand<void>("delete_capture", { captureId }, operation, "capture.archive", { action: "delete", captureId });
}

/**
 * Atomically replaces the derived capture-to-diary-date reference index.
 * Markdown remains the source of truth.
 */
export async function replaceCaptureReferenceIndex(
  entries: CaptureReferenceIndexEntry[],
  operation = createOperation(),
) {
  return invokeWithOperation<void>("replace_capture_reference_index", { entries }, operation);
}

export function getCaptureShortcutStatus(operation = createOperation()) {
  return invokeWithOperation<CaptureShortcutStatus>("get_capture_shortcut_status", {}, operation);
}

export function setCaptureShortcut(shortcut: string, operation = createOperation()) {
  return loggedCommand<CaptureShortcutStatus>("set_capture_shortcut", { shortcut }, operation, "settings.change", { setting: "capture_shortcut" });
}

let captureShortcutRecordingQueue = Promise.resolve();

export function setCaptureShortcutRecording(recording: boolean, operation = createOperation()) {
  // Serialize across Settings mounts so a departing recorder releases its
  // binding before a newly opened recorder starts.
  const next = captureShortcutRecordingQueue.then(() =>
    loggedCommand<void>("set_capture_shortcut_recording", { recording }, operation, "settings.change", { setting: "shortcut_recording", enabled: recording }),
  );
  captureShortcutRecordingQueue = next.catch(() => {});
  return next;
}
