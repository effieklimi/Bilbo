import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => JSON.stringify(fileURLToPath(new URL(`../src/${path}`, import.meta.url)));

// Hook and IPC mocks live only in a child process. They cannot replace React,
// filesystem, or logger imports in the rest of the Bun suite.
function runScenario(scenario: string) {
  const program = `
    import { mock } from "bun:test";
    const events = [];
    const state = {};
    const writes = [];
    const referenceErrors = [];
    let write = async () => {};
    let replace = async () => {};
    const replacements = [];
    globalThis.window = { setTimeout, clearTimeout };
    mock.module("react", () => ({
      useState: value => [typeof value === "function" ? value() : value, () => {}],
      useRef: current => ({ current }),
      useCallback: callback => callback,
      useEffect: callback => { callback(); },
    }));
    mock.module("@tauri-apps/plugin-fs", () => ({
      writeTextFile: async (path, snapshot) => {
        writes.push({ path, snapshot });
        await write();
      },
    }));
    mock.module(${source("diagnostics/logger.ts")}, () => ({
      logEvent: (level, event, fields = {}, operation) => events.push({ level, event, fields, operation }),
      errorCode: () => "SYNTHETIC_FAILURE",
      privateAlias: kind => kind + "-1",
      updateDiagnosticState: (section, fields) => { state[section] = { ...state[section], ...fields }; },
    }));
    const { useDiaryDocument } = await import(${source("diary/useDiaryDocument.ts")});
    const { createCaptureReferenceIndexCoordinator } = await import(${source("capture/referenceIndex.ts")});
    const coordinator = createCaptureReferenceIndexCoordinator({
      readText: async () => "",
      replaceIndex: async (entries, operation) => { replacements.push({ entries, operation }); await replace(); },
    });
    const document = useDiaryDocument({
      referenceWorkspaceRef: { current: coordinator.beginWorkspace() },
      setError: () => {},
      onPathSaved: () => {},
      onReferencesSaved: () => {},
      onReferenceError: cause => { referenceErrors.push(Boolean(cause)); },
    });
    document.load({ path: "synthetic-private-path", diaryDate: { dateKey: "2026-01-01" } }, "initial");
    document.changeEditorContent("synthetic secret note content", false);
    ${scenario}
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", program], {
    cwd: projectDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("Markdown success stays successful when reference indexing fails", () => {
  const result = runScenario(`
    replace = async () => { throw new Error("synthetic database failure"); };
    const saved = await document.flushPendingSave("note_open");
    console.log(JSON.stringify({ saved, events, state, replacements, referenceErrors, pending: document.hasPendingSave() }));
  `);
  expect(result.saved).toBe(true);
  expect(result.pending).toBe(false);
  expect(result.referenceErrors).toHaveLength(1);
  const save = result.events.find((event: any) => event.event === "note.save.finished");
  const references = result.events.find((event: any) => event.event === "capture.references" && event.fields.outcome === "failed");
  expect(save.fields).toMatchObject({ outcome: "success", stage: "markdown" });
  expect(references.fields).toMatchObject({ markdownSaved: true, stage: "replace" });
  expect(references.operation).toEqual(save.operation);
  expect(result.replacements[0].operation).toEqual(save.operation);
  expect(result.events.some((event: any) => event.event === "note.action_blocked")).toBe(false);
  expect(result.state.diary).toMatchObject({ dirty: false, pendingSaveCount: 0, noteId: "note-1" });
  expect(result.state.diary.lastSaveAt).toBeGreaterThan(0);
  expect(JSON.stringify(result.events)).not.toContain("synthetic-private-path");
  expect(JSON.stringify(result.events)).not.toContain("synthetic secret note content");
});

test("Markdown write failure blocks the requested action and leaves the note dirty", () => {
  const result = runScenario(`
    write = async () => { throw new Error("synthetic write failure"); };
    const saved = await document.flushPendingSave("window_close");
    console.log(JSON.stringify({ saved, events, state, replacementCount: replacements.length, pending: document.hasPendingSave() }));
  `);
  expect(result.saved).toBe(false);
  expect(result.pending).toBe(true);
  expect(result.replacementCount).toBe(0);
  const failure = result.events.find((event: any) => event.event === "note.save.finished");
  const blocked = result.events.find((event: any) => event.event === "note.action_blocked");
  expect(failure.fields).toMatchObject({ outcome: "failed", stage: "markdown", markdownSaved: false });
  expect(blocked.fields).toMatchObject({ action: "window_close", reason: "save_failed" });
  expect(blocked.operation).toEqual(failure.operation);
  expect(result.state.diary).toMatchObject({ dirty: true, pendingSaveCount: 0, lastSaveAt: null });
});

test("overlapping flushes reuse one pending write and operation", () => {
  const result = runScenario(`
    let release;
    write = () => new Promise(resolve => { release = resolve; });
    const first = document.flushPendingSave("blur");
    const second = document.flushPendingSave("note_open");
    await Promise.resolve();
    release();
    const saved = await Promise.all([first, second]);
    console.log(JSON.stringify({ saved, events, writeCount: writes.length, replacementCount: replacements.length }));
  `);
  expect(result.saved).toEqual([true, true]);
  expect(result.writeCount).toBe(1);
  expect(result.replacementCount).toBe(1);
  const saveEvents = result.events.filter((event: any) => event.event.startsWith("note.save."));
  expect(new Set(saveEvents.map((event: any) => event.operation.operationId)).size).toBe(1);
  expect(saveEvents.some((event: any) => event.level === "debug" && event.fields.phase === "reused")).toBe(true);
});

test("a failed blur save does not claim that blur was blocked", () => {
  const result = runScenario(`
    write = async () => { throw new Error("synthetic write failure"); };
    const saved = await document.flushPendingSave("blur");
    console.log(JSON.stringify({ saved, events }));
  `);
  expect(result.saved).toBe(false);
  expect(result.events.some((event: any) => event.event === "note.save.finished" && event.fields.outcome === "failed")).toBe(true);
  expect(result.events.some((event: any) => event.event === "note.action_blocked")).toBe(false);
});
