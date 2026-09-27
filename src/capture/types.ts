import type { OperationContext } from "../diagnostics/operation";

export type CaptureDraft = {
  draftId: string;
  operation: OperationContext;
  selectedText: string;
  note: string;
  sourceApp: string | null;
  sourceBundleId: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  captureMethod: "accessibility" | "clipboard" | "none";
  captureError: string | null;
  permissionRequired: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SavedCapture = {
  captureId: string;
  selectedText: string;
  note: string;
  sourceApp: string | null;
  sourceBundleId: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  captureMethod: "accessibility" | "clipboard" | "none";
  createdAt: number;
  updatedAt: number;
  savedAt: number;
  assignedDates: string[];
};

export type CaptureReferenceIndexEntry = {
  diaryDate: string;
  captureIds: string[];
};

export type CaptureShortcutStatus = {
  shortcut: string;
  available: boolean;
  error: string | null;
};
