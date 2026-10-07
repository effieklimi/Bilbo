import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, FolderOpen } from "lucide-react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { version as appVersion } from "../../package.json";

import { THEMES, type ThemeId } from "../themes";
import { logEvent, updateDiagnosticState } from "../diagnostics/logger";
import { createOperation } from "../diagnostics/operation";
import type { UpdateCheckStatus } from "../updates/UpdateNotice";
import CaptureSettings from "./CaptureSettings";
import KeyboardShortcutsSettings from "./KeyboardShortcutsSettings";
import LaunchAtLoginSetting from "./LaunchAtLoginSetting";
import LogsPage from "./LogsPage";

type SettingsPageProps = {
  className?: string;
  workspacePath: string | null;
  choosingFolder: boolean;
  themeId: ThemeId;
  error: string | null;
  onChooseFolder: () => void;
  onThemeChange: (themeId: ThemeId) => void;
  updateCheckStatus: UpdateCheckStatus;
  onCheckForUpdates: () => void;
};

export default function SettingsPage({
  className = "",
  workspacePath,
  choosingFolder,
  themeId,
  error,
  onChooseFolder,
  onThemeChange,
  updateCheckStatus,
  onCheckForUpdates,
}: SettingsPageProps) {
  const [showLogs, setShowLogs] = useState(false);
  const viewLogsButtonRef = useRef<HTMLButtonElement>(null);
  const restoreLogsFocusRef = useRef(false);

  useEffect(() => {
    updateDiagnosticState("settings", { themeId, folderSelected: workspacePath !== null, choosingFolder, logsVisible: showLogs });
  }, [themeId, workspacePath, choosingFolder, showLogs]);

  useEffect(() => {
    if (!showLogs && restoreLogsFocusRef.current) {
      viewLogsButtonRef.current?.focus();
      restoreLogsFocusRef.current = false;
    }
  }, [showLogs]);

  if (showLogs) {
    return (
      <LogsPage
        className={className}
        onBack={() => {
          logEvent("debug", "settings.change", { setting: "logs_view", enabled: false });
          restoreLogsFocusRef.current = true;
          setShowLogs(false);
        }}
      />
    );
  }

  return (
    <section
      aria-labelledby="settings-heading"
      className={`min-h-0 bg-background text-foreground ${className}`}
    >
      <div className="diary-frame">
        <div className="px-20 pt-8 pb-12 max-[35rem]:px-8">
          <h2 id="settings-heading" className="diary-page-title">
            Settings
          </h2>

          <section aria-labelledby="diary-folder-heading" className="mt-8">
            <h3
              id="diary-folder-heading"
              className="diary-section-title text-foreground/65"
            >
              Diary folder
            </h3>
            <div className="mt-3 flex items-center gap-3 rounded-xl bg-primary/[0.08] px-4 py-3 ring-1 ring-transparent dark:bg-primary/[0.12] dark:ring-foreground/[0.07]">
              <FolderOpen
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground/70"
                strokeWidth={1.5}
              />
              <p
                title={workspacePath ?? undefined}
                aria-live="polite"
                className="diary-supporting-text min-w-0 flex-1 truncate text-foreground/65"
              >
                {workspacePath ?? "No folder selected"}
              </p>
              <button
                type="button"
                disabled={choosingFolder}
                aria-busy={choosingFolder}
                onClick={onChooseFolder}
                className="diary-supporting-text shrink-0 rounded-lg px-3 py-1.5 text-foreground/75 transition-colors enabled:hover:bg-primary/[0.06] enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50"
              >
                {choosingFolder
                  ? "Choosing…"
                  : workspacePath
                    ? "Change folder"
                    : "Choose folder"}
              </button>
            </div>
            {error ? (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="theme-heading" className="mt-8">
            <h3
              id="theme-heading"
              className="diary-section-title text-foreground/65"
            >
              Theme
            </h3>
            <fieldset className="mt-3 flex flex-wrap gap-2">
              <legend className="sr-only">Color theme</legend>
              <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
                {THEMES.map((theme) => (
                  <Tooltip.Root key={theme.id}>
                    <div className="group relative grid size-10 place-items-center">
                      <Tooltip.Trigger asChild>
                        <input
                          type="radio"
                          name="color-theme"
                          aria-label={theme.name}
                          value={theme.id}
                          checked={themeId === theme.id}
                          onChange={() => {
                            const operation = createOperation();
                            logEvent("info", "settings.change", { setting: "theme", previousThemeId: themeId, themeId: theme.id, outcome: "requested" }, operation);
                            onThemeChange(theme.id);
                          }}
                          className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0"
                        />
                      </Tooltip.Trigger>
                      <span
                        aria-hidden="true"
                        className="size-7 rounded-full outline-offset-4 transition-transform group-hover:scale-105 peer-checked:outline peer-checked:outline-1 peer-checked:outline-foreground/45 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-foreground motion-reduce:transition-none"
                      >
                        <span
                          data-theme={theme.id}
                          className="theme-swatch grid size-full place-items-center rounded-full bg-primary text-primary-foreground"
                        >
                          {themeId === theme.id ? (
                            <Check className="size-3.5" strokeWidth={2} />
                          ) : null}
                        </span>
                      </span>
                    </div>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="bottom"
                        sideOffset={6}
                        collisionPadding={12}
                        className="z-[80] rounded-lg bg-popover px-2.5 py-2 text-[11px] leading-4 text-popover-foreground ring-1 ring-foreground/[0.08]"
                      >
                        {theme.name}
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                ))}
              </Tooltip.Provider>
            </fieldset>
          </section>
          <KeyboardShortcutsSettings />
          <CaptureSettings />
          <LaunchAtLoginSetting />
          <button
            ref={viewLogsButtonRef}
            type="button"
            onClick={() => {
              logEvent("debug", "settings.change", { setting: "logs_view", enabled: true });
              setShowLogs(true);
            }}
            className="diary-supporting-text mt-8 inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary/[0.08] px-3 py-2 text-foreground/75 transition-colors hover:bg-primary/[0.12] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
          >
            View logs
            <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          </button>
          <footer aria-label="App version and updates" className="diary-meta-text mt-8 text-foreground/40">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>v{appVersion}</span>
              <button
                type="button"
                onClick={onCheckForUpdates}
                disabled={updateCheckStatus === "checking" || updateCheckStatus === "unavailable"}
                aria-busy={updateCheckStatus === "checking"}
                title={updateCheckStatus === "unavailable" ? "Update checks are available in the installed app." : undefined}
                className="rounded-lg px-2.5 py-1.5 text-foreground/60 transition-colors enabled:hover:bg-primary/[0.06] enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50"
              >
                {updateCheckStatus === "checking" ? "Checking…" : "Check for updates"}
              </button>
            </div>
            <p role="status" className={updateCheckStatus === "error" ? "text-destructive" : "text-foreground/60"}>
              {updateCheckStatus === "up-to-date" ? "You're up to date."
                : updateCheckStatus === "available" ? "An update is available."
                : updateCheckStatus === "error" ? "Could not check for updates. Please try again."
                : null}
            </p>
          </footer>
        </div>
      </div>
    </section>
  );
}
