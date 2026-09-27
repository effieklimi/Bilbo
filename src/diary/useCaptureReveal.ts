import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { captureReferenceHref } from "../capture/references";
import { logEvent } from "../diagnostics/logger";
import { createOperation, type OperationContext } from "../diagnostics/operation";

export type DiaryCaptureRevealRequest = {
  captureId: string;
  dateKey: string;
  requestId: number;
  operation?: OperationContext;
};

type UseCaptureRevealOptions = {
  active: boolean;
  selectedDateKey: string | null;
  captureIds: readonly string[];
  request: DiaryCaptureRevealRequest | null;
  setRequest: Dispatch<SetStateAction<DiaryCaptureRevealRequest | null>>;
  scrollRef: RefObject<HTMLDivElement | null>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useCaptureReveal({
  active,
  selectedDateKey,
  captureIds,
  request,
  setRequest,
  scrollRef,
  setError,
}: UseCaptureRevealOptions) {
  const highlightRef = useRef<{
    element: HTMLElement;
    timer: number;
  } | null>(null);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    if (
      !request ||
      !active ||
      selectedDateKey !== request.dateKey ||
      !scrollContainer
    ) {
      return;
    }

    let disposed = false;
    let observer: MutationObserver | null = null;
    let renderFrame: number | null = null;
    const requestId = request.requestId;
    const operation = request.operation ?? createOperation();
    const startedAt = performance.now();
    const referenceHref = captureReferenceHref(request.captureId);

    if (!captureIds.includes(request.captureId)) {
      scrollContainer.style.visibility = "visible";
      setRequest((current) =>
        current?.requestId === requestId ? null : current,
      );
      setError("That capture is no longer in this diary entry.");
      logEvent("warn", "capture.note_action", { action: "reveal", outcome: "failed", reason: "reference_missing" }, operation);
      return;
    }

    function revealCaptureCard() {
      if (disposed || !scrollContainer) return false;

      const referenceLink = Array.from(
        scrollContainer.querySelectorAll<HTMLAnchorElement>("a[href]"),
      ).find((link) => link.getAttribute("href") === referenceHref);
      if (!referenceLink) return false;

      const captureCard =
        referenceLink.closest<HTMLElement>("blockquote") ?? referenceLink;
      const previousHighlight = highlightRef.current;
      if (previousHighlight) {
        window.clearTimeout(previousHighlight.timer);
        previousHighlight.element.classList.remove("diary-capture-revealed");
      }

      captureCard.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "nearest",
      });
      scrollContainer.style.visibility = "visible";
      captureCard.tabIndex = -1;
      captureCard.focus({ preventScroll: true });
      captureCard.classList.add("diary-capture-revealed");

      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const highlightTimer = window.setTimeout(() => {
        captureCard.classList.remove("diary-capture-revealed");
        if (highlightRef.current?.element === captureCard) {
          highlightRef.current = null;
        }
      }, reducedMotion ? 900 : 1800);
      highlightRef.current = {
        element: captureCard,
        timer: highlightTimer,
      };

      observer?.disconnect();
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
      setRequest((current) =>
        current?.requestId === requestId ? null : current,
      );
      logEvent("debug", "capture.note_action", { action: "reveal", outcome: "success", durationMs: Math.round(performance.now() - startedAt) }, operation);
      return true;
    }

    if (!revealCaptureCard()) {
      logEvent("debug", "capture.note_action", { action: "reveal", phase: "waiting_for_render" }, operation);
      observer = new MutationObserver(revealCaptureCard);
      observer.observe(scrollContainer, { childList: true, subtree: true });
      renderFrame = window.requestAnimationFrame(revealCaptureCard);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
    };
  }, [
    active,
    captureIds,
    request,
    scrollRef,
    selectedDateKey,
    setError,
    setRequest,
  ]);

  useEffect(() => {
    return () => {
      const highlight = highlightRef.current;
      if (!highlight) return;

      window.clearTimeout(highlight.timer);
      highlight.element.classList.remove("diary-capture-revealed");
    };
  }, []);
}
