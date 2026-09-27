import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { applyTheme, readTheme, watchTheme, writeTheme, type ThemePreferences } from "../src/theme";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let values: Map<string, string>;
let browser: EventTarget & { localStorage: Storage };
let media: EventTarget & { matches: boolean };
let root: { dataset: { theme?: string }; classList: { toggle: ReturnType<typeof mock> } };
let setItem: ReturnType<typeof mock>;

beforeEach(() => {
  values = new Map();
  setItem = mock((key: string, value: string) => values.set(key, value));
  media = Object.assign(new EventTarget(), { matches: false });
  browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem } as unknown as Storage,
    matchMedia: () => media,
  });
  root = { dataset: {}, classList: { toggle: mock() } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function storageChanged(key: string | null, storageArea: Storage = browser.localStorage) {
  const event = Object.assign(new Event("storage"), { key, storageArea });
  browser.dispatchEvent(event);
}

test("existing light/dark choices survive and unknown theme IDs use Default", () => {
  media.matches = true;
  expect(readTheme()).toEqual({ themeId: "default", darkMode: true });
  values.set("diary.palette", "removed-theme");
  values.set("diary.theme", "light");
  expect(readTheme()).toEqual({ themeId: "default", darkMode: false });
  media.matches = false;
  values.set("diary.theme", "dark");
  expect(readTheme()).toEqual({ themeId: "default", darkMode: true });
});

test("applying a selection preserves separate light/dark state without saving it", () => {
  applyTheme({ themeId: "default", darkMode: true });
  expect(root.dataset.theme).toBe("default");
  expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);
  applyTheme({ themeId: "default", darkMode: false });
  expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", false);
  expect(setItem).not.toHaveBeenCalled();
});

test("explicit choices are validated, applied, and saved only when changed", () => {
  const preferences = { themeId: "unknown", darkMode: true } as ThemePreferences;
  writeTheme(preferences);
  expect(readTheme()).toEqual({ themeId: "default", darkMode: true });
  expect(root.dataset.theme).toBe("default");
  expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);
  expect(setItem).toHaveBeenCalledTimes(2);
  writeTheme(preferences);
  expect(setItem).toHaveBeenCalledTimes(2);
  writeTheme({ themeId: "default", darkMode: false });
  expect(setItem).toHaveBeenCalledTimes(3);
  expect(values.get("diary.theme")).toBe("light");
});

test.each(["caffeine", "nature", "tangerine", "sage", "blush", "terracotta", "sand"] as const)("%s stays selected across mode changes and can switch back to Default", (themeId) => {
  writeTheme({ themeId, darkMode: false });
  expect(readTheme()).toEqual({ themeId, darkMode: false });
  expect(root.dataset.theme).toBe(themeId);

  writeTheme({ ...readTheme(), darkMode: true });
  expect(readTheme()).toEqual({ themeId, darkMode: true });
  expect(root.dataset.theme).toBe(themeId);

  writeTheme({ ...readTheme(), themeId: "default" });
  expect(readTheme()).toEqual({ themeId: "default", darkMode: true });
  expect(root.dataset.theme).toBe("default");
});

test("watching initializes immediately and follows relevant cross-window changes", () => {
  const listener = mock();
  const stop = watchTheme(listener);
  expect(listener).toHaveBeenLastCalledWith({ themeId: "default", darkMode: false });
  expect(root.dataset.theme).toBe("default");
  expect(setItem).not.toHaveBeenCalled();

  values.set("diary.theme", "dark");
  storageChanged("unrelated");
  storageChanged("diary.theme", {} as Storage);
  expect(listener).toHaveBeenCalledTimes(1);
  storageChanged("diary.theme");
  expect(listener).toHaveBeenLastCalledWith({ themeId: "default", darkMode: true });
  expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);

  values.set("diary.palette", "caffeine");
  storageChanged("diary.palette");
  expect(listener).toHaveBeenCalledTimes(3);
  expect(listener).toHaveBeenLastCalledWith({ themeId: "caffeine", darkMode: true });
  expect(root.dataset.theme).toBe("caffeine");

  values.clear();
  storageChanged(null);
  expect(listener).toHaveBeenLastCalledWith({ themeId: "default", darkMode: false });
  stop();
  storageChanged("diary.theme");
  media.dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenCalledTimes(4);
});

test("system appearance changes apply only while there is no saved mode", () => {
  const listener = mock();
  const stop = watchTheme(listener);
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenLastCalledWith({ themeId: "default", darkMode: true });
  expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);
  values.set("diary.theme", "light");
  media.dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenLastCalledWith({ themeId: "default", darkMode: false });
  expect(setItem).not.toHaveBeenCalled();
  stop();
});
