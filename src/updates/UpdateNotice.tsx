import * as Dialog from "@radix-ui/react-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { errorCode, logEvent } from "../diagnostics/logger";

const HOUR = 60 * 60 * 1000;
const buttonClassName = "shrink-0 rounded-lg px-2.5 py-1.5 text-xs leading-5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20";

export default function UpdateNotice({ beforeInstall, onBusyChange, blockedReason }: {
  beforeInstall: (action: string) => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
  blockedReason: string | null;
}) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Preparing update…");
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);
  const installedRef = useRef(false);

  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    let disposed = false;
    let checking = false;

    async function checkForUpdate() {
      if (checking || busyRef.current || installedRef.current) return;
      checking = true;
      try {
        const next = await check({ timeout: 15_000 });
        if (disposed || busyRef.current) {
          await next?.close();
          return;
        }
        const previous = updateRef.current;
        updateRef.current = next;
        setUpdate(next);
        setVisible(next !== null);
        setError(null);
        await previous?.close();
      } catch (cause) {
        logEvent("warn", "runtime.failed", { stage: "update_check", errorCode: errorCode(cause) });
      } finally {
        checking = false;
      }
    }

    const interval = window.setInterval(() => { void checkForUpdate(); }, HOUR);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      const current = updateRef.current;
      updateRef.current = null;
      void current?.close().catch(() => {});
    };
  }, []);

  async function install() {
    const current = updateRef.current;
    if (!current || busyRef.current || blockedReason) return;
    busyRef.current = true;
    onBusyChange(true);
    setBusy(true);
    setError(null);
    setStatus("Preparing update…");
    let guarded = false;
    let stage = "prepare";
    try {
      await invoke("begin_app_update");
      guarded = true;
      stage = "save";
      if (!(await beforeInstall("app_update"))) throw new Error("save_failed");
      if (!installedRef.current) {
        stage = "install";
        setStatus("Downloading update…");
        await current.downloadAndInstall((event) => {
          if (event.event === "Finished") setStatus("Installing update…");
        }, { timeout: 300_000 });
        installedRef.current = true;
      }
      stage = "save";
      if (!(await beforeInstall("app_update"))) throw new Error("save_failed");
      stage = "restart";
      setStatus("Restarting Bilbo…");
      await relaunch();
    } catch (cause) {
      logEvent("error", "runtime.failed", { stage: `update_${stage}`, errorCode: errorCode(cause) });
      setError(stage === "prepare"
        ? cause === "CAPTURE_BUSY"
          ? "Finish or cancel your capture, then try updating again."
          : "Could not prepare the update. Please try again."
        : stage === "save"
          ? "Your note could not be saved. Please save it before updating."
          : installedRef.current
            ? "The update is installed. Please restart Bilbo."
            : "Could not install the update. Please try again.");
      if (guarded) {
        await invoke("end_app_update").catch((failure) => {
          logEvent("error", "runtime.failed", { stage: "update_unlock", errorCode: errorCode(failure) });
        });
      }
      busyRef.current = false;
      onBusyChange(false);
      setBusy(false);
    }
  }

  return <>
    {visible && update && !busy ? (
      <section aria-label="App update" className="fixed right-4 bottom-4 z-40 max-w-[calc(100vw-2rem)] rounded-xl bg-popover p-3 text-popover-foreground shadow-sm ring-1 ring-foreground/[0.09]">
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm">Bilbo v{update.version} is available</p>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setVisible(false)} className={`${buttonClassName} text-foreground/60 hover:bg-primary/[0.06]`}>Later</button>
            <button type="button" disabled={blockedReason !== null} title={blockedReason ?? undefined} onClick={() => { void install(); }} className={`${buttonClassName} bg-primary/[0.1] text-foreground enabled:hover:bg-primary/[0.15] disabled:opacity-50`}>
              {installedRef.current ? "Restart" : "Update"}
            </button>
          </div>
        </div>
        {error ? <p role="alert" className="mt-2 max-w-80 text-xs leading-5 text-destructive">{error}</p> : null}
      </section>
    ) : null}
    <Dialog.Root open={busy}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40" />
        <Dialog.Content
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed top-1/2 left-1/2 z-[101] w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover p-6 text-popover-foreground shadow-md ring-1 ring-foreground/[0.09] outline-none"
        >
          <Dialog.Title className="font-heading text-[22px] leading-7">Updating Bilbo</Dialog.Title>
          <Dialog.Description role="status" className="mt-3 text-sm text-foreground/70">{status}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
