import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OperationContext } from "./operation";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticFields = Record<string, unknown>;
export type DiagnosticRecord = {
  id: string; timestamp: number; level: LogLevel; event: string;
  origin: string; sessionId: string; operationId: string | null; fields: DiagnosticFields;
};
export type LogPage = { records: DiagnosticRecord[]; total: number; retainedLimit: number; storageError: string | null };
type QueuedRecord = { timestamp: number; level: LogLevel; event: string; fields: DiagnosticFields; operation?: OperationContext };
const queue: QueuedRecord[] = [];
const sections: Record<string, DiagnosticFields> = {};
const aliases = new Map<string, string>();
let nextAlias = 0;
let initialized = false;
let flushing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 250;
let droppedCount = 0;
let transportError = false;

/** An opaque alias for an in-memory path; its original value never leaves this map. */
export function privateAlias(kind: string, value: string): string {
  const key = `${kind}\0${value}`;
  const existing = aliases.get(key);
  if (existing) return existing;
  const alias = `${/^[a-zA-Z]+$/.test(kind) ? kind : "item"}-${++nextAlias}`;
  // Bound auxiliary state in a long-running session too.
  if (aliases.size >= 10_000) aliases.delete(aliases.keys().next().value!);
  aliases.set(key, alias);
  return alias;
}

/** Classify without retaining an exception message, URL, filename, or stack payload. */
export function errorCode(cause: unknown): string {
  let message = "";
  try { message = (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "").toLowerCase(); } catch { /* Hostile/custom errors remain unknown. */ }
  if (/not allowed|permission|access denied/.test(message)) return "PERMISSION_DENIED";
  if (/database is locked|database is busy/.test(message)) return "SQLITE_BUSY";
  if (/disk.*full|no space/.test(message)) return "DISK_FULL";
  if (/read.?only/.test(message)) return "READ_ONLY";
  if (/no such file|not found/.test(message)) return "NOT_FOUND";
  if (/corrupt|malformed/.test(message)) return "CORRUPT_DATA";
  if (/timeout|timed out/.test(message)) return "TIMEOUT";
  if (/operation.*match/.test(message)) return "OPERATION_MISMATCH";
  return "UNEXPECTED_ERROR";
}

// Rust validates the same allowlisted shape before storing it. Drop potentially
// sensitive fields here as well, before crossing IPC or retaining them in a queue.
const enumKeys = new Set("phase status outcome reason errorCode action stage method captureMethod trigger source surface section boundary scheme mode setting destinationKind cancelReason skipReason storage attribute valueType errorClass os arch appVersion buildId osVersion origin window themeId previousThemeId permissionStatus".split(" "));
const booleanKeys = new Set("dirty trusted accessibilityTrusted registered recording inProgress present transient hasSelection hasNote hasText hasTitle hasUrl permissionRequired hasError sourceFrontmost restored stateKnown requestedEnabled actualEnabled enabled markdownSaved newerEditPending bundled debugBuild loginArgumentPresent supported success available focusedWindow focusedElement changed copyPosted clipboardChanged hasSelectedDocument usedBackup retry fileCreated previouslyReady usedSelectedEditorSnapshot captureWarningPresent dirtyAtRemoval sameDraft markdownCreated persisted tagsAvailable captureReferencesAvailable initialized native loading ready shortcutAvailable hasShortcutError folderSelected choosingFolder logsVisible".split(" "));
const identityKeys = new Set(["draftId", "captureId", "operationId"]);
export function safeDiagnosticFields(fields: DiagnosticFields): DiagnosticFields {
  const safe: DiagnosticFields = {};
  try {
    for (const [key, value] of Object.entries(fields).slice(0, 100)) {
      if (Object.keys(safe).length >= 32) break;
      if (value === null && (booleanKeys.has(key) || identityKeys.has(key) || ["noteId", "workspaceId", "lastSaveAt", "status"].includes(key))) safe[key] = null;
      else if (typeof value === "boolean" && booleanKeys.has(key)) safe[key] = value;
      else if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (/Count$|Ms$|At$/.test(key) || ["count", "fromVersion", "toVersion", "schemaVersion", "queueDepth", "parentDepth", "axCode", "requestedReads", "successfulReads", "failedReads", "cacheHits", "flushIterations"].includes(key))) safe[key] = value;
      else if (typeof value === "string") {
        if (identityKeys.has(key) && /^(transient-error-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) safe[key] = value;
        else if (["noteId", "workspaceId"].includes(key) && /^[A-Za-z0-9-]{1,48}$/.test(value)) safe[key] = value;
        else if (enumKeys.has(key) && /^[A-Za-z0-9._:-]{1,64}$/.test(value)) safe[key] = value;
        else if (["sourceApp", "bundleId"].includes(key) && value.includes(".") && /^[A-Za-z0-9._-]{1,128}$/.test(value)) safe[key] = value;
        else if (["shortcut", "requestedShortcut", "previousShortcut"].includes(key) && /^[A-Za-z0-9+_-]{1,64}$/.test(value)) safe[key] = value;
      }
    }
  } catch { /* Diagnostics must never break the action being observed. */ }
  return safe;
}

function scheduleFlush(delay = 50) {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => { flushTimer = undefined; void flushDiagnostics(); }, delay);
}
export function logEvent(level: LogLevel, event: string, fields: DiagnosticFields = {}, operation?: OperationContext): void {
  try {
    if (!isTauri()) return;
    if (queue.length >= 500) { queue.shift(); droppedCount++; }
    queue.push({ timestamp: Date.now(), level, event, fields: safeDiagnosticFields(fields), ...(operation ? { operation } : {}) });
    scheduleFlush();
  } catch { /* Best effort. */ }
}
export async function flushDiagnostics(): Promise<void> {
  if (flushing) return flushing;
  if (!queue.length || !isTauri()) return;
  flushing = (async () => {
    while (queue.length) {
      const entries = queue.splice(0, 100);
      try {
        await invoke("record_diagnostics", { entries });
        transportError = false;
        retryDelay = 250;
      } catch {
        transportError = true;
        queue.unshift(...entries);
        if (queue.length > 500) { droppedCount += queue.length - 500; queue.splice(0, queue.length - 500); }
        clearTimeout(flushTimer);
        flushTimer = undefined;
        scheduleFlush(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
        break;
      }
    }
  })().catch(() => { transportError = true; }).finally(() => { flushing = null; });
  return flushing;
}
async function publishState(requestId?: string) {
  try {
    if (!isTauri()) return;
    await flushDiagnostics();
    await invoke("publish_diagnostic_state", { sections: { ...sections, diagnostics: { pendingSaveCount: queue.length, droppedCount, hasError: transportError } }, requestId: requestId ?? null });
  } catch { transportError = true; }
}
export function updateDiagnosticState(section: string, fields: DiagnosticFields): void {
  try {
    sections[section] = { ...sections[section], ...safeDiagnosticFields(fields) };
    if (!isTauri() || stateTimer !== undefined) return;
    stateTimer = setTimeout(() => { stateTimer = undefined; void publishState(); }, 150);
  } catch { /* Best effort. */ }
}

export function initializeDiagnostics(windowLabel: "main" | "capture"): void {
  if (initialized) return;
  initialized = true;
  updateDiagnosticState("runtime", { initialized: true, window: windowLabel });
  if (typeof window === "undefined") return;
  window.addEventListener("error", () => logEvent("error", "runtime.failed", { boundary: "window_error", errorCode: "UNHANDLED_ERROR" }));
  window.addEventListener("unhandledrejection", event => logEvent("error", "runtime.failed", { boundary: "unhandled_rejection", errorCode: errorCode(event.reason) }));
  window.addEventListener("pagehide", () => { void flushDiagnostics(); });
  if (isTauri()) {
    void listen<string>("diagnostics-snapshot-request", event => { void publishState(event.payload); })
      .catch(cause => logEvent("error", "diagnostics.collection_failed", { section: "snapshot_listener", errorCode: errorCode(cause) }));
  }
}

export async function readLogs(includeDebug: boolean): Promise<LogPage> {
  await flushDiagnostics();
  if (!isTauri()) return { records: [], total: 0, retainedLimit: 5_000, storageError: null };
  return invoke<LogPage>("get_diagnostic_logs", { includeDebug });
}
export async function copyDebugReport(): Promise<void> {
  await publishState();
  return invoke("copy_debug_report");
}
