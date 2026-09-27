import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";

import type { SavedCapture } from "../capture/types";
import { errorMessage } from "../errors";
import { errorCode, logEvent } from "../diagnostics/logger";
import { createOperation } from "../diagnostics/operation";
import {
  analyzeMarkdownSafely,
  type MarkdownAnalysis,
} from "../markdown/analyze";
import { captureSearchDocument } from "./captureDocument";
import type {
  CaptureSearchDocument,
  DiarySearchDocument,
} from "./types";

export type DiarySearchFile = {
  path: string;
  fileName: string;
  dateLabel: string;
  dateAliases: readonly string[];
  fileNameAliases?: readonly string[];
  modifiedAt: number;
  size: number;
};

type MarkdownCacheEntry = {
  fingerprint: string;
  body: string;
  analysis: MarkdownAnalysis;
};

type UseSearchCorpusOptions = {
  open: boolean;
  workspacePath: string | null;
  files: readonly DiarySearchFile[];
  invalidatedPaths: readonly string[];
  selectedPath: string | null;
  selectedContent: string;
  selectedAnalysis: MarkdownAnalysis;
  captures: readonly SavedCapture[];
  captureLoading: boolean;
  captureWarning: string | null;
};

const READ_CONCURRENCY = 8;

function fileFingerprint(file: DiarySearchFile) {
  return `${file.modifiedAt}:${file.size}`;
}

async function readFiles(
  files: readonly DiarySearchFile[],
): Promise<
  Array<
    | { file: DiarySearchFile; body: string }
    | { file: DiarySearchFile; error: unknown }
  >
> {
  const results: Array<
    | { file: DiarySearchFile; body: string }
    | { file: DiarySearchFile; error: unknown }
  > = [];
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++];

      try {
        results.push({ file, body: await readTextFile(file.path) });
      } catch (error) {
        results.push({ file, error });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(READ_CONCURRENCY, files.length) },
      () => worker(),
    ),
  );

  return results;
}

export function useSearchCorpus({
  open,
  workspacePath,
  files,
  invalidatedPaths,
  selectedPath,
  selectedContent,
  selectedAnalysis,
  captures,
  captureLoading,
  captureWarning,
}: UseSearchCorpusOptions) {
  const markdownCacheRef = useRef(new Map<string, MarkdownCacheEntry>());
  const diaryRequestRef = useRef(0);
  const selectedSnapshotRef = useRef({
    path: selectedPath,
    content: selectedContent,
  });
  selectedSnapshotRef.current = {
    path: selectedPath,
    content: selectedContent,
  };

  const [cacheVersion, setCacheVersion] = useState(0);
  const [diaryLoading, setDiaryLoading] = useState(false);
  const [diaryWarning, setDiaryWarning] = useState<string | null>(null);

  useEffect(() => {
    diaryRequestRef.current += 1;
    markdownCacheRef.current.clear();
    setCacheVersion((version) => version + 1);
    setDiaryWarning(null);
    setDiaryLoading(false);
  }, [workspacePath]);

  const refreshDiary = useCallback(async () => {
    if (!workspacePath) {
      markdownCacheRef.current.clear();
      setCacheVersion((version) => version + 1);
      setDiaryWarning(null);
      setDiaryLoading(false);
      return;
    }

    const request = ++diaryRequestRef.current;
    const operation = createOperation();
    const startedAt = performance.now();
    const currentPaths = new Set(files.map((file) => file.path));
    const invalidatedPathSet = new Set(invalidatedPaths);
    const invalidateEverything = invalidatedPaths.some(
      (path) => path === workspacePath,
    );
    const selectedSnapshot = selectedSnapshotRef.current;
    const selectedFile = files.find(
      (file) => file.path === selectedSnapshot.path,
    );
    const toRead = files.filter((file) => {
      if (file.path === selectedSnapshot.path) return false;

      const cached = markdownCacheRef.current.get(file.path);
      return (
        invalidateEverything ||
        invalidatedPathSet.has(file.path) ||
        !cached ||
        cached.fingerprint !== fileFingerprint(file)
      );
    });

    setDiaryLoading(toRead.length > 0);
    setDiaryWarning(null);
    logEvent("debug", "search.load", { phase: "started", requestedReads: toRead.length, fileCount: files.length, cachedCount: markdownCacheRef.current.size }, operation);

    let results: Awaited<ReturnType<typeof readFiles>>;

    try {
      results = await readFiles(toRead);
    } catch (cause) {
      if (request !== diaryRequestRef.current) return;

      logEvent("warn", "search.load", { outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
      setDiaryWarning(
        errorMessage(cause, "Diary entries could not be searched."),
      );
      setDiaryLoading(false);
      return;
    }

    if (request !== diaryRequestRef.current) {
      logEvent("debug", "search.load", { outcome: "superseded" }, operation);
      return;
    }

    for (const cachedPath of markdownCacheRef.current.keys()) {
      if (!currentPaths.has(cachedPath)) {
        markdownCacheRef.current.delete(cachedPath);
      }
    }

    if (selectedFile) {
      markdownCacheRef.current.set(selectedFile.path, {
        fingerprint: fileFingerprint(selectedFile),
        body: selectedSnapshot.content,
        analysis: analyzeMarkdownSafely(selectedSnapshot.content),
      });
    }

    let failedReads = 0;
    let firstReadErrorCode: string | undefined;
    for (const result of results) {
      if ("error" in result) {
        failedReads += 1;
        firstReadErrorCode ??= errorCode(result.error);
        markdownCacheRef.current.delete(result.file.path);
      } else {
        markdownCacheRef.current.set(result.file.path, {
          fingerprint: fileFingerprint(result.file),
          body: result.body,
          analysis: analyzeMarkdownSafely(result.body),
        });
      }
    }

    setDiaryWarning(
      failedReads > 0
        ? failedReads === 1
          ? "One diary entry could not be searched."
          : `${failedReads} diary entries could not be searched.`
        : null,
    );
    setDiaryLoading(false);
    setCacheVersion((version) => version + 1);
    logEvent(failedReads > 0 ? "warn" : "debug", "search.load", { outcome: failedReads > 0 ? "partial" : "success", requestedReads: toRead.length, failedReads, errorCode: firstReadErrorCode, documentCount: markdownCacheRef.current.size, usedSelectedEditorSnapshot: Boolean(selectedFile), durationMs: Math.round(performance.now() - startedAt) }, operation);
  }, [files, invalidatedPaths, workspacePath]);

  useEffect(() => {
    if (!open) return;
    void refreshDiary();
  }, [open, refreshDiary]);

  useEffect(() => {
    if (!open || !workspacePath) return;

    const cached = markdownCacheRef.current.get(selectedPath ?? "");
    if (!selectedPath || !cached) return;

    cached.body = selectedContent;
    cached.analysis = selectedAnalysis;
  }, [open, selectedAnalysis, selectedContent, selectedPath, workspacePath]);

  const diaryDocuments = useMemo(() => {
    void cacheVersion;

    return files.flatMap((file): DiarySearchDocument[] => {
      const cached = markdownCacheRef.current.get(file.path);
      const selected = file.path === selectedPath;
      const body = selected ? selectedContent : cached?.body;
      const analysis = selected ? selectedAnalysis : cached?.analysis;
      if (body === undefined || analysis === undefined) return [];

      return [
        {
          kind: "diary",
          id: `diary:${file.path}`,
          path: file.path,
          fileName: file.fileName,
          fileNameAliases: file.fileNameAliases,
          dateLabel: file.dateLabel,
          dateAliases: file.dateAliases,
          body,
          searchText: analysis.searchText,
          tags: analysis.tags,
          modifiedAt: file.modifiedAt,
        },
      ];
    });
  }, [cacheVersion, files, selectedAnalysis, selectedContent, selectedPath]);
  const captureDocuments = useMemo<CaptureSearchDocument[]>(
    () => captures.map(captureSearchDocument),
    [captures],
  );

  return {
    diaryDocuments,
    captureDocuments,
    diaryLoading,
    captureLoading,
    diaryWarning,
    captureWarning,
  };
}
