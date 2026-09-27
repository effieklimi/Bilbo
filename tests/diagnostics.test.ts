import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { errorCode, privateAlias, safeDiagnosticFields } from "../src/diagnostics/logger";

const operationId = "11111111-1111-4111-8111-111111111111";

test("diagnostic filtering preserves operational facts and omits private payloads", () => {
  const safe = safeDiagnosticFields({
    outcome: "failed", stage: "markdown", errorCode: "DISK_FULL",
    operationId, noteId: "note-7", workspaceId: "workspace-2",
    dirty: true, markdownSaved: false, markdownCreated: true, persisted: false,
    tagsAvailable: false, captureReferencesAvailable: false,
    pendingSaveCount: 2, durationMs: 42, lastSaveAt: null,
    path: "/private/synthetic-note.md", note: "synthetic private content",
    selectedText: "synthetic quote", query: "private query", tags: ["private"],
    url: "https://example.invalid/private", sourceTitle: "private page",
    error: new Error("private error with a filename"), stack: "private stack",
    nested: { dirty: true },
  });
  expect(safe).toEqual({
    outcome: "failed", stage: "markdown", errorCode: "DISK_FULL",
    operationId, noteId: "note-7", workspaceId: "workspace-2",
    dirty: true, markdownSaved: false, markdownCreated: true, persisted: false,
    tagsAvailable: false, captureReferencesAvailable: false,
    pendingSaveCount: 2, durationMs: 42, lastSaveAt: null,
  });
});

test("diagnostic filtering rejects malformed identifiers and unbounded values", () => {
  expect(safeDiagnosticFields({
    operationId: "private document", noteId: "/private/note.md", workspaceId: "x".repeat(49),
    phase: "private content with spaces", count: Infinity, durationMs: NaN,
    pendingSaveCount: Number.MAX_SAFE_INTEGER + 1,
    sourceApp: "Private window title", shortcut: "key with spaces",
  })).toEqual({});
  expect(safeDiagnosticFields({
    captureId: operationId, sourceApp: "com.example.browser", shortcut: "Control+Alt+D",
    dirty: null, status: null, requestedReads: 8,
  })).toEqual({
    captureId: operationId, sourceApp: "com.example.browser", shortcut: "Control+Alt+D",
    dirty: null, status: null, requestedReads: 8,
  });
});

test("error classification returns fixed codes without retaining exception text", () => {
  const cases = [
    ["Permission denied: /private/synthetic", "PERMISSION_DENIED"],
    ["database is locked", "SQLITE_BUSY"],
    ["No space left on device", "DISK_FULL"],
    ["Read-only file system", "READ_ONLY"],
    ["No such file /private/synthetic", "NOT_FOUND"],
    ["malformed database", "CORRUPT_DATA"],
    ["request timed out", "TIMEOUT"],
    ["Operation did not match draft", "OPERATION_MISMATCH"],
    ["synthetic private text", "UNEXPECTED_ERROR"],
  ];
  for (const [message, code] of cases) expect(errorCode(new Error(message))).toBe(code);
  const hostile = new Error();
  Object.defineProperty(hostile, "message", { get() { throw new Error("unreadable"); } });
  expect(errorCode(hostile)).toBe("UNEXPECTED_ERROR");
  expect(errorCode({ message: "private object field" })).toBe("UNEXPECTED_ERROR");
});

test("private aliases are stable within a session and separate identity kinds", () => {
  const path = "/private/synthetic-alias-test.md";
  const note = privateAlias("note", path);
  expect(privateAlias("note", path)).toBe(note);
  expect(privateAlias("workspace", path)).not.toBe(note);
  expect(privateAlias("note", path + ".other")).not.toBe(note);
  expect(note).toMatch(/^note-\d+$/);
  expect(note).not.toContain("synthetic");
});

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const loggerPath = JSON.stringify(fileURLToPath(new URL("../src/diagnostics/logger.ts", import.meta.url)));

// Each scenario gets a fresh queue and mocked IPC in its own process. Fake
// timers make retry behavior deterministic without waiting or leaking mocks.
function transportScenario(scenario: string) {
  const program = `
    import { mock } from "bun:test";
    let nextTimer = 0;
    const timers = new Map();
    globalThis.setTimeout = (callback, delay = 0) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const calls = [];
    let onInvoke = async () => {};
    mock.module("@tauri-apps/api/core", () => ({
      isTauri: () => true,
      invoke: async (command, args) => {
        calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
        return await onInvoke(command, args);
      },
    }));
    mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
    const logger = await import(${loggerPath});
    const operation = { operationId: ${JSON.stringify(operationId)} };
    const emit = count => logger.logEvent("info", "note.save.finished", { count, note: "synthetic private text" }, operation);
    const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    ${scenario}
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", program], {
    cwd: projectDirectory, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("transport batches FIFO records and sanitizes before IPC", () => {
  const result = transportScenario(`
    for (let i = 0; i < 205; i++) emit(i);
    await logger.flushDiagnostics();
    console.log(JSON.stringify(calls));
  `);
  expect(result.map((call: any) => call.args.entries.length)).toEqual([100, 100, 5]);
  const entries = result.flatMap((call: any) => call.args.entries);
  expect(entries.map((entry: any) => entry.fields.count)).toEqual(Array.from({ length: 205 }, (_, i) => i));
  expect(entries.every((entry: any) => entry.operation.operationId === operationId)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic private text");
});

test("a failed batch is retried before newer records without a recursive logging loop", () => {
  const result = transportScenario(`
    let failed = false;
    onInvoke = async command => {
      if (command === "record_diagnostics" && !failed) { failed = true; throw new Error("synthetic IPC failure"); }
    };
    emit(1); emit(2);
    await logger.flushDiagnostics();
    const failureCallCount = calls.length;
    emit(3);
    await logger.flushDiagnostics();
    console.log(JSON.stringify({ failureCallCount, calls }));
  `);
  expect(result.failureCallCount).toBe(1);
  expect(result.calls.map((call: any) => call.args.entries.map((entry: any) => entry.fields.count))).toEqual([[1, 2], [1, 2, 3]]);
  expect(result.calls.every((call: any) => call.command === "record_diagnostics")).toBe(true);
});

test("concurrent flush calls share one active transport and retain arrivals during IPC", () => {
  const result = transportScenario(`
    let release;
    let active = 0;
    let maxActive = 0;
    let first = true;
    onInvoke = async () => {
      active++; maxActive = Math.max(maxActive, active);
      if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
      active--;
    };
    emit(1);
    const firstFlush = logger.flushDiagnostics();
    const secondFlush = logger.flushDiagnostics();
    emit(2);
    release();
    await Promise.all([firstFlush, secondFlush]);
    console.log(JSON.stringify({ maxActive, calls }));
  `);
  expect(result.maxActive).toBe(1);
  expect(result.calls.map((call: any) => call.args.entries.map((entry: any) => entry.fields.count))).toEqual([[1], [2]]);
});

test("queue overflow retains the newest 500 records and reports the drop count", () => {
  const result = transportScenario(`
    for (let i = 0; i < 505; i++) emit(i);
    await logger.flushDiagnostics();
    logger.updateDiagnosticState("diary", { dirty: true, noteId: "note-1" });
    logger.updateDiagnosticState("diary", { pendingSaveCount: 0, workspaceId: "workspace-1" });
    for (const [id, timer] of [...timers]) {
      if (timer.delay === 150) { timers.delete(id); timer.callback(); }
    }
    await settle();
    console.log(JSON.stringify(calls));
  `);
  const entries = result.filter((call: any) => call.command === "record_diagnostics").flatMap((call: any) => call.args.entries);
  expect(entries).toHaveLength(500);
  expect(entries[0].fields.count).toBe(5);
  expect(entries.at(-1).fields.count).toBe(504);
  const snapshot = result.find((call: any) => call.command === "publish_diagnostic_state");
  expect(snapshot.args.sections.diary).toEqual({ dirty: true, noteId: "note-1", pendingSaveCount: 0, workspaceId: "workspace-1" });
  expect(snapshot.args.sections.diagnostics).toMatchObject({ droppedCount: 5, pendingSaveCount: 0, hasError: false });
});
