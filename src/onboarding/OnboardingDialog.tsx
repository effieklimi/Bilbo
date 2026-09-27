import * as Dialog from "@radix-ui/react-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  isCaptureAccessibilityTrusted,
  openAccessibilitySettings,
} from "../capture/api";

type OnboardingDialogProps = {
  open: boolean;
  workspacePath: string | null;
  choosingFolder: boolean;
  folderError: string | null;
  onChooseFolder: () => void;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
};

const buttonClassName = "shrink-0 rounded-lg bg-primary/[0.06] px-2.5 py-1.5 leading-5 text-foreground/75 transition-colors enabled:hover:bg-primary/[0.1] enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50";
const actionClassName = `${buttonClassName} text-xs`;
const footerActionClassName = `${buttonClassName} text-sm`;

export default function OnboardingDialog({
  open,
  workspacePath,
  choosingFolder,
  folderError,
  onChooseFolder,
  onOpenChange,
  onComplete,
}: OnboardingDialogProps) {
  const native = isTauri();
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [openingSettings, setOpeningSettings] = useState(false);
  const actionEpoch = useRef(0);
  const openingSettingsRef = useRef(false);
  const openRef = useRef(open);
  const folderButtonRef = useRef<HTMLButtonElement>(null);
  openRef.current = open;
  const busy = choosingFolder || openingSettings;

  useEffect(() => {
    const epoch = ++actionEpoch.current;
    openingSettingsRef.current = false;
    setOpeningSettings(false);
    setTrusted(null);
    setPermissionError(null);
    setSettingsError(null);
    if (!open || !native) return () => { actionEpoch.current += 1; };

    let checking = false;
    async function refreshPermission() {
      if (checking) return;
      checking = true;
      try {
        const granted = await isCaptureAccessibilityTrusted();
        if (epoch !== actionEpoch.current || !openRef.current) return;
        setTrusted(granted);
        setPermissionError(null);
      } catch {
        if (epoch !== actionEpoch.current || !openRef.current) return;
        setTrusted(null);
        setPermissionError("Could not check capture access. Try opening Settings.");
      } finally {
        checking = false;
      }
    }

    void refreshPermission();
    const interval = window.setInterval(() => { void refreshPermission(); }, 1500);
    window.addEventListener("focus", refreshPermission);
    return () => {
      actionEpoch.current += 1;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshPermission);
    };
  }, [native, open]);

  async function showAccessibilitySettings() {
    if (!native || !openRef.current || choosingFolder || openingSettingsRef.current) return;
    const epoch = actionEpoch.current;
    openingSettingsRef.current = true;
    setOpeningSettings(true);
    setSettingsError(null);
    try {
      await openAccessibilitySettings();
    } catch {
      if (epoch === actionEpoch.current && openRef.current) {
        setSettingsError("Could not open Accessibility settings. Please try again.");
      }
    } finally {
      if (epoch === actionEpoch.current) {
        openingSettingsRef.current = false;
        setOpeningSettings(false);
      }
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && (choosingFolder || openingSettingsRef.current)) return;
    onOpenChange(nextOpen);
  }

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/40" />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            if (folderButtonRef.current && !folderButtonRef.current.disabled) {
              event.preventDefault();
              folderButtonRef.current.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            if (choosingFolder || openingSettingsRef.current || event.isComposing) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (choosingFolder || openingSettingsRef.current) event.preventDefault();
          }}
          onFocusOutside={(event) => event.preventDefault()}
          className="fixed top-1/2 left-1/2 z-[91] flex max-h-[calc(100vh-6rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/[0.09] outline-none"
        >
          <div className="shrink-0 px-6 pt-6 pb-3">
            <Dialog.Title className="font-heading text-[22px] leading-7 font-medium text-foreground/90">
              Before you get started
            </Dialog.Title>
          </div>
          <Dialog.Description className="sr-only">
            Choose a folder for your diary. Capture access is optional and can be enabled later in Settings.
          </Dialog.Description>
          <div className="diary-entry-scroll min-h-0 overflow-y-auto px-6 pb-3">
            <div className="flex items-center gap-3 py-3">
              <span aria-hidden="true" className="w-6 shrink-0 text-center font-heading text-[36px] leading-none text-foreground/35 tabular-nums">1</span>
              <p className="min-w-0 flex-1 text-[17px] leading-6 text-foreground/90">Pick your diary folder</p>
              <button
                ref={folderButtonRef}
                type="button"
                title={workspacePath ?? undefined}
                disabled={!native || busy}
                aria-busy={choosingFolder}
                onClick={onChooseFolder}
                className={actionClassName}
              >
                {choosingFolder ? "Choosing…" : workspacePath ? "Change" : "Choose folder"}
              </button>
            </div>
            {folderError ? <p role="alert" className="pb-2 text-xs leading-5 text-destructive">{folderError}</p> : null}

            <div className="flex items-center gap-3 py-3">
              <span aria-hidden="true" className="w-6 shrink-0 text-center font-heading text-[36px] leading-none text-foreground/35 tabular-nums">2</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[17px] leading-6 text-foreground/90">
                  Give access for captures
                </p>
              </div>
              {native && trusted ? (
                <span role="status" className="inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs leading-5 text-foreground/60">
                  <Check aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
                  Enabled
                </span>
              ) : (
                <button
                  type="button"
                  disabled={!native || busy}
                  aria-busy={openingSettings}
                  onClick={() => { void showAccessibilitySettings(); }}
                  className={actionClassName}
                >
                  {openingSettings ? "Opening…" : "Open Settings"}
                </button>
              )}
            </div>
            {settingsError || permissionError ? (
              <p role="alert" className="pb-2 text-xs leading-5 text-destructive">{settingsError ?? permissionError}</p>
            ) : null}
            {!native ? (
              <p className="pb-2 text-xs leading-5 text-muted-foreground">Folder and capture access are available in the desktop app.</p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-foreground/[0.07] px-4 py-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => changeOpen(false)}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm leading-5 text-destructive transition-colors enabled:hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/30 disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              disabled={!workspacePath || busy}
              onClick={onComplete}
              className={footerActionClassName}
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
