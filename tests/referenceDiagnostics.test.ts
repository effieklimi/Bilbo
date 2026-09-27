import { expect, test } from "bun:test";

import { createCaptureReferenceIndexCoordinator } from "../src/capture/referenceIndex";
import { createOperation, type OperationContext } from "../src/diagnostics/operation";

const captureId = "11111111-1111-4111-8111-111111111111";
const markdown = `[Capture](#diary-capture-${captureId})`;

test("saved references pass the note operation through to the backend replacement", async () => {
  const calls: Array<{ entries: unknown; operation?: OperationContext }> = [];
  const coordinator = createCaptureReferenceIndexCoordinator({
    readText: async () => markdown,
    replaceIndex: async (entries, operation) => { calls.push({ entries, operation }); },
  });
  const workspace = coordinator.beginWorkspace();
  const operation = createOperation();
  await workspace.savedSnapshot("synthetic-note", "2026-01-01", markdown, operation);
  expect(calls).toEqual([{ entries: [{ diaryDate: "2026-01-01", captureIds: [captureId] }], operation }]);
  expect(calls[0].operation).toBe(operation);
});

test("failed index replacement remains retryable and unchanged scans avoid replacement", async () => {
  let attempts = 0;
  const operations: Array<OperationContext | undefined> = [];
  const coordinator = createCaptureReferenceIndexCoordinator({
    readText: async () => markdown,
    replaceIndex: async (_entries, operation) => {
      operations.push(operation);
      if (++attempts === 1) throw new Error("synthetic replacement failure");
    },
  });
  const workspace = coordinator.beginWorkspace();
  const saveOperation = createOperation();
  await expect(workspace.savedSnapshot("synthetic-note", "2026-01-01", markdown, saveOperation)).rejects.toThrow("synthetic replacement failure");
  const retryOperation = createOperation();
  const files = [{ path: "synthetic-note", diaryDate: "2026-01-01" }];
  await workspace.rescan(files, retryOperation, "focus");
  await workspace.rescan(files, createOperation(), "watch");
  expect(attempts).toBe(2);
  expect(operations).toEqual([saveOperation, retryOperation]);
});

test("an invalidated workspace cannot replace the new workspace's reference index", async () => {
  let releaseRead!: (body: string) => void;
  const blockedRead = new Promise<string>((resolve) => { releaseRead = resolve; });
  const replacements: Array<OperationContext | undefined> = [];
  const coordinator = createCaptureReferenceIndexCoordinator({
    readText: () => blockedRead,
    replaceIndex: async (_entries, operation) => { replacements.push(operation); },
  });
  const oldWorkspace = coordinator.beginWorkspace();
  const oldScan = oldWorkspace.rescan([{ path: "old-note", diaryDate: "2026-01-01" }]);
  await Promise.resolve();
  const currentWorkspace = coordinator.beginWorkspace();
  const currentOperation = createOperation();
  const currentSave = currentWorkspace.savedSnapshot("new-note", "2026-01-02", markdown, currentOperation);
  releaseRead(markdown);
  await Promise.all([oldScan, currentSave]);
  expect(replacements).toEqual([currentOperation]);
});
