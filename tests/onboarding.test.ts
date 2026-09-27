import { expect, test } from "bun:test";
import { needsOnboarding } from "../src/onboarding/state";

test("a fresh installation opens onboarding", () => {
  expect(needsOnboarding(null, null)).toBe(true);
});

test("existing users with a diary folder are not sent through onboarding", () => {
  expect(needsOnboarding("/diary", null)).toBe(false);
});

test("unfinished setup resumes even if the folder has already been selected", () => {
  expect(needsOnboarding(null, "pending")).toBe(true);
  expect(needsOnboarding("/diary", "pending")).toBe(true);
});

test("completed setup stays complete without requiring capture access", () => {
  expect(needsOnboarding("/diary", "complete")).toBe(false);
  expect(needsOnboarding(null, "complete")).toBe(false);
});
