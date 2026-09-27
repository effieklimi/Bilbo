import { Plus } from "lucide-react";

import {
  formatMarkdownFileDate,
  formatShortMonth,
  markdownFileDateParts,
  type MarkdownFile,
} from "./files";

type DiarySidebarProps = {
  files: readonly MarkdownFile[];
  selectedPath: string | null;
  canCreateToday: boolean;
  onCreate: () => void;
  onSelect: (file: MarkdownFile) => void;
};

export default function DiarySidebar({
  files,
  selectedPath,
  canCreateToday,
  onCreate,
  onSelect,
}: DiarySidebarProps) {
  const visibleFiles = files.slice(0, 7);

  return (
    <aside className="mt-[var(--diary-content-top)] self-start overflow-hidden rounded-xl bg-primary/[0.08] p-1.5">
      <nav className="flex flex-col overflow-y-auto">
        <button
          type="button"
          aria-label="Create Markdown file"
          disabled={!canCreateToday}
          onClick={onCreate}
          className="mb-0.5 grid size-[38px] self-center place-items-center rounded-lg text-muted-foreground/55 transition-colors enabled:hover:bg-primary/5 enabled:hover:text-foreground/70 disabled:opacity-40"
        >
          <Plus aria-hidden="true" className="size-[15px]" strokeWidth={1.5} />
        </button>
        {visibleFiles.map((file, index) => {
          const previousFile = visibleFiles[index - 1];
          const fileDate = markdownFileDateParts(file);
          const previousFileDate = previousFile
            ? markdownFileDateParts(previousFile)
            : null;
          const startsNewMonth =
            previousFileDate !== null &&
            (previousFileDate.month !== fileDate.month ||
              previousFileDate.year !== fileDate.year);
          const formattedDate = formatMarkdownFileDate(file);
          const isSelected = selectedPath === file.path;

          return (
            <div key={file.path} className="flex flex-col items-center">
              {startsNewMonth ? (
                <span className="diary-meta-text mt-0.5 py-1 font-sans tracking-wider text-primary/30">
                  {formatShortMonth(file)}
                </span>
              ) : null}
              <button
                type="button"
                title={formattedDate}
                aria-label={`Open ${formattedDate}`}
                aria-current={isSelected ? "page" : undefined}
                onClick={() => onSelect(file)}
                className={`grid size-[38px] place-items-center rounded-lg font-heading transition-colors ${
                  isSelected
                    ? "text-[15px] font-bold text-foreground"
                    : "text-[14px] font-normal text-muted-foreground/70 hover:bg-primary/5 hover:text-foreground/70"
                }`}
              >
                {fileDate.day}
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
