import { expect, test } from "bun:test";
import { DEFAULT_CAPTURE_SHORTCUT, formatCaptureShortcut, shortcutFromKeyboardEvent } from "../src/capture/shortcut";

type ShortcutEvent = Parameters<typeof shortcutFromKeyboardEvent>[0];

function keyEvent(overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return {
    code: "KeyC",
    key: "c",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

test("shortcut labels use Mac symbols and readable physical key names", () => {
  expect(formatCaptureShortcut(DEFAULT_CAPTURE_SHORTCUT)).toBe("⌥C");
  expect(formatCaptureShortcut("Alt+C")).toBe("⌥C");
  expect(formatCaptureShortcut("Super+Shift+Alt+Control+KeyM")).toBe("⌃⌥⇧⌘M");
  expect(formatCaptureShortcut("Option+Ctrl+Command+Digit1")).toBe("⌃⌥⌘1");
  expect(formatCaptureShortcut("Meta+F12")).toBe("⌘F12");
  expect(formatCaptureShortcut("Cmd+f1")).toBe("⌘F1");
  expect(formatCaptureShortcut(" alt + option + c ")).toBe("⌥C");
});

test("recording uses physical key codes when Option or a different layout changes the character", () => {
  expect(shortcutFromKeyboardEvent(keyEvent({ key: "ç" }))).toEqual({ shortcut: DEFAULT_CAPTURE_SHORTCUT });
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "KeyQ", key: "a" }))).toEqual({ shortcut: "Alt+KeyQ" });
  expect(shortcutFromKeyboardEvent(keyEvent({
    code: "Digit1", key: "¡", ctrlKey: true, shiftKey: true, metaKey: true,
  }))).toEqual({ shortcut: "Control+Alt+Shift+Super+Digit1" });
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "F12", key: "F12" }))).toEqual({ shortcut: "Alt+F12" });
});

test("modifier-only presses and recording control events do not create a shortcut", () => {
  for (const [code, key] of [
    ["AltLeft", "Alt"], ["ControlRight", "Control"], ["ShiftLeft", "Shift"],
    ["MetaRight", "Meta"], ["", "Fn"], ["Escape", "Escape"], ["Tab", "Tab"],
  ]) {
    expect(shortcutFromKeyboardEvent(keyEvent({ code, key }))).toBeNull();
  }
  expect(shortcutFromKeyboardEvent(keyEvent({ repeat: true }))).toBeNull();
  expect(shortcutFromKeyboardEvent(keyEvent({ isComposing: true }))).toBeNull();
});

test("plain typing, Shift-only chords and unsupported physical keys are rejected", () => {
  expect(shortcutFromKeyboardEvent(keyEvent({ altKey: false }))).toHaveProperty("error");
  expect(shortcutFromKeyboardEvent(keyEvent({ altKey: false, shiftKey: true }))).toHaveProperty("error");
  for (const code of ["ArrowLeft", "Space", "Semicolon", "F13", "Numpad1", ""]) {
    expect(shortcutFromKeyboardEvent(keyEvent({ code }))).toHaveProperty("error");
  }
});

test("Bilbo's search shortcut stays reserved with any extra modifier", () => {
  for (const code of ["KeyK"]) {
    for (const command of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const altKey of [false, true]) {
        for (const shiftKey of [false, true]) {
          expect(shortcutFromKeyboardEvent(keyEvent({ code, ...command, altKey, shiftKey }))).toHaveProperty("error");
        }
      }
    }
    expect(shortcutFromKeyboardEvent(keyEvent({ code }))).toEqual({ shortcut: `Alt+${code}` });
  }
});

test("the former zoom reset chord can be recorded as a capture shortcut", () => {
  for (const [command, shortcut] of [
    [{ ctrlKey: true }, "Control+Digit0"],
    [{ ctrlKey: true, shiftKey: true }, "Control+Shift+Digit0"],
    [{ metaKey: true }, "Super+Digit0"],
    [{ metaKey: true, shiftKey: true }, "Shift+Super+Digit0"],
  ] as const) {
    expect(shortcutFromKeyboardEvent(keyEvent({
      code: "Digit0", key: "0", altKey: false, ...command,
    }))).toEqual({ shortcut });
  }
});

test("common edit and quit chords require Option before they can become a capture shortcut", () => {
  for (const code of ["KeyQ", "KeyW", "KeyA", "KeyC", "KeyV", "KeyX", "KeyZ"]) {
    for (const command of [{ ctrlKey: true }, { metaKey: true }]) {
      for (const shiftKey of [false, true]) {
        expect(shortcutFromKeyboardEvent(keyEvent({ code, ...command, altKey: false, shiftKey }))).toHaveProperty("error");
      }
    }
    expect(shortcutFromKeyboardEvent(keyEvent({ code, metaKey: true }))).toEqual({ shortcut: `Alt+Super+${code}` });
  }
  expect(shortcutFromKeyboardEvent(keyEvent({ code: "KeyM", altKey: false, metaKey: true }))).toEqual({ shortcut: "Super+KeyM" });
});
