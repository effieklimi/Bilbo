export const ONBOARDING_KEY = "diary.onboarding";

/** Existing diaries skip setup; unfinished first-run setup survives a restart. */
export function needsOnboarding(savedWorkspace: string | null, status: string | null) {
  return status === "pending" || (!savedWorkspace && status !== "complete");
}
