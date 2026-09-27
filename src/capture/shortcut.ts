export const DEFAULT_CAPTURE_SHORTCUT = "Alt+KeyC";

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "code" | "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing"
>;

export type CaptureShortcutResult = { shortcut: string } | { error: string } | null;

const MODIFIER_SYMBOLS: Record<string, string> = {
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  super: "⌘",
  meta: "⌘",
  cmd: "⌘",
  command: "⌘",
};

const SUPPORTED_KEY = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/;
const MODIFIER_KEY = /^(Control|Alt|Shift|Meta|Super|OS)(Left|Right)?$/;
const EDITING_KEYS = new Set(["KeyQ", "KeyW", "KeyA", "KeyC", "KeyV", "KeyX", "KeyZ"]);

export function formatCaptureShortcut(shortcut: string): string {
  const modifiers = new Set<string>();
  const keys: string[] = [];

  for (const part of shortcut.split("+").map((value) => value.trim()).filter(Boolean)) {
    const symbol = MODIFIER_SYMBOLS[part.toLowerCase()];
    if (symbol) {
      modifiers.add(symbol);
    } else if (/^Key[A-Z]$/i.test(part)) {
      keys.push(part.slice(3).toUpperCase());
    } else if (/^Digit[0-9]$/i.test(part)) {
      keys.push(part.slice(5));
    } else {
      keys.push(part.length === 1 || /^F\d+$/i.test(part) ? part.toUpperCase() : part);
    }
  }

  return ["⌃", "⌥", "⇧", "⌘"].filter((symbol) => modifiers.has(symbol)).join("") + keys.join("+");
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): CaptureShortcutResult {
  if (event.repeat || event.isComposing || event.key === "Escape" || event.key === "Tab") return null;
  if (MODIFIER_KEY.test(event.code) || MODIFIER_KEY.test(event.key) || event.key === "AltGraph" || event.key === "Fn") return null;

  if (!event.altKey && !event.ctrlKey && !event.metaKey) {
    return { error: "Include ⌥, ⌃, or ⌘ in your shortcut." };
  }
  if (!SUPPORTED_KEY.test(event.code)) {
    return { error: "Use a letter, number, or F1–F12 with your modifier keys." };
  }

  const hasCommandOrControl = event.metaKey || event.ctrlKey;
  const reserved = hasCommandOrControl && (
    event.code === "KeyK" || (!event.altKey && EDITING_KEYS.has(event.code))
  );
  if (reserved) {
    return { error: "This shortcut is used by Bilbo or for editing. Choose another." };
  }

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(event.code);
  return { shortcut: parts.join("+") };
}
