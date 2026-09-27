import { isTauri } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  isCaptureAccessibilityTrusted,
  openAccessibilitySettings,
} from "../capture/api";
import { errorMessage } from "../errors";
import { createOperation } from "../diagnostics/operation";
import { updateDiagnosticState } from "../diagnostics/logger";

const actionClassName = "diary-supporting-text rounded-lg px-3 py-1.5 text-foreground/75 transition-colors enabled:hover:bg-primary/[0.06] enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50";

export default function CaptureSettings() {
  const native = isTauri();
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [openingSettings, setOpeningSettings] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    if (!native) return () => { mountedRef.current = false; };

    let disposed = false;
    let checkingPermission = false;

    async function refreshPermission() {
      if (checkingPermission) return;
      checkingPermission = true;
      try {
        const granted = await isCaptureAccessibilityTrusted();
        if (!disposed) {
          setTrusted(granted);
          setPermissionError(null);
        }
      } catch (cause) {
        if (!disposed) setPermissionError(errorMessage(cause, "Could not check Accessibility access."));
      } finally {
        checkingPermission = false;
      }
    }

    void refreshPermission();
    const interval = window.setInterval(() => { void refreshPermission(); }, 1500);
    window.addEventListener("focus", refreshPermission);
    return () => {
      disposed = true;
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshPermission);
    };
  }, [native]);

  useEffect(() => {
    updateDiagnosticState("captureSettings", {
      native,
      permissionStatus: !native ? "unavailable" : permissionError ? "unavailable" : trusted === null ? "unknown" : trusted ? "trusted" : "not_trusted",
    });
  }, [native, permissionError, trusted]);

  async function showAccessibilitySettings() {
    const operation = createOperation();
    setOpeningSettings(true);
    setPermissionError(null);
    try {
      await openAccessibilitySettings(operation);
    } catch (cause) {
      if (mountedRef.current) setPermissionError(errorMessage(cause, "Could not open Accessibility settings."));
    } finally {
      if (mountedRef.current) setOpeningSettings(false);
    }
  }

  return (
    <section aria-labelledby="capture-settings-heading" className="mt-8">
      <h3 id="capture-settings-heading" className="diary-section-title text-foreground/65">
        Capture
      </h3>
      <div className="mt-3">
        <div className="flex min-h-11 items-center justify-between gap-4">
          <span className="diary-supporting-text text-foreground/75">Accessibility</span>
          <div className="flex items-center gap-3">
            <span aria-live="polite" className="diary-supporting-text inline-flex items-center gap-1.5 text-muted-foreground">
              {native && trusted ? <Check aria-hidden="true" className="size-3.5" strokeWidth={1.5} /> : null}
              {!native ? "Unavailable" : trusted === null ? "Checking…" : trusted ? "Enabled" : "Not enabled"}
            </span>
            <button
              type="button"
              disabled={!native || openingSettings}
              onClick={() => { void showAccessibilitySettings(); }}
              className={`${actionClassName} bg-primary/[0.06]`}
            >
              {openingSettings ? "Opening…" : "Open Settings"}
            </button>
          </div>
        </div>
        {permissionError ? <p role="alert" className="mt-1 text-xs text-destructive">{permissionError}</p> : null}
      </div>
    </section>
  );
}
