import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { copyDebugReport, readLogs, type LogPage, type DiagnosticRecord } from "../diagnostics/logger";

type LogsPageProps = { className?: string; onBack: () => void };
function readableLabel(value: string) {
  return value.replace(/[._]+/g, " ");
}

function logMessage(record: DiagnosticRecord) {
  const label = readableLabel(record.event);
  const phase = record.fields.action ?? record.fields.phase ?? record.fields.stage;
  const outcome = record.fields.outcome ?? record.fields.status;
  const context = typeof phase === "string" && !label.endsWith(readableLabel(phase))
    ? ` (${readableLabel(phase)})` : "";
  const result = typeof outcome === "string" && !label.endsWith(readableLabel(outcome))
    ? `: ${readableLabel(outcome)}` : "";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}${context}${result}`;
}

function LogEntry({ record }: { record: DiagnosticRecord }) {
  const date = new Date(record.timestamp);
  const timestamp = date.toISOString();
  const time = date.toLocaleTimeString("en-GB", { hour12: false });
  const level = record.level.toUpperCase();
  const category = `[${record.event.split(".")[0]}]`;
  const columnGap = " ";
  const indent = " ".repeat(time.length + level.length + category.length + columnGap.length * 3);
  const metadata = {
    fields: record.fields,
    timestamp,
    event: record.event,
    origin: record.origin,
    sessionId: record.sessionId,
    operationId: record.operationId,
  };

  return (
    <span className="block min-w-max">{/* Details align with this entry's message without padding the columns. */}
      <time dateTime={timestamp} title={timestamp} className="text-foreground/60">{time}</time>
      {columnGap}<span className={record.level === "error" ? "text-destructive" : "text-foreground/75"}>{level}</span>
      {columnGap}<span className="text-primary">{category}</span>
      {columnGap}{logMessage(record)}
      {"\n"}{indent}<span className="text-foreground/65">{JSON.stringify(metadata)}</span>
    </span>
  );
}

const actionClass = "diary-supporting-text inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-2 text-foreground/65 transition-colors hover:bg-primary/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50";

export default function LogsPage({ className = "", onBack }: LogsPageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [page, setPage] = useState<LogPage | null>(null);
  const [includeDebug, setIncludeDebug] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const resetCopyRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    headingRef.current?.focus();
    return () => clearTimeout(resetCopyRef.current);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await readLogs(includeDebug);
        if (!disposed) { setPage(next); setLoadError(false); }
      } catch { if (!disposed) setLoadError(true); }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 2_000); }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [includeDebug]);

  async function copy() {
    clearTimeout(resetCopyRef.current);
    setCopyStatus("copying");
    try {
      await copyDebugReport();
      setCopyStatus("copied");
      resetCopyRef.current = setTimeout(() => setCopyStatus("idle"), 3_000);
    } catch { setCopyStatus("failed"); }
  }

  return (
    <section aria-labelledby="logs-heading" className={`min-h-0 bg-background text-foreground ${className}`}>
      <div className="diary-frame">
        <div className="px-20 pt-8 pb-12 max-[35rem]:px-8">
          <div className="flex items-center justify-between gap-4">
            <h2 ref={headingRef} id="logs-heading" tabIndex={-1} className="diary-page-title outline-none">Logs</h2>
            <button type="button" onClick={onBack} className={actionClass}>
              <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />Back to settings
            </button>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <label className="diary-supporting-text inline-flex cursor-pointer items-center gap-2 text-foreground/65">
              <input type="checkbox" checked={includeDebug} onChange={event => setIncludeDebug(event.target.checked)} className="size-3.5 accent-primary" />Show debug
            </label>
            <button type="button" onClick={() => void copy()} disabled={copyStatus === "copying"} className={`${actionClass} bg-primary/[0.08]`}>
              {copyStatus === "copied" ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
              {copyStatus === "copying" ? "Collecting…" : copyStatus === "copied" ? "Copied" : "Copy debug report"}
            </button>
          </div>
          <p role="status" aria-live="polite" className="diary-supporting-text mt-3 text-foreground/60">
            {copyStatus === "failed" ? "Could not copy the report. Try again." : loadError ? "Could not load logs. Retrying…" : page?.storageError ? "Logs are available in memory. Saving the log history is currently unavailable." : ""}
          </p>
          {page && page.records.length > 0 ? (
            <p className="diary-supporting-text mt-4 mb-3 text-foreground/45">Latest {page.records.length} events · Report includes up to {page.retainedLimit.toLocaleString()}</p>
          ) : null}
          <pre
            aria-label="Diagnostic logs"
            tabIndex={0}
            className="mt-4 max-h-[65vh] min-h-40 overflow-auto whitespace-pre break-normal rounded-xl border border-foreground/[0.07] bg-primary/[0.08] p-5 font-mono dark:bg-primary/[0.12] text-xs leading-6 text-foreground/75 outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
          >
            <code>{page?.records.length
              ? page.records.map(record => <LogEntry key={record.id} record={record} />)
              : loadError ? "Could not load logs. Retrying…" : page ? "No logs yet." : "Loading logs…"}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}
