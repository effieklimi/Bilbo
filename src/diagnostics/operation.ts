import { invoke } from "@tauri-apps/api/core";

/** Identifies one operation across its steps, retries, and native IPC calls. */
export type OperationContext = Readonly<{
  operationId: string;
}>;

/** Create once at an operation's entry point, then pass the context explicitly. */
export function createOperation(): OperationContext {
  return Object.freeze({ operationId: crypto.randomUUID() });
}

type InvokeCommand = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

export function invokeWithOperation<T>(
  command: string,
  args: Record<string, unknown>,
  operation: OperationContext,
  invokeCommand: InvokeCommand = invoke,
): Promise<T> {
  return invokeCommand<T>(command, { ...args, operation });
}
