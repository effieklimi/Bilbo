import { expect, test } from "bun:test";

import {
  createOperation,
  invokeWithOperation,
  type OperationContext,
} from "../src/diagnostics/operation";

test("new operations have distinct, immutable UUID v4 contexts", () => {
  const operations = Array.from({ length: 32 }, () => createOperation());

  expect(new Set(operations.map(({ operationId }) => operationId)).size).toBe(32);
  for (const operation of operations) {
    expect(operation.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Object.isFrozen(operation)).toBe(true);
  }
});

test("successive native calls reuse the supplied context and preserve payloads and results", async () => {
  const operation = createOperation();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const savedCapture = { captureId: "saved-capture" };
  const invokeCommand = async <T>(command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    return savedCapture as T;
  };
  const args = { draftId: "draft-a", note: "A thought" };

  await invokeWithOperation("update_capture_draft", args, operation, invokeCommand);
  const saved = await invokeWithOperation<typeof savedCapture>(
    "save_capture", args, operation, invokeCommand,
  );

  expect(saved).toBe(savedCapture);
  expect(calls).toEqual([
    { command: "update_capture_draft", args: { ...args, operation } },
    { command: "save_capture", args: { ...args, operation } },
  ]);
  expect(calls[0].args.operation).toBe(operation);
  expect(calls[1].args.operation).toBe(operation);
  expect(args).toEqual({ draftId: "draft-a", note: "A thought" });
});

test("interleaved operations remain independent when native replies arrive out of order", async () => {
  const firstOperation = createOperation();
  const secondOperation = createOperation();
  const pending: Array<{
    command: string;
    args: Record<string, unknown>;
    resolve: (value: unknown) => void;
  }> = [];
  const invokeCommand = <T>(command: string, args: Record<string, unknown>) =>
    new Promise<T>((resolve) => {
      pending.push({ command, args, resolve: (value) => resolve(value as T) });
    });

  async function updateThenSave(draftId: string, operation: OperationContext) {
    const args = { draftId, note: draftId };
    await invokeWithOperation("update_capture_draft", args, operation, invokeCommand);
    return invokeWithOperation<string>("save_capture", args, operation, invokeCommand);
  }

  const first = updateThenSave("draft-a", firstOperation);
  const second = updateThenSave("draft-b", secondOperation);

  pending[1].resolve(undefined);
  await Promise.resolve();
  expect(pending[2].command).toBe("save_capture");
  expect(pending[2].args).toEqual({
    draftId: "draft-b", note: "draft-b", operation: secondOperation,
  });
  pending[2].resolve("saved-b");
  expect(await second).toBe("saved-b");

  pending[0].resolve(undefined);
  await Promise.resolve();
  expect(pending[3].command).toBe("save_capture");
  expect(pending[3].args).toEqual({
    draftId: "draft-a", note: "draft-a", operation: firstOperation,
  });
  pending[3].resolve("saved-a");
  expect(await first).toBe("saved-a");
});

test("native errors propagate unchanged and retrying retains the operation ID", async () => {
  const operation = createOperation();
  const failure = { code: "SQLITE_BUSY", message: "Database is busy" };
  const receivedContexts: unknown[] = [];
  const invokeCommand = async <T>(_command: string, args: Record<string, unknown>) => {
    receivedContexts.push(args.operation);
    if (receivedContexts.length === 1) throw failure;
    return undefined as T;
  };

  let thrown: unknown;
  try {
    await invokeWithOperation("save_capture", { draftId: "draft-a" }, operation, invokeCommand);
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown).toBe(failure);

  await invokeWithOperation("save_capture", { draftId: "draft-a" }, operation, invokeCommand);
  expect(receivedContexts).toEqual([operation, operation]);
});

test("explicit context wins over an accidental operation field in command arguments", async () => {
  const operation = createOperation();
  const invokeCommand = async <T>(_command: string, args: Record<string, unknown>) => args as T;

  const result = await invokeWithOperation<Record<string, unknown>>(
    "cancel_capture",
    { draftId: "draft-a", operation: createOperation() },
    operation,
    invokeCommand,
  );

  expect(result.operation).toBe(operation);
});
