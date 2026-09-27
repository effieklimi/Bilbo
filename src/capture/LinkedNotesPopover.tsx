import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";

import type { DiaryDate } from "../diaryDates";
import { linkedDiaryDateLabel } from "./dateLinks";

type LinkedNotesPopoverProps = {
  dateKeys: string[];
  targetsByDate: ReadonlyMap<string, DiaryDate>;
  onOpenDate: (dateKey: string) => void;
};

export default function LinkedNotesPopover({
  dateKeys,
  targetsByDate,
  onOpenDate,
}: LinkedNotesPopoverProps) {
  const [open, setOpen] = useState(false);

  if (dateKeys.length === 0) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-foreground/60 transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
        >
          In {dateKeys.length} {dateKeys.length === 1 ? "note" : "notes"}
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="Notes containing this capture"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] max-h-[min(16rem,var(--radix-popover-content-available-height))] w-max min-w-32 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-lg bg-background p-1 font-sans text-[11px] leading-4 text-foreground/80 ring-1 ring-foreground/[0.08] outline-none"
        >
          <ul>
            {dateKeys.map((dateKey) => {
              const target = targetsByDate.get(dateKey);

              return (
                <li key={dateKey}>
                  <button
                    type="button"
                    disabled={!target}
                    title={target ? undefined : "This note is unavailable."}
                    onClick={() => {
                      setOpen(false);
                      onOpenDate(dateKey);
                    }}
                    className="w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.04] focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    {linkedDiaryDateLabel(dateKey, target)}
                    {!target ? <span className="sr-only"> (unavailable)</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
