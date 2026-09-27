import { analyzeMarkdown } from "../markdown/analyze";

export { captureIdFromHref, captureReferenceHref } from "./referenceHref";

export function extractCaptureIds(markdown: string) {
  return analyzeMarkdown(markdown).captureIds;
}
