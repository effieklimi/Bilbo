import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  DEFAULT_APP_SHORTCUTS,
  formatShortcut,
  isShortcutRecording,
  matchesShortcut,
  normalizeShortcut,
  readAppShortcuts,
  setShortcutRecording,
  shortcutFromKeyboardEvent,
  validateGlobalCaptureShortcut,
  validateShortcut,
  watchAppShortcuts,
  writeAppShortcuts,
  type ShortcutKeyboardEvent,
} from "../src/shortcuts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let values: Map<string, string>;
let browser: EventTarget & { localStorage: Storage };
let setItem: ReturnType<typeof mock>;

function keyEvent(overrides: Partial<ShortcutKeyboardEvent> = {}): ShortcutKeyboardEvent {
  return {
    code: "KeyK", key: "k", ctrlKey: false, altKey: false, metaKey: true,
    shiftKey: false, repeat: false, isComposing: false, ...overrides,
  };
}

beforeEach(() => {
  values = new Map();
  setItem = mock((key: string, value: string) => values.set(key, value));
  browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem } as unknown as Storage,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
});

afterEach(() => {
  setShortcutRecording(false);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function storageChanged(key: string | null, storageArea: Storage = browser.localStorage) {
  browser.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea }));
}

test("normalization recognizes aliases and retains exact modifier combinations", () => {
  expect(normalizeShortcut(" command + shift + option + ctrl + k ")).toBe("Control+Alt+Shift+Super+KeyK");
  expect(normalizeShortcut("alt+option+c")).toBe("Alt+KeyC");
  expect(normalizeShortcut("Meta+f12")).toBe("Super+F12");
  expect(normalizeShortcut("Ctrl+0")).toBe("Control+Digit0");
  expect(normalizeShortcut("Command+Return")).toBe("Super+Enter");
  expect(normalizeShortcut("Cmd++")).toBe("Shift+Super+Equal");
  expect(normalizeShortcut("Cmd+_")).toBe("Shift+Super+Minus");
  for (const value of ["k", "Shift+KeyK", "Super+F13", "Super+KeyK+KeyL", "Super+", "Super+Space", "Super++KeyK", "Super+constructor+KeyK"]) {
    expect(normalizeShortcut(value)).toBeNull();
  }
});

test("formatting uses compact labels for all supported key types", () => {
  expect(formatShortcut("Super+KeyK")).toBe("⌘K");
  expect(formatShortcut("Ctrl+Alt+Shift+Cmd+Digit1")).toBe("⌃⌥⇧⌘1");
  expect(formatShortcut("Super+Enter")).toBe("⌘↵");
  expect(formatShortcut("Super+Equal")).toBe("⌘=");
  expect(formatShortcut("Super+Minus")).toBe("⌘−");
  expect(formatShortcut("Alt+F12")).toBe("⌥F12");
});

test("recording physical keys supports current defaults and ignores recording control events", () => {
  expect(shortcutFromKeyboardEvent(keyEvent())).toEqual({ shortcut: "Super+KeyK" });
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "Digit0", key: "0" }))).toEqual({ shortcut: "Super+Digit0" });
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "Enter", key: "Enter" }))).toEqual({ shortcut: "Super+Enter" });
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "Equal", key: "+", shiftKey: true }))).toEqual({ shortcut: "Shift+Super+Equal" });
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "KeyC", key: "ç", metaKey: false, altKey: true }))).toEqual({ shortcut: "Alt+KeyC" });
  for (const [code, key] of [["Escape", "Escape"], ["Tab", "Tab"], ["MetaLeft", "Meta"], ["ShiftRight", "Shift"], ["", "Fn"]]) {
    expect(shortcutFromKeyboardEvent(keyEvent({ code, key }))).toBeNull();
  }
  expect(shortcutFromKeyboardEvent(keyEvent({ repeat: true }))).toBeNull();
  expect(shortcutFromKeyboardEvent(keyEvent({ isComposing: true }))).toBeNull();
  expect(shortcutFromKeyboardEvent(keyEvent({ metaKey: false }))).toHaveProperty("error");
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "Space", key: " " }))).toHaveProperty("error");
});

test("recording and validation reserve OS, formatting, clipboard, and heading shortcuts", () => {
  for (const code of ["KeyA", "KeyB", "KeyC", "KeyH", "KeyI", "KeyM", "KeyQ", "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ"]) {
    expect(shortcutFromKeyboardEvent(keyEvent({ code }))).toHaveProperty("error");
    expect(validateShortcut(`Super+${code}`, "search", { ...DEFAULT_APP_SHORTCUTS })).not.toBeNull();
  }
  for (const digit of [0, 1, 2, 3, 4, 5, 6]) {
    expect(shortcutFromKeyboardEvent(keyEvent({ code: `Digit${digit}`, altKey: true }))).toHaveProperty("error");
  }
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "KeyF", ctrlKey: true }))).toHaveProperty("error");
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "KeyJ", altKey: true }))).toEqual({ shortcut: "Alt+Super+KeyJ" });
});

test("matching uses exact modifiers and physical key codes, without repeat or composition", () => {
  expect(matchesShortcut(keyEvent(), "Super+KeyK")).toBe(true);
  expect(matchesShortcut(keyEvent({ key: "κ" }), "Super+KeyK")).toBe(true);
  expect(matchesShortcut(keyEvent({ code: "KeyJ", key: "k" }), "Super+KeyK")).toBe(false);
  for (const override of [{ altKey: true }, { ctrlKey: true }, { shiftKey: true }, { metaKey: false }, { repeat: true }, { isComposing: true }]) {
    expect(matchesShortcut(keyEvent(override), "Super+KeyK")).toBe(false);
  }
  expect(matchesShortcut(keyEvent({ code: "", key: "k" }), "Super+KeyK")).toBe(true);
});

test("zoom supports plus/minus aliases without accepting unrelated modifiers", () => {
  for (const [code, unshifted, shifted, shortcut] of [["Equal", "=", "+", "Super+Equal"], ["Minus", "-", "_", "Super+Minus"]]) {
    expect(matchesShortcut(keyEvent({ code, key: unshifted }), shortcut)).toBe(true);
    expect(matchesShortcut(keyEvent({ code, key: shifted, shiftKey: true }), shortcut)).toBe(true);
    expect(matchesShortcut(keyEvent({ code: "", key: shifted, shiftKey: true }), shortcut)).toBe(true);
    expect(matchesShortcut(keyEvent({ code, key: shifted, shiftKey: true, altKey: true }), shortcut)).toBe(false);
    expect(matchesShortcut(keyEvent({ code, key: unshifted }), `Shift+${shortcut}`)).toBe(false);
  }
});

test("collision validation shares main-window scope but keeps capture save independent", () => {
  const preferences = { ...DEFAULT_APP_SHORTCUTS };
  expect(validateShortcut("Super+Digit0", "search", preferences)).toBeNull();
  expect(validateShortcut("Super+Enter", "search", preferences)).toBeNull();
  expect(validateShortcut("Super+KeyK", "saveCapture", preferences)).toBeNull();
  expect(validateShortcut("Super+Shift+Equal", "search", preferences)).not.toBeNull();
  expect(validateShortcut("Super+Shift+Minus", "search", preferences)).not.toBeNull();
  expect(validateShortcut("Alt+KeyC", "search", preferences, "Option+C")).not.toBeNull();
  expect(validateGlobalCaptureShortcut("Super+Enter", preferences)).not.toBeNull();
  expect(validateGlobalCaptureShortcut("Super+Shift+Equal", preferences)).not.toBeNull();
  expect(validateGlobalCaptureShortcut("Alt+KeyC", preferences)).toBeNull();
});

test("missing, malformed, or unsafe persisted preferences fall back safely", () => {
  expect(readAppShortcuts()).toEqual(DEFAULT_APP_SHORTCUTS);
  for (const serialized of ["invalid", "null", "[]", '"string"', '{"search":"Super+KeyQ","zoomIn":true,"zoomOut":"Shift+KeyM"}']) {
    values.set("diary.shortcuts", serialized);
    expect(readAppShortcuts()).toEqual(DEFAULT_APP_SHORTCUTS);
  }
  values.set("diary.shortcuts", JSON.stringify({ search: "option+J", saveCapture: "bad", zoomReset: "Super+Digit0", unknown: "Super+KeyL" }));
  expect(readAppShortcuts()).toEqual({ ...DEFAULT_APP_SHORTCUTS, search: "Alt+KeyJ" });
  Object.defineProperty(browser, "localStorage", { get: () => { throw new Error("Storage blocked"); } });
  expect(readAppShortcuts()).toEqual(DEFAULT_APP_SHORTCUTS);
});

test("duplicate persisted bindings are repaired, including fallback cascades and aliases", () => {
  values.set("diary.shortcuts", JSON.stringify({ search: "Super+Equal" }));
  expect(readAppShortcuts()).toEqual(DEFAULT_APP_SHORTCUTS);
  values.set("diary.shortcuts", JSON.stringify({ search: "Shift+Super+Equal" }));
  expect(readAppShortcuts()).toEqual(DEFAULT_APP_SHORTCUTS);
  values.set("diary.shortcuts", JSON.stringify({ search: "Alt+KeyJ", zoomIn: "Alt+KeyJ", zoomOut: "Super+KeyK" }));
  expect(readAppShortcuts()).toEqual(DEFAULT_APP_SHORTCUTS);
  values.set("diary.shortcuts", JSON.stringify({ search: "Super+Equal", zoomIn: "Super+KeyK", saveCapture: "Super+KeyK" }));
  expect(readAppShortcuts()).toEqual({ ...DEFAULT_APP_SHORTCUTS, search: "Super+Equal", zoomIn: "Super+KeyK", saveCapture: "Super+KeyK" });
});

test("successful writes normalize and notify local listeners, unchanged writes do not", () => {
  const listener = mock();
  const stop = watchAppShortcuts(listener);
  expect(listener).toHaveBeenLastCalledWith(DEFAULT_APP_SHORTCUTS);
  writeAppShortcuts({ ...DEFAULT_APP_SHORTCUTS, search: "Option+J" });
  expect(listener).toHaveBeenLastCalledWith({ ...DEFAULT_APP_SHORTCUTS, search: "Alt+KeyJ" });
  expect(setItem).toHaveBeenCalledTimes(1);
  writeAppShortcuts({ ...DEFAULT_APP_SHORTCUTS, search: "Alt+KeyJ" });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(setItem).toHaveBeenCalledTimes(1);
  stop();
});

test("writes surface storage errors and reject conflicts without notifying success", () => {
  const listener = mock();
  const stop = watchAppShortcuts(listener);
  expect(() => writeAppShortcuts({ ...DEFAULT_APP_SHORTCUTS, search: "Super+Equal" })).toThrow();
  expect(setItem).not.toHaveBeenCalled();
  setItem.mockImplementation(() => { throw new Error("Storage full"); });
  expect(() => writeAppShortcuts({ ...DEFAULT_APP_SHORTCUTS })).toThrow("Storage full");
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

test("watchers follow relevant other-window storage changes and unsubscribe cleanly", () => {
  const listener = mock();
  const stop = watchAppShortcuts(listener);
  values.set("diary.shortcuts", JSON.stringify({ search: "Alt+KeyJ" }));
  storageChanged("other");
  storageChanged("diary.shortcuts", {} as Storage);
  expect(listener).toHaveBeenCalledTimes(1);
  storageChanged("diary.shortcuts");
  expect(listener).toHaveBeenLastCalledWith({ ...DEFAULT_APP_SHORTCUTS, search: "Alt+KeyJ" });
  values.clear();
  storageChanged(null);
  expect(listener).toHaveBeenLastCalledWith(DEFAULT_APP_SHORTCUTS);
  stop();
  storageChanged("diary.shortcuts");
  writeAppShortcuts({ ...DEFAULT_APP_SHORTCUTS });
  expect(listener).toHaveBeenCalledTimes(3);
});

test("recording flag suppresses shortcuts for the whole window until cleared", () => {
  expect(isShortcutRecording()).toBe(false);
  setShortcutRecording(true);
  expect(isShortcutRecording()).toBe(true);
  setShortcutRecording(false);
  expect(isShortcutRecording()).toBe(false);
});

test("recorder elements suppress shortcuts both by event target and current focus", () => {
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  class TestElement extends EventTarget {
    constructor(private recorder: boolean) { super(); }
    closest(selector: string) { return selector === "[data-shortcut-recorder]" && this.recorder ? this : null; }
  }
  const recorder = new TestElement(true);
  const unrelated = new TestElement(false);
  try {
    Object.defineProperty(globalThis, "Element", { configurable: true, value: TestElement });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: unrelated } });
    expect(isShortcutRecording(unrelated)).toBe(false);
    expect(isShortcutRecording(recorder)).toBe(true);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: recorder } });
    expect(isShortcutRecording(unrelated)).toBe(true);
  } finally {
    if (originalElement) Object.defineProperty(globalThis, "Element", originalElement);
    else Reflect.deleteProperty(globalThis, "Element");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
