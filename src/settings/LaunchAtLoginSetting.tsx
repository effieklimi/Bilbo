import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "../errors";
import { createOperation, invokeWithOperation } from "../diagnostics/operation";
import { errorCode, logEvent, updateDiagnosticState } from "../diagnostics/logger";

export default function LaunchAtLoginSetting() {
  const native = isTauri();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState<string | null>(null);
  const [registrationKnown, setRegistrationKnown] = useState(false);
  const requestRef = useRef(0);
  const changingRef = useRef(false);
  const mountedRef = useRef(false);
  const observedEnabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (!native) return () => { mountedRef.current = false; };

    async function refresh() {
      if (changingRef.current) return;
      const request = ++requestRef.current;
      const operation = createOperation();
      const started = performance.now();
      // Keep an already loaded switch usable while focus refreshes its state.
      try {
        const current = await invokeWithOperation<boolean>("get_launch_at_login", {}, operation);
        if (request !== requestRef.current) return;
        if (observedEnabledRef.current !== current) {
          logEvent("info", "settings.change", { setting: "launch_at_login", action: "read", enabled: current, outcome: "success", durationMs: Math.round(performance.now() - started) }, operation);
          observedEnabledRef.current = current;
        }
        setEnabled(current);
        setRegistrationKnown(true);
        setLoaded(true);
        setError(null);
      } catch (cause) {
        logEvent("error", "settings.change", { setting: "launch_at_login", action: "read", outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - started) }, operation);
        observedEnabledRef.current = null;
        if (request === requestRef.current) {
          setRegistrationKnown(false);
          setError(errorMessage(cause, "Could not check Launch at login."));
        }
      } finally {
        if (request === requestRef.current) setBusy(false);
      }
    }

    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      window.removeEventListener("focus", refresh);
    };
  }, [native]);

  useEffect(() => {
    updateDiagnosticState("launchAtLogin", { enabled: registrationKnown ? enabled : null, status: !native ? "unavailable" : registrationKnown ? "available" : "unknown", inProgress: busy });
  }, [enabled, registrationKnown, native, busy]);

  async function toggle() {
    if (!native || !loaded || busy || changingRef.current) return;
    requestRef.current += 1;
    changingRef.current = true;
    setBusy(true);
    setError(null);
    const operation = createOperation();
    const started = performance.now();
    const requested = !enabled;
    logEvent("info", "settings.change", { setting: "launch_at_login", action: "set", requestedEnabled: requested, outcome: "started" }, operation);
    try {
      const current = await invokeWithOperation<boolean>("set_launch_at_login", { enabled: requested }, operation);
      observedEnabledRef.current = current;
      logEvent("info", "settings.change", { setting: "launch_at_login", action: "set", enabled: current, requestedEnabled: requested, outcome: "success", durationMs: Math.round(performance.now() - started) }, operation);
      if (mountedRef.current) {
        setEnabled(current);
        setRegistrationKnown(true);
      }
    } catch (cause) {
      logEvent("error", "settings.change", { setting: "launch_at_login", action: "set", requestedEnabled: requested, outcome: "failed", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - started) }, operation);
      if (mountedRef.current) setError(errorMessage(cause, "Could not change Launch at login."));
      // Re-read the OS setting if registration changed before an error occurred.
      try {
        const current = await invokeWithOperation<boolean>("get_launch_at_login", {}, operation);
        observedEnabledRef.current = current;
        logEvent("info", "settings.change", { setting: "launch_at_login", action: "readback_after_failure", enabled: current, requestedEnabled: requested, outcome: "success" }, operation);
        if (mountedRef.current) {
          setEnabled(current);
          setRegistrationKnown(true);
        }
      } catch (cause) {
        observedEnabledRef.current = null;
        logEvent("error", "settings.change", { setting: "launch_at_login", action: "readback_after_failure", outcome: "failed", errorCode: errorCode(cause) }, operation);
        if (mountedRef.current) {
          setLoaded(false);
          setRegistrationKnown(false);
        }
      }
    } finally {
      changingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <section aria-labelledby="launch-at-login-label" className="mt-8">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <span id="launch-at-login-label" className="diary-supporting-text text-foreground/75">
          Launch at login
        </span>
        <button
          type="button"
          role="switch"
          aria-labelledby="launch-at-login-label"
          aria-checked={enabled}
          aria-busy={busy}
          aria-describedby={error ? "launch-at-login-error" : undefined}
          disabled={!native || !loaded || busy}
          onClick={() => { void toggle(); }}
          className="grid size-11 shrink-0 place-items-center rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className={`inline-flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${enabled ? "bg-primary/75" : "bg-primary/15"}`}
          >
            <span className={`size-4 rounded-full bg-background transition-transform motion-reduce:transition-none ${enabled ? "translate-x-4" : "translate-x-0"}`} />
          </span>
        </button>
      </div>
      {error ? <p id="launch-at-login-error" role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
