import { join } from "@tauri-apps/api/path";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { errorCode, logEvent, privateAlias } from "../diagnostics/logger";
import type { OperationContext } from "../diagnostics/operation";

import {
  formatLongDiaryDate,
  parseDiaryFileDate,
  type DiaryDate,
} from "../diaryDates";

export type MarkdownFile = {
  name: string;
  path: string;
  createdAt: Date;
  modifiedAt: Date | null;
  size: number;
  diaryDate: DiaryDate | null;
};

export function compareMarkdownFiles(
  left: MarkdownFile,
  right: MarkdownFile,
) {
  if (left.diaryDate && right.diaryDate) {
    return (
      right.diaryDate.dateKey.localeCompare(left.diaryDate.dateKey) ||
      right.name.localeCompare(left.name)
    );
  }

  if (left.diaryDate) return -1;
  if (right.diaryDate) return 1;

  return (
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.name.localeCompare(left.name)
  );
}

export function markdownFileDateParts(file: MarkdownFile) {
  if (file.diaryDate) {
    return {
      year: file.diaryDate.date.getUTCFullYear(),
      month: file.diaryDate.date.getUTCMonth() + 1,
      day: file.diaryDate.date.getUTCDate(),
    };
  }

  return {
    year: file.createdAt.getFullYear(),
    month: file.createdAt.getMonth() + 1,
    day: file.createdAt.getDate(),
  };
}

export function formatMarkdownFileDate(file: MarkdownFile) {
  if (file.diaryDate) return formatLongDiaryDate(file.diaryDate.date);

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(file.createdAt);
}

export function markdownDateAliases(file: MarkdownFile) {
  const { year, month, day } = markdownFileDateParts(file);
  const aliases = [
    `${day}/${month}`,
    `${day}/${month}/${year}`,
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  ];

  if (file.diaryDate) {
    aliases.push(
      new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(file.diaryDate.date),
    );
  }

  return aliases;
}

export function formatShortMonth(file: MarkdownFile) {
  const date = file.diaryDate?.date ?? file.createdAt;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    ...(file.diaryDate ? { timeZone: "UTC" } : {}),
  })
    .format(date)
    .toUpperCase();
}

export function dailyFileName(date: Date) {
  return `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}.md`;
}

export async function readMarkdownFiles(path: string, operation?: OperationContext) {
  const entries = await readDir(path);
  const markdownEntries = entries.filter(
    (entry) => entry.isFile && /\.(md|markdown)$/i.test(entry.name),
  );
  let firstStatErrorCode: string | undefined;

  const files = await Promise.all(
    markdownEntries.map(async (entry) => {
      const filePath = await join(path, entry.name);

      try {
        const fileInfo = await stat(filePath);

        return {
          name: entry.name,
          path: filePath,
          createdAt: fileInfo.birthtime ?? fileInfo.mtime ?? new Date(),
          modifiedAt: fileInfo.mtime ?? null,
          size: fileInfo.size,
          diaryDate: parseDiaryFileDate(entry.name),
        };
      } catch (cause) {
        firstStatErrorCode ??= errorCode(cause);
        return null;
      }
    }),
  );

  const skippedStatCount = files.filter((file) => file === null).length;
  if (skippedStatCount > 0) {
    logEvent("warn", "workspace.watch", { action: "list", outcome: "partial", skippedStatCount, errorCode: firstStatErrorCode, workspaceId: privateAlias("workspace", path) }, operation);
  }
  return files
    .filter((file): file is MarkdownFile => file !== null)
    .sort(compareMarkdownFiles);
}
