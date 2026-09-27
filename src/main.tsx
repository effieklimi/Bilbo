import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { readInterfaceZoom } from "./interfaceZoom.ts";
import { errorCode, initializeDiagnostics, logEvent } from "./diagnostics/logger";
import { createOperation } from "./diagnostics/operation";
import { applyTheme, readTheme } from "./theme.ts";
import "./index.css";

const captureWindow = isTauri() && getCurrentWindow().label === "capture";
initializeDiagnostics(captureWindow ? "capture" : "main");
const startupOperation = createOperation();
const startupStarted = performance.now();

async function mount() {
  logEvent("info", "runtime.mount", { stage: "started", native: isTauri() }, startupOperation);
  applyTheme(readTheme());
  if (isTauri() && !captureWindow) {
    try {
      await getCurrentWebview().setZoom(readInterfaceZoom());
    } catch (cause) {
      logEvent("error", "runtime.failed", { stage: "zoom_restore", errorCode: errorCode(cause) }, startupOperation);
    }
  }

  const { default: RootView } = captureWindow
    ? await import("./capture/CaptureWindow.tsx")
    : await import("./App.tsx");

  const container = document.getElementById("root");
  if (!container) {
    logEvent("error", "runtime.failed", { stage: "mount", errorCode: "root_missing" }, startupOperation);
    return;
  }
  createRoot(container, {
    onUncaughtError: (cause) => {
      logEvent("error", "runtime.failed", { stage: "react_render", errorCode: errorCode(cause) });
    },
    onCaughtError: (cause) => {
      logEvent("error", "runtime.failed", { stage: "react_boundary", errorCode: errorCode(cause) });
    },
    onRecoverableError: (cause) => {
      logEvent("warn", "runtime.failed", { stage: "react_recovered", errorCode: errorCode(cause) });
    },
  }).render(
    <StrictMode>
      <RootView />
    </StrictMode>,
  );
  logEvent("info", "runtime.mount", { stage: "render_requested", durationMs: Math.round(performance.now() - startupStarted) }, startupOperation);
}

void mount().catch((cause) => {
  logEvent("error", "runtime.failed", { stage: "mount_or_import", errorCode: errorCode(cause), durationMs: Math.round(performance.now() - startupStarted) }, startupOperation);
});
