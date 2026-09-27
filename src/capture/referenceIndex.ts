import type { CaptureReferenceIndexEntry } from "./types";
import { extractCaptureIds } from "./references";
import { errorCode, logEvent } from "../diagnostics/logger";
import { createOperation, type OperationContext } from "../diagnostics/operation";

type CaptureReferenceFile = {
  path: string;
  diaryDate: string;
};

type IndexedFile = CaptureReferenceFile & {
  captureIds: string[];
};

type CaptureReferenceIndexDependencies = {
  readText: (path: string) => Promise<string>;
  replaceIndex: (entries: CaptureReferenceIndexEntry[], operation?: OperationContext) => Promise<unknown>;
};

export type CaptureReferenceWorkspace = {
  /**
   * Rebuilds the index from exactly this set of files. Omitted files are
   * removed. A read or parse failure leaves both local and backend state
   * untouched.
   */
  rescan: (files: readonly CaptureReferenceFile[], operation?: OperationContext, trigger?: string) => Promise<void>;

  /**
   * Records the exact text snapshot after that snapshot has been written to
   * disk successfully. This should be called from the app's sequential save
   * queue, not from an editor change callback.
   */
  savedSnapshot: (
    path: string,
    diaryDate: string,
    snapshot: string,
    operation?: OperationContext,
  ) => Promise<void>;

};

type CaptureReferenceIndexCoordinator = {
  /**
   * Starts a fresh workspace and invalidates every handle and queued task from
   * the previous one. Keep the returned handle with the active workspace.
   */
  beginWorkspace: () => CaptureReferenceWorkspace;
};

function aggregateIndex(files: Iterable<IndexedFile>) {
  const idsByDate = new Map<string, Set<string>>();

  for (const file of files) {
    if (file.captureIds.length === 0) continue;

    let ids = idsByDate.get(file.diaryDate);
    if (!ids) {
      ids = new Set<string>();
      idsByDate.set(file.diaryDate, ids);
    }

    for (const captureId of file.captureIds) ids.add(captureId);
  }

  return Array.from(idsByDate, ([diaryDate, captureIds]) => ({
    diaryDate,
    captureIds: Array.from(captureIds).sort(),
  })).sort((left, right) => left.diaryDate.localeCompare(right.diaryDate));
}

/**
 * Coordinates Markdown scans and saved snapshots with the derived SQLite
 * reference index. All work is serialized so a slower, older operation can
 * never overwrite a newer one.
 */
export function createCaptureReferenceIndexCoordinator({
  readText,
  replaceIndex,
}: CaptureReferenceIndexDependencies): CaptureReferenceIndexCoordinator {
  let generation = 0;
  let indexedFiles = new Map<string, IndexedFile>();
  let committedSignature: string | null = null;
  let queue = Promise.resolve();

  function enqueue(operation: () => Promise<void>) {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function isCurrent(token: number) {
    return token === generation;
  }

  async function replaceIfNeeded(token: number, operation: OperationContext) {
    if (!isCurrent(token)) return "superseded";

    const entries = aggregateIndex(indexedFiles.values());
    const signature = JSON.stringify(entries);
    if (signature === committedSignature) return "unchanged";

    await replaceIndex(entries, operation);

    // beginWorkspace may have invalidated this operation while the backend was
    // running. Never let an old task mark the new workspace as synchronized.
    if (isCurrent(token)) {
      committedSignature = signature;
    }
    return isCurrent(token) ? "success" : "superseded";
  }

  function beginWorkspace(): CaptureReferenceWorkspace {
    const token = ++generation;
    indexedFiles = new Map();
    committedSignature = null;

    return {
      rescan(files, operation = createOperation(), trigger = "rescan") {
        // Capture the requested file set now. The caller may replace or mutate
        // its UI collection before this serialized operation reaches the head
        // of the queue.
        const fileSnapshot = files.map(({ path, diaryDate }) => ({
          path,
          diaryDate,
        }));

        return enqueue(async () => {
          const startedAt = performance.now();
          if (!isCurrent(token)) {
            logEvent("debug", "capture.references", { action: "rescan", trigger, outcome: "superseded" }, operation);
            return;
          }
          logEvent("debug", "capture.references", { action: "rescan", trigger, phase: "started", fileCount: fileSnapshot.length }, operation);

          let loadedFiles: IndexedFile[];
          try {
            loadedFiles = await Promise.all(
              fileSnapshot.map(async (file) => ({
                ...file,
                captureIds: extractCaptureIds(await readText(file.path)),
              })),
            );
          } catch (error) {
            // A superseded workspace no longer owns user-visible state, so its
            // abandoned read should not surface as an error in the new one.
            if (!isCurrent(token)) return;
            logEvent("warn", "capture.references", { action: "rescan", trigger, outcome: "failed", stage: "read_or_parse", fileCount: fileSnapshot.length, errorCode: errorCode(error), durationMs: Math.round(performance.now() - startedAt) }, operation);
            throw error;
          }

          if (!isCurrent(token)) return;

          const nextFiles = new Map<string, IndexedFile>();
          for (const file of loadedFiles) nextFiles.set(file.path, file);
          indexedFiles = nextFiles;

          try {
            const outcome = await replaceIfNeeded(token, operation);
            logEvent(outcome === "success" ? "info" : "debug", "capture.references", { action: "rescan", trigger, outcome, fileCount: fileSnapshot.length, durationMs: Math.round(performance.now() - startedAt) }, operation);
          } catch (cause) {
            logEvent("warn", "capture.references", { action: "rescan", trigger, outcome: "failed", stage: "replace", fileCount: fileSnapshot.length, errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
            throw cause;
          }
        });
      },

      savedSnapshot(path, diaryDate, snapshot, operation = createOperation()) {
        return enqueue(async () => {
          if (!isCurrent(token)) {
            logEvent("debug", "capture.references", { action: "saved_snapshot", outcome: "superseded", markdownSaved: true }, operation);
            return;
          }

          const startedAt = performance.now();
          let stage = "parse";
          try {
            const captureIds = extractCaptureIds(snapshot);
            if (!isCurrent(token)) return;

            indexedFiles.set(path, { path, diaryDate, captureIds });
            stage = "replace";
            const outcome = await replaceIfNeeded(token, operation);
            logEvent(outcome === "success" ? "info" : "debug", "capture.references", { action: "saved_snapshot", outcome, markdownSaved: true, referenceCount: captureIds.length, durationMs: Math.round(performance.now() - startedAt) }, operation);
          } catch (cause) {
            logEvent("warn", "capture.references", { action: "saved_snapshot", outcome: "failed", stage, markdownSaved: true, errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
            throw cause;
          }
        });
      },
    };
  }

  return { beginWorkspace };
}
