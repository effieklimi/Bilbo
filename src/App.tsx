import {
  type ClipboardEvent,
  type MouseEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@mdxeditor/editor/style.css";
import {
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  lexicalTheme as mdxEditorLexicalTheme,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from "@mdxeditor/editor";
import { isTauri } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, Pen, Search, Settings } from "lucide-react";
import {
  readTextFile,
  stat,
  watch,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import CaptureArchive, {
  type CaptureRevealRequest,
} from "./capture/CaptureArchive";
import { replaceCaptureReferenceIndex } from "./capture/api";
import { formatCaptureMarkdown } from "./capture/formatCaptureMarkdown";
import {
  createCaptureReferenceIndexCoordinator,
  type CaptureReferenceWorkspace,
} from "./capture/referenceIndex";
import {
  captureIdFromHref,
} from "./capture/references";
import { useCaptureCollection } from "./capture/useCaptureCollection";
import DiarySidebar from "./diary/DiarySidebar";
import {
  compareMarkdownFiles,
  dailyFileName,
  formatMarkdownFileDate,
  markdownDateAliases,
  readMarkdownFiles,
  type MarkdownFile,
} from "./diary/files";
import { useDiaryDocument } from "./diary/useDiaryDocument";
import {
  type DiaryCaptureRevealRequest,
  useCaptureReveal,
} from "./diary/useCaptureReveal";
import { enterMarkdownShortcutsPlugin } from "./editor/enterMarkdownShortcutsPlugin";
import { createCommandPaletteSelection } from "./editor/commandPaletteSelectionPlugin";
import { normalizeExternalUrl } from "./editor/externalLinks";
import { hashtagPlugin } from "./editor/hashtagPlugin";
import { quoteEditingPlugin } from "./editor/quoteEditingPlugin";
import { captureReferencePlugin } from "./editor/captureReferencePlugin";
import { errorMessage } from "./errors";
import { errorCode, logEvent, privateAlias, updateDiagnosticState } from "./diagnostics/logger";
import { createOperation, type OperationContext } from "./diagnostics/operation";
import { analyzeMarkdownSafely } from "./markdown/analyze";
import {
  parseDiaryFileDate,
  type DiaryDate,
} from "./diaryDates";
import {
  INTERFACE_ZOOM_STEP,
  normalizeInterfaceZoom,
  readInterfaceZoom,
  writeInterfaceZoom,
} from "./interfaceZoom";
import SearchDialog from "./search/SearchDialog";
import OnboardingDialog from "./onboarding/OnboardingDialog";
import { needsOnboarding, ONBOARDING_KEY } from "./onboarding/state";
import type {
  CaptureSearchResult,
  DiarySearchResult,
  SearchNoteContext,
} from "./search/types";
import {
  type DiarySearchFile,
  useSearchCorpus,
} from "./search/useSearchCorpus";
import SettingsPage from "./settings/SettingsPage";
import UpdateNotice from "./updates/UpdateNotice";
import {
  formatShortcut,
  isShortcutRecording,
  matchesShortcut,
  readAppShortcuts,
  watchAppShortcuts,
} from "./shortcuts";
import { tagSearchQuery } from "./tags/tags";
import {
  readTheme,
  watchTheme,
  writeTheme,
  type ThemePreferences,
} from "./theme";

const WORKSPACE_KEY = "diary.workspace";
const CAPTURE_REFERENCE_ERROR_PREFIX =
  "Capture links could not be refreshed: ";
type AppView = "diary" | "captures" | "settings";
type PendingNoteCaptureAction = {
  kind: "add" | "reveal";
  notePath: string;
  captureId: string;
  operation: OperationContext;
};
const EDITOR_LEXICAL_THEME = {
  ...mdxEditorLexicalTheme,
  text: {
    ...mdxEditorLexicalTheme.text,
    code: "diary-inline-code",
  },
  hashtag: "diary-tag",
};

function isMarkdownTable(markdown: string) {
  const lines = markdown.trim().split(/\r?\n/);

  return (
    lines.length >= 2 &&
    lines[0].includes("|") &&
    /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[1])
  );
}

function captureReferenceFiles(files: readonly MarkdownFile[]) {
  return files.flatMap((file) =>
    file.diaryDate
      ? [{ path: file.path, diaryDate: file.diaryDate.dateKey }]
      : [],
  );
}

function captureReferenceError(cause: unknown) {
  const message = errorMessage(cause, "Unknown error");
  return `${CAPTURE_REFERENCE_ERROR_PREFIX}${message}`;
}

export default function App() {
  const [activeView, setActiveView] = useState<AppView>("diary");
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [files, setFiles] = useState<MarkdownFile[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingPending, setOnboardingPending] = useState(false);
  const onboardingOpenRef = useRef(false);
  onboardingOpenRef.current = onboardingOpen;
  const [searchInitialQuery, setSearchInitialQuery] = useState("");
  const searchOpenRef = useRef(false);
  const searchOriginPathRef = useRef<string | null>(null);
  const searchOriginElementRef = useRef<HTMLElement | null>(null);
  const searchNavigatedRef = useRef(false);
  const pendingNoteCaptureActionRef = useRef<PendingNoteCaptureAction | null>(null);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const [paletteSelection] = useState(createCommandPaletteSelection);
  const [invalidatedSearchPaths, setInvalidatedSearchPaths] = useState<string[]>(
    [],
  );
  const [captureRevealRequest, setCaptureRevealRequest] =
    useState<CaptureRevealRequest | null>(null);
  const [diaryCaptureRevealRequest, setDiaryCaptureRevealRequest] =
    useState<DiaryCaptureRevealRequest | null>(null);
  const [captureReferenceRevision, setCaptureReferenceRevision] = useState(0);
  const [interfaceZoom, setInterfaceZoom] = useState(readInterfaceZoom);
  const [theme, setTheme] = useState(readTheme);
  const [shortcuts, setShortcuts] = useState(readAppShortcuts);
  const { darkMode, themeId } = theme;
  const [loading, setLoading] = useState(true);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [captureArchiveEditing, setCaptureArchiveEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  const diaryScrollRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<MarkdownFile[]>([]);
  const interfaceZoomQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fileSelectionSequenceRef = useRef(0);
  const closingRef = useRef(false);
  const updateInstallingRef = useRef(false);
  const captureRevealSequenceRef = useRef(0);
  const diaryCaptureRevealSequenceRef = useRef(0);
  const referenceWorkspaceRef = useRef<CaptureReferenceWorkspace | null>(null);
  const [captureReferenceIndex] = useState(() =>
    createCaptureReferenceIndexCoordinator({
      readText: readTextFile,
      replaceIndex: replaceCaptureReferenceIndex,
    }),
  );
  const markCaptureReferencesRefreshed = useCallback(() => {
    setError((current) =>
      current?.startsWith(CAPTURE_REFERENCE_ERROR_PREFIX) ? null : current,
    );
    setCaptureReferenceRevision((revision) => revision + 1);
  }, []);
  const markSearchPathInvalidated = useCallback((path: string) => {
    setInvalidatedSearchPaths([path]);
  }, []);
  const handleCaptureReferenceError = useCallback((cause: unknown) => {
    setError(captureReferenceError(cause));
  }, []);
  const {
    selectedFile,
    content,
    selectedFileRef,
    contentRef,
    load: loadDiaryDocument,
    updateSelectedFile,
    flushPendingSave,
    changeEditorContent,
    hasPendingSave,
  } = useDiaryDocument({
    referenceWorkspaceRef,
    setError,
    onPathSaved: markSearchPathInvalidated,
    onReferencesSaved: markCaptureReferencesRefreshed,
    onReferenceError: handleCaptureReferenceError,
  });
  const editorPlugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      quoteEditingPlugin(),
      linkPlugin(),
      captureReferencePlugin(),
      tablePlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
      codeMirrorPlugin({ codeBlockLanguages: { "": "Plain text" } }),
      markdownShortcutPlugin(),
      enterMarkdownShortcutsPlugin(),
      hashtagPlugin(),
      paletteSelection.plugin,
    ],
    [paletteSelection],
  );
  const today = new Date();
  const todayFileName = dailyFileName(today);
  const todayDateKey = parseDiaryFileDate(todayFileName)?.dateKey;
  const hasTodayFile = files.some(
    (file) =>
      file.name.toLowerCase() === todayFileName ||
      (file.diaryDate !== null && file.diaryDate.dateKey === todayDateKey),
  );
  const diaryTargets = useMemo(() => {
    const targets = new Map<string, DiaryDate>();

    for (const file of files) {
      if (file.diaryDate && !targets.has(file.diaryDate.dateKey)) {
        targets.set(file.diaryDate.dateKey, file.diaryDate);
      }
    }

    return Array.from(targets.values());
  }, [files]);
  const currentMarkdownAnalysis = useMemo(
    () => analyzeMarkdownSafely(content),
    [content],
  );
  const searchNote = useMemo<SearchNoteContext | null>(
    () => activeView === "diary" && !loading && selectedFile?.diaryDate
      ? {
          path: selectedFile.path,
          label: formatMarkdownFileDate(selectedFile),
          captureIds: currentMarkdownAnalysis.captureIds,
        }
      : null,
    [activeView, currentMarkdownAnalysis.captureIds, loading, selectedFile],
  );
  const diarySearchFiles = useMemo<DiarySearchFile[]>(
    () =>
      files.map((file) => ({
        path: file.path,
        fileName: file.name,
        dateLabel: formatMarkdownFileDate(file),
        dateAliases: markdownDateAliases(file),
        fileNameAliases: file.diaryDate
          ? [file.name.replace(/\.(?:md|markdown)$/i, "")]
          : [],
        modifiedAt: file.modifiedAt?.getTime() ?? file.createdAt.getTime(),
        size: file.size,
      })),
    [files],
  );
  const captureCollection = useCaptureCollection(captureReferenceRevision);
  const capturesRef = useRef(captureCollection.captures);
  capturesRef.current = captureCollection.captures;
  const searchCorpus = useSearchCorpus({
    open: searchOpen,
    workspacePath,
    files: diarySearchFiles,
    invalidatedPaths: invalidatedSearchPaths,
    selectedPath: selectedFile?.path ?? null,
    selectedContent: content,
    selectedAnalysis: currentMarkdownAnalysis,
    captures: captureCollection.captures,
    captureLoading: captureCollection.loading,
    captureWarning: captureCollection.error,
  });

  const showSearch = useCallback((query = "") => {
    // Complete a queued insertion before accepting another palette session.
    if (onboardingOpenRef.current || pendingNoteCaptureActionRef.current || updateInstallingRef.current) return;
    if (!searchOpenRef.current) {
      paletteSelection.save();
      searchOriginElementRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      searchNavigatedRef.current = false;
      searchOriginPathRef.current = activeViewRef.current === "diary"
        ? selectedFileRef.current?.path ?? null
        : null;
    }
    searchOpenRef.current = true;
    setSearchInitialQuery(query);
    setSearchOpen(true);
  }, [paletteSelection, selectedFileRef]);

  const changeSearchOpen = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      showSearch();
    } else {
      searchOpenRef.current = false;
      setSearchOpen(false);
    }
  }, [showSearch]);

  useEffect(() => {
    updateDiagnosticState("diary", {
      workspaceId: workspacePath ? privateAlias("workspace", workspacePath) : null,
      fileCount: files.length,
    });
  }, [workspacePath, files.length]);

  const loadWorkspace = useCallback(async (path: string, trigger = "restore", operation = createOperation()) => {
    const startedAt = performance.now();
    const workspaceId = privateAlias("workspace", path);
    let stage = "list";
    logEvent("info", "workspace.open", { phase: "started", trigger, workspaceId }, operation);
    try {
      const markdownFiles = await readMarkdownFiles(path, operation);
      const latestFile =
        markdownFiles.find((file) => file.diaryDate !== null) ??
        markdownFiles[0] ??
        null;
      stage = "read_latest";
      const latestContent = latestFile ? await readTextFile(latestFile.path) : "";

      // The user may return to the diary while a slow folder is being read.
      if (!(await flushPendingSave("workspace_open"))) {
        logEvent("warn", "workspace.open", { outcome: "blocked", trigger, workspaceId, reason: "save_failed" }, operation);
        return false;
      }

      stage = "activate";
      const referenceWorkspace = captureReferenceIndex.beginWorkspace();
      referenceWorkspaceRef.current = referenceWorkspace;
      fileSelectionSequenceRef.current += 1;
      loadDiaryDocument(latestFile, latestContent);
      setWorkspacePath(path);
      filesRef.current = markdownFiles;
      setFiles(markdownFiles);
      logEvent("info", "workspace.open", { outcome: "success", trigger, workspaceId, fileCount: markdownFiles.length, durationMs: Math.round(performance.now() - startedAt) }, operation);

      try {
        await referenceWorkspace.rescan(captureReferenceFiles(markdownFiles), operation, "workspace_open");
        if (referenceWorkspaceRef.current === referenceWorkspace) markCaptureReferencesRefreshed();
      } catch (cause) {
        setError(captureReferenceError(cause));
      }
      return true;
    } catch (cause) {
      logEvent("error", "workspace.open", { outcome: "failed", stage, trigger, workspaceId, errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
      throw cause;
    }
  }, [captureReferenceIndex, flushPendingSave, loadDiaryDocument, markCaptureReferencesRefreshed]);

  useEffect(() => {
    const savedWorkspace = window.localStorage.getItem(WORKSPACE_KEY);

    if (needsOnboarding(savedWorkspace, window.localStorage.getItem(ONBOARDING_KEY))) {
      setOnboardingPending(true);
      setOnboardingOpen(true);
      try {
        window.localStorage.setItem(ONBOARDING_KEY, "pending");
      } catch (cause) {
        logEvent("warn", "runtime.failed", { boundary: "onboarding_start", errorCode: errorCode(cause) });
      }
    }

    if (!savedWorkspace) {
      setLoading(false);
      return;
    }

    void loadWorkspace(savedWorkspace)
      .catch(() => {
        window.localStorage.removeItem(WORKSPACE_KEY);
        setError("The saved folder is unavailable. Choose it again.");
      })
      .finally(() => setLoading(false));
  }, [loadWorkspace]);

  useEffect(() => watchTheme(setTheme), []);
  useEffect(() => watchAppShortcuts(setShortcuts), []);

  useEffect(() => {
    if (!workspacePath) return;

    const referenceWorkspace = referenceWorkspaceRef.current;
    let disposed = false;
    let stopWatching: (() => void) | undefined;
    let refreshGeneration = 0;
    const watchOperation = createOperation();
    const workspaceId = privateAlias("workspace", workspacePath);

    async function refreshFiles(operation: OperationContext) {
      const generation = ++refreshGeneration;
      const startedAt = performance.now();
      const nextFiles = await readMarkdownFiles(workspacePath!, operation);
      if (disposed || generation !== refreshGeneration) return;

      filesRef.current = nextFiles;
      setFiles(nextFiles);

      const currentSelectedFile = selectedFileRef.current;
      if (
        currentSelectedFile &&
        !nextFiles.some((file) => file.path === currentSelectedFile.path)
      ) {
        logEvent("warn", "workspace.watch", { action: "selected_note_removed", noteId: privateAlias("note", currentSelectedFile.path), dirty: hasPendingSave(), workspaceId }, operation);
        loadDiaryDocument(null);
      } else if (currentSelectedFile) {
        const refreshedSelectedFile = nextFiles.find(
          (file) => file.path === currentSelectedFile.path,
        );
        if (refreshedSelectedFile) {
          updateSelectedFile(refreshedSelectedFile);
        }
      }

      if (referenceWorkspace) {
        try {
          await referenceWorkspace.rescan(captureReferenceFiles(nextFiles), operation, "watch");
          if (
            !disposed &&
            generation === refreshGeneration &&
            referenceWorkspaceRef.current === referenceWorkspace
          ) {
            markCaptureReferencesRefreshed();
          }
        } catch (cause) {
          if (!disposed && generation === refreshGeneration) {
            setError(captureReferenceError(cause));
          }
        }
      }
      logEvent("debug", "workspace.watch", { action: "refresh", outcome: "success", workspaceId, fileCount: nextFiles.length, durationMs: Math.round(performance.now() - startedAt) }, operation);
    }

    void watch(
      workspacePath,
      (event) => {
        const operation = createOperation();
        setInvalidatedSearchPaths(event.paths);
        void refreshFiles(operation).catch((cause) => {
          if (!disposed) {
            logEvent("warn", "workspace.watch", { action: "refresh", outcome: "failed", workspaceId, errorCode: errorCode(cause) }, operation);
            setError(errorMessage(cause, "The diary folder could not be refreshed."));
          }
        });
      },
      { recursive: false, delayMs: 150 },
    )
      .then((unwatch) => {
        if (disposed) {
          unwatch();
        } else {
          stopWatching = unwatch;
          logEvent("info", "workspace.watch", { action: "register", outcome: "success", workspaceId }, watchOperation);
        }
      })
      .catch((cause) => {
        if (!disposed) {
          logEvent("error", "workspace.watch", { action: "register", outcome: "failed", workspaceId, errorCode: errorCode(cause) }, watchOperation);
          setError(errorMessage(cause, "The diary folder could not be watched."));
        }
      });

    return () => {
      disposed = true;
      stopWatching?.();
    };
  }, [
    loadDiaryDocument,
    markCaptureReferencesRefreshed,
    updateSelectedFile,
    workspacePath,
    hasPendingSave,
  ]);

  useEffect(() => {
    function retryCaptureReferenceIndex() {
      const referenceWorkspace = referenceWorkspaceRef.current;
      if (!referenceWorkspace) return;

      // Re-read the workspace rather than retrying only the last backend
      // payload. A prior failure may have been a transient file read, in which
      // case the coordinator deliberately never changed its local snapshot.
      void referenceWorkspace
        .rescan(captureReferenceFiles(filesRef.current), createOperation(), "focus")
        .then(() => {
          if (referenceWorkspaceRef.current === referenceWorkspace) {
            markCaptureReferencesRefreshed();
          }
        })
        .catch((cause) => {
          setError(captureReferenceError(cause));
        });
    }

    window.addEventListener("focus", retryCaptureReferenceIndex);
    return () =>
      window.removeEventListener("focus", retryCaptureReferenceIndex);
  }, [markCaptureReferencesRefreshed]);

  useCaptureReveal({
    active: activeView === "diary",
    selectedDateKey: selectedFile?.diaryDate?.dateKey ?? null,
    captureIds: currentMarkdownAnalysis.captureIds,
    request: diaryCaptureRevealRequest,
    setRequest: setDiaryCaptureRevealRequest,
    scrollRef: diaryScrollRef,
    setError,
  });

  useEffect(() => {
    if (!isTauri()) return;

    const currentWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void currentWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closingRef.current || updateInstallingRef.current) return;

        const pendingSave = hasPendingSave();
        closingRef.current = true;

        if (pendingSave) {
          const saved = await flushPendingSave("window_close");
          if (!saved || hasPendingSave()) {
            if (saved) logEvent("warn", "note.action_blocked", { action: "window_close", reason: "still_pending" });
            closingRef.current = false;
            return;
          }
        }

        try {
          await currentWindow.hide();
        } catch (cause) {
          logEvent("error", "runtime.failed", { boundary: "window_hide", errorCode: errorCode(cause) });
          throw cause;
        } finally {
          closingRef.current = false;
        }
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((cause) => {
        if (!disposed) {
          logEvent("error", "runtime.failed", { boundary: "close_handler", errorCode: errorCode(cause) });
          setError(errorMessage(cause, "The window close handler is unavailable."));
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushPendingSave, hasPendingSave]);

  useEffect(() => {
    writeInterfaceZoom(interfaceZoom);

    if (!isTauri()) return;

    let disposed = false;

    interfaceZoomQueueRef.current = interfaceZoomQueueRef.current
      .then(() => getCurrentWebview().setZoom(interfaceZoom))
      .catch((cause) => {
        if (!disposed) {
          const message = errorMessage(cause, "Unknown error");
          logEvent("warn", "runtime.failed", { boundary: "zoom_apply", errorCode: errorCode(cause) });
          setError(`Could not resize the interface: ${message}`);
        }
      });

    return () => {
      disposed = true;
    };
  }, [interfaceZoom]);

  useEffect(() => {
    function openSearch(event: KeyboardEvent) {
      if (isShortcutRecording(event.target) || !matchesShortcut(event, shortcuts.search)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      showSearch();
    }

    window.addEventListener("keydown", openSearch, true);
    return () => window.removeEventListener("keydown", openSearch, true);
  }, [showSearch, shortcuts.search]);

  useEffect(() => {
    function resizeInterface(event: KeyboardEvent) {
      if (isShortcutRecording(event.target)) return;

      const increase = matchesShortcut(event, shortcuts.zoomIn);
      const decrease = matchesShortcut(event, shortcuts.zoomOut);
      if (!increase && !decrease) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      setInterfaceZoom((currentZoom) => {
        return normalizeInterfaceZoom(
          currentZoom +
            (increase ? INTERFACE_ZOOM_STEP : -INTERFACE_ZOOM_STEP),
        );
      });
    }

    window.addEventListener("keydown", resizeInterface, true);
    return () => window.removeEventListener("keydown", resizeInterface, true);
  }, [shortcuts.zoomIn, shortcuts.zoomOut]);

  async function chooseWorkspace() {
    if (loading || choosingFolder) return;

    setChoosingFolder(true);
    setError(null);
    const operation = createOperation();
    let stage = "dialog";

    try {
      const selected = await open({
        title: "Choose diary folder",
        defaultPath: workspacePath ?? undefined,
        directory: true,
        multiple: false,
        recursive: false,
        canCreateDirectories: true,
        fileAccessMode: "scoped",
      });

      if (!selected || selected === workspacePath) {
        logEvent("debug", "workspace.open", { outcome: "cancelled", reason: selected ? "unchanged" : "dialog_cancelled" }, operation);
        return;
      }
      if (!(await flushPendingSave("workspace_change"))) return;

      stage = "load";
      if (!(await loadWorkspace(selected, "user", operation))) return;
      setDiaryCaptureRevealRequest(null);
      stage = "persist_preference";
      window.localStorage.setItem(WORKSPACE_KEY, selected);
    } catch (cause) {
      if (stage !== "load") logEvent("error", "workspace.open", { outcome: "failed", stage, errorCode: errorCode(cause) }, operation);
      setError(errorMessage(cause, "The diary folder could not be opened."));
    } finally {
      setChoosingFolder(false);
    }
  }

  function completeOnboarding() {
    if (!workspacePath || choosingFolder) return;
    try {
      window.localStorage.setItem(WORKSPACE_KEY, workspacePath);
      window.localStorage.setItem(ONBOARDING_KEY, "complete");
      setOnboardingPending(false);
      setOnboardingOpen(false);
    } catch (cause) {
      logEvent("warn", "runtime.failed", { boundary: "onboarding_complete", errorCode: errorCode(cause) });
      setError("Could not save setup. Please try again.");
    }
  }

  async function selectFile(file: MarkdownFile, source = "sidebar") {
    const operation = createOperation();
    const startedAt = performance.now();
    const noteId = privateAlias("note", file.path);
    const selectionId = fileSelectionSequenceRef.current + 1;
    fileSelectionSequenceRef.current = selectionId;
    setError(null);
    setDiaryCaptureRevealRequest(null);

    try {
      if (!(await flushPendingSave("note_open"))) return false;

      const fileContent = await readTextFile(file.path);
      if (fileSelectionSequenceRef.current !== selectionId) {
        logEvent("debug", "note.open", { outcome: "superseded", source, noteId }, operation);
        return false;
      }

      loadDiaryDocument(file, fileContent);
      logEvent("info", "note.open", { outcome: "success", source, noteId, durationMs: Math.round(performance.now() - startedAt) }, operation);
      return true;
    } catch (cause) {
      if (fileSelectionSequenceRef.current === selectionId) {
        logEvent("error", "note.open", { outcome: "failed", source, noteId, errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
        setError(errorMessage(cause, "The diary entry could not be opened."));
      }
      return false;
    }
  }

  async function openDiaryDate(dateKey: string, captureId?: string) {
    const file = files.find(
      (candidate) => candidate.diaryDate?.dateKey === dateKey,
    );

    if (!file) {
      logEvent("warn", "note.open", { outcome: "failed", source: "linked_date", reason: "note_missing" });
      setError("That diary entry is no longer available.");
      return;
    }

    if (!(await selectFile(file, "linked_date"))) return;

    if (captureId) {
      diaryCaptureRevealSequenceRef.current += 1;
      setDiaryCaptureRevealRequest({
        captureId,
        dateKey,
        requestId: diaryCaptureRevealSequenceRef.current,
      });
    }
    setActiveView("diary");
  }

  async function openDiarySearchResult(result: DiarySearchResult) {
    const file = filesRef.current.find(
      (candidate) => candidate.path === result.path,
    );

    if (!file) {
      logEvent("warn", "note.open", { outcome: "failed", source: "search", reason: "note_missing" });
      setError("That diary entry is no longer available.");
      return false;
    }

    if (selectedFileRef.current?.path === file.path) {
      setActiveView("diary");
      searchNavigatedRef.current = true;
      return true;
    }

    if (!(await selectFile(file, "search"))) return false;

    setActiveView("diary");
    searchNavigatedRef.current = true;
    return true;
  }

  async function openCapture(captureId: string) {
    if (!(await flushPendingSave("open_capture"))) return false;

    captureRevealSequenceRef.current += 1;
    setCaptureRevealRequest({
      captureId,
      requestId: captureRevealSequenceRef.current,
    });
    setActiveView("captures");
    return true;
  }

  async function openCaptureSearchResult(result: CaptureSearchResult) {
    const opened = await openCapture(result.captureId);
    if (opened) searchNavigatedRef.current = true;
    return opened;
  }

  async function createFile() {
    if (!workspacePath) return;

    setError(null);
    const operation = createOperation();
    const startedAt = performance.now();
    let stage = "prepare";
    let markdownCreated = false;

    try {
      if (!(await flushPendingSave("note_create"))) return;

      const name = dailyFileName(new Date());
      const path = await join(workspacePath, name);

      stage = "write";
      await writeTextFile(path, "", { createNew: true });
      markdownCreated = true;
      stage = "stat";
      const fileInfo = await stat(path);
      const file: MarkdownFile = {
        name,
        path,
        createdAt: fileInfo.birthtime ?? fileInfo.mtime ?? new Date(),
        modifiedAt: fileInfo.mtime ?? null,
        size: fileInfo.size,
        diaryDate: parseDiaryFileDate(name),
      };

      setFiles((currentFiles) => {
        const nextFiles = currentFiles.some(
          (currentFile) => currentFile.path === file.path,
        )
          ? currentFiles
          : [...currentFiles, file].sort(compareMarkdownFiles);
        filesRef.current = nextFiles;
        return nextFiles;
      });
      loadDiaryDocument(file);
      logEvent("info", "note.create", { outcome: "success", noteId: privateAlias("note", path), durationMs: Math.round(performance.now() - startedAt) }, operation);
    } catch (cause) {
      logEvent("error", "note.create", { outcome: "failed", stage, markdownCreated, errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startedAt) }, operation);
      setError(errorMessage(cause, "Today's diary entry could not be created."));
    }
  }

  function pasteIntoEditor(event: ClipboardEvent<HTMLDivElement>) {
    const pastedText = event.clipboardData.getData("text/plain");

    if (!isMarkdownTable(pastedText)) return;

    event.preventDefault();
    event.stopPropagation();
    editorRef.current?.insertMarkdown(pastedText);
  }

  function requireSearchNote(notePath: string) {
    const file = selectedFileRef.current;
    if (
      activeViewRef.current !== "diary" ||
      file?.path !== notePath ||
      !file.diaryDate ||
      !editorRef.current
    ) {
      throw new Error("That note is no longer open. Open it and try again.");
    }
    return file;
  }

  function queueNoteCaptureAction(
    kind: PendingNoteCaptureAction["kind"],
    result: CaptureSearchResult,
    notePath: string,
  ) {
    const operation = createOperation();
    let reason = "note_unavailable";
    try {
      requireSearchNote(notePath);
      const inNote = analyzeMarkdownSafely(contentRef.current).captureIds
        .includes(result.captureId);
      if (kind === "add") {
        reason = "already_present";
        if (inNote) throw new Error("That capture is already in this note.");
        reason = "capture_missing";
        if (!capturesRef.current.some((capture) => capture.captureId === result.captureId)) {
          throw new Error("That capture is no longer available.");
        }
      } else {
        reason = "reference_missing";
        if (!inNote) throw new Error("That capture is no longer in this note.");
      }
      pendingNoteCaptureActionRef.current = { kind, notePath, captureId: result.captureId, operation };
      logEvent("info", "capture.note_action", { action: kind, phase: "queued", noteId: privateAlias("note", notePath) }, operation);
      return true;
    } catch (cause) {
      logEvent("warn", "capture.note_action", { action: kind, phase: "queue", outcome: "rejected", reason, errorCode: errorCode(cause) }, operation);
      throw cause;
    }
  }

  function finishSearchClose() {
    if (searchOpenRef.current) return;
    const action = pendingNoteCaptureActionRef.current;
    const originPath = searchOriginPathRef.current;
    const originElement = searchOriginElementRef.current;
    pendingNoteCaptureActionRef.current = null;
    searchOriginPathRef.current = null;
    searchOriginElementRef.current = null;
    let failureReason = "note_unavailable";

    try {
      if (action) {
        const file = requireSearchNote(action.notePath);
        const inNote = analyzeMarkdownSafely(contentRef.current).captureIds
          .includes(action.captureId);
        setError(null);
        if (action.kind === "add") {
          failureReason = "already_present";
          if (inNote) throw new Error("That capture is already in this note.");
          failureReason = "capture_missing";
          const capture = capturesRef.current.find((item) => item.captureId === action.captureId);
          if (!capture) throw new Error("That capture is no longer available.");
          // The dialog's focus trap is gone before restoring the saved caret.
          // Collapsing a selection preserves text the user had highlighted.
          failureReason = "caret_unavailable";
          if (!paletteSelection.restore({ collapse: true })) {
            throw new Error("The editor is unavailable. Please try again.");
          }
          failureReason = "editor_insert";
          editorRef.current!.insertMarkdown(formatCaptureMarkdown(capture));
          logEvent("info", "capture.note_action", { action: "add", phase: "editor_insert", outcome: "success", persisted: false, noteId: privateAlias("note", action.notePath) }, action.operation);
        } else {
          failureReason = "reference_missing";
          if (!inNote) throw new Error("That capture is no longer in this note.");
          diaryCaptureRevealSequenceRef.current += 1;
          setDiaryCaptureRevealRequest({
            captureId: action.captureId,
            dateKey: file.diaryDate!.dateKey,
            requestId: diaryCaptureRevealSequenceRef.current,
            operation: action.operation,
          });
          logEvent("debug", "capture.note_action", { action: "reveal", phase: "requested" }, action.operation);
        }
      } else if (activeViewRef.current === "diary" && editorRef.current) {
        if (originPath === selectedFileRef.current?.path) {
          paletteSelection.restore();
        } else {
          editorRef.current.focus(undefined, { defaultSelection: "rootStart", preventScroll: true });
        }
      } else if (!searchNavigatedRef.current && originElement?.isConnected) {
        originElement.focus({ preventScroll: true });
      }
    } catch (cause) {
      logEvent("warn", "capture.note_action", { action: action?.kind ?? "restore_focus", phase: "execute", outcome: "failed", reason: failureReason, errorCode: errorCode(cause) }, action?.operation);
      setError(errorMessage(cause, "The capture could not be added."));
    }
  }

  function openEditorLink(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;

    const tag = event.target.closest<HTMLElement>(".diary-tag");
    if (
      tag &&
      event.currentTarget.contains(tag) &&
      !tag.closest("a[href], code")
    ) {
      event.preventDefault();
      event.stopPropagation();
      openTagSearch(tag.textContent ?? "");
      return;
    }

    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link || !event.currentTarget.contains(link)) return;

    const href = link.getAttribute("href") ?? "";
    const captureId = captureIdFromHref(href);
    if (captureId) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const url = normalizeExternalUrl(href);
    if (!url) return;

    event.preventDefault();
    event.stopPropagation();

    const operation = createOperation();
    const scheme = new URL(url).protocol;
    const opening = isTauri()
      ? openUrl(url)
      : Promise.resolve(window.open(url, "_blank", "noopener,noreferrer"));

    void opening.then(() => {
      logEvent("info", "external.open", { source: "editor", outcome: "success", scheme }, operation);
    }).catch((cause: unknown) => {
      logEvent("warn", "external.open", { source: "editor", outcome: "failed", scheme, errorCode: errorCode(cause) }, operation);
      const message = errorMessage(cause, "Unknown error");
      setError(`Could not open link: ${message}`);
    });
  }

  function scrollEntryFromAnywhere(event: WheelEvent<HTMLDivElement>) {
    const entryScroll = event.currentTarget.querySelector<HTMLElement>(
      ".diary-entry-scroll",
    );

    if (!entryScroll || entryScroll.contains(event.target as Node)) return;

    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? entryScroll.clientHeight
          : 1;

    entryScroll.scrollTop += event.deltaY * unit;
  }

  async function navigateToView(view: AppView) {
    if (activeView === view) return;

    if (
      activeView === "diary" &&
      !(await flushPendingSave(`view_${view}`))
    ) {
      return;
    }

    setActiveView(view);
  }

  function openTagSearch(tag: string) {
    showSearch(tagSearchQuery(tag));
  }

  function changeTheme(nextTheme: ThemePreferences) {
    writeTheme(nextTheme);
    setTheme(nextTheme);
  }

  return (
    <div
      className="relative flex h-screen overflow-hidden flex-col bg-background text-foreground"
      onWheel={scrollEntryFromAnywhere}
    >
      <header
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 h-10 bg-gradient-to-b from-background via-background/80 to-transparent select-none"
      >
        <div
          data-tauri-drag-region
          className="diary-frame flex h-full items-center justify-end gap-2 pr-3"
        >
          <nav aria-label="Main navigation" className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Diary"
              title="Diary"
              aria-current={activeView === "diary" ? "page" : undefined}
              onClick={() => void navigateToView("diary")}
              className={`grid size-7 place-items-center rounded-lg transition-colors ${
                activeView === "diary"
                  ? "bg-primary/10 text-primary/75"
                  : "text-primary/40 hover:bg-primary/5 hover:text-primary/65"
              }`}
            >
              <Pen aria-hidden="true" className="size-4" strokeWidth={1.6} />
            </button>
            <button
              type="button"
              aria-label="Captures"
              title="Captures"
              aria-current={activeView === "captures" ? "page" : undefined}
              onClick={() => void navigateToView("captures")}
              className={`grid size-7 place-items-center rounded-lg transition-colors ${
                activeView === "captures"
                  ? "bg-primary/10 text-primary/75"
                  : "text-primary/40 hover:bg-primary/5 hover:text-primary/65"
              }`}
            >
              <Archive aria-hidden="true" className="size-4" strokeWidth={1.6} />
            </button>
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              aria-current={activeView === "settings" ? "page" : undefined}
              onClick={() => void navigateToView("settings")}
              className={`grid size-7 place-items-center rounded-lg transition-colors ${
                activeView === "settings"
                  ? "bg-primary/10 text-primary/75"
                  : "text-primary/40 hover:bg-primary/5 hover:text-primary/65"
              }`}
            >
              <Settings aria-hidden="true" className="size-4" strokeWidth={1.6} />
            </button>
          </nav>
          <button
            type="button"
            aria-label="Search diary and captures"
            title={`Search (${formatShortcut(shortcuts.search)})`}
            onClick={() => showSearch()}
            className="grid size-7 place-items-center rounded-lg text-primary/40 transition-colors hover:bg-primary/5 hover:text-primary/65"
          >
            <Search aria-hidden="true" className="size-4" strokeWidth={1.6} />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={darkMode}
            aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`}
            onClick={() => changeTheme({ ...theme, darkMode: !darkMode })}
            className="inline-flex h-5 w-9 items-center rounded-full bg-primary/15 p-0.5 shadow-sm transition-colors hover:bg-primary/20"
          >
            <span
              aria-hidden="true"
              className={`size-4 rounded-full bg-background shadow-sm transition-transform ${
                darkMode ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </header>

      {activeView === "captures" ? (
        <CaptureArchive
          className="diary-entry-scroll flex-1 overflow-y-auto pt-10"
          captures={captureCollection.captures}
          shortcutStatus={captureCollection.shortcutStatus}
          loading={captureCollection.loading}
          captureDataReady={captureCollection.ready}
          loadError={captureCollection.error}
          onReload={captureCollection.reload}
          onCaptureUpdated={captureCollection.update}
          onCaptureDeleted={captureCollection.remove}
          onEditingChange={setCaptureArchiveEditing}
          diaryTargets={diaryTargets}
          onOpenDiaryDate={(dateKey, captureId) =>
            void openDiaryDate(dateKey, captureId)
          }
          onSearchTag={openTagSearch}
          revealRequest={captureRevealRequest}
          onRevealHandled={(request) =>
            setCaptureRevealRequest((current) =>
              current?.requestId === request.requestId ? null : current,
            )
          }
        />
      ) : activeView === "settings" ? (
        <SettingsPage
          className="diary-entry-scroll flex-1 overflow-y-auto pt-10"
          workspacePath={workspacePath}
          choosingFolder={loading || choosingFolder}
          themeId={themeId}
          error={error}
          onChooseFolder={() => void chooseWorkspace()}
          onThemeChange={(themeId) => changeTheme({ ...theme, themeId })}
        />
      ) : loading ? (
        <main className="grid flex-1 place-items-center text-sm text-muted-foreground">
          Loading…
        </main>
      ) : !workspacePath ? (
        <main className="grid flex-1 place-items-center p-8">
          <button
            type="button"
            disabled={choosingFolder}
            onClick={() => {
              if (onboardingPending) setOnboardingOpen(true);
              else void chooseWorkspace();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {choosingFolder ? "Choosing…" : "Choose folder"}
          </button>
        </main>
      ) : (
        <div className="diary-frame grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 pr-3">
          <main className="flex min-h-0 min-w-0 flex-col">
            {selectedFile ? (
              <div
                ref={diaryScrollRef}
                aria-busy={
                  diaryCaptureRevealRequest?.dateKey ===
                  selectedFile.diaryDate?.dateKey
                }
                style={
                  diaryCaptureRevealRequest?.dateKey ===
                  selectedFile.diaryDate?.dateKey
                    ? { visibility: "hidden" }
                    : undefined
                }
                className="diary-entry-scroll min-h-0 flex-1 overflow-y-auto"
              >
                <div className="diary-document-inset flex min-h-full w-full flex-col pt-[var(--diary-content-top)] pb-4">
                  <div className="flex shrink-0 items-baseline justify-between gap-4">
                    <span className="diary-entry-date diary-page-title block truncate text-foreground/80">
                      {formatMarkdownFileDate(selectedFile)}
                    </span>
                  </div>
                  <div
                    className="mt-6 flex flex-1"
                    onPasteCapture={pasteIntoEditor}
                    onClickCapture={openEditorLink}
                  >
                    <MDXEditor
                      key={selectedFile.path}
                      ref={editorRef}
                      markdown={content}
                      onChange={changeEditorContent}
                      onBlur={() => void flushPendingSave("blur")}
                      onError={({ error: editorError }) => {
                        diaryScrollRef.current?.style.removeProperty(
                          "visibility",
                        );
                        setDiaryCaptureRevealRequest(null);
                        logEvent("error", "editor.failed", { errorCode: errorCode(editorError), noteId: privateAlias("note", selectedFile.path) });
                        setError(editorError);
                      }}
                      plugins={editorPlugins}
                      lexicalTheme={EDITOR_LEXICAL_THEME}
                      spellCheck
                      className="diary-editor-root mdxeditor-full-height"
                      contentEditableClassName="diary-editor"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
                Select a Markdown file.
              </div>
            )}
            {error ? (
              <p
                role="alert"
                className="border-t px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
          </main>

          <DiarySidebar
            files={files}
            selectedPath={selectedFile?.path ?? null}
            canCreateToday={!hasTodayFile}
            onCreate={() => void createFile()}
            onSelect={(file) => void selectFile(file)}
          />
        </div>
      )}

      <UpdateNotice
        beforeInstall={flushPendingSave}
        onBusyChange={(busy) => { updateInstallingRef.current = busy; }}
        blockedReason={captureArchiveEditing
          ? "Save or cancel your capture edit before updating."
          : loading || choosingFolder ? "Wait for the diary folder to finish opening." : null}
      />
      <SearchDialog
        open={searchOpen}
        searchShortcut={shortcuts.search}
        initialQuery={searchInitialQuery}
        onOpenChange={changeSearchOpen}
        onAfterClose={finishSearchClose}
        currentNote={searchNote}
        onAddCapture={(result, notePath) => queueNoteCaptureAction("add", result, notePath)}
        onRevealNoteCapture={(result, notePath) => queueNoteCaptureAction("reveal", result, notePath)}
        diaryDocuments={searchCorpus.diaryDocuments}
        captureDocuments={searchCorpus.captureDocuments}
        diaryLoading={searchCorpus.diaryLoading}
        captureLoading={searchCorpus.captureLoading}
        diaryWarning={searchCorpus.diaryWarning}
        captureWarning={searchCorpus.captureWarning}
        onOpenDiary={openDiarySearchResult}
        onOpenCapture={openCaptureSearchResult}
      />
      <OnboardingDialog
        open={!loading && onboardingOpen}
        workspacePath={workspacePath}
        choosingFolder={choosingFolder}
        folderError={error}
        onChooseFolder={() => void chooseWorkspace()}
        onOpenChange={setOnboardingOpen}
        onComplete={completeOnboarding}
      />
    </div>
  );
}
