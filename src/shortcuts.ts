export const appShortcutDefinitions = [
  { id: "search", label: "Search", scope: "main" },
  { id: "saveCapture", label: "Save capture", scope: "capture" },
  { id: "zoomIn", label: "Increase interface size", scope: "main" },
  { id: "zoomOut", label: "Decrease interface size", scope: "main" },
] as const;

export type AppShortcutId = typeof appShortcutDefinitions[number]["id"];
export type AppShortcuts = Record<AppShortcutId, string>;
export type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "code" | "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing"
>;
export type ShortcutResult = { shortcut: string } | { error: string } | null;

export const DEFAULT_APP_SHORTCUTS: Readonly<AppShortcuts> = Object.freeze({
  search: "Super+KeyK",
  saveCapture: "Super+Enter",
  zoomIn: "Super+Equal",
  zoomOut: "Super+Minus",
});

const STORAGE_KEY = "diary.shortcuts";
const CHANGE_EVENT = "diary:shortcuts-changed";
const MODIFIERS = ["Control", "Alt", "Shift", "Super"] as const;
type Modifier = typeof MODIFIERS[number];
const MODIFIER_ALIASES: Record<string, Modifier> = {
  control: "Control", ctrl: "Control", alt: "Alt", option: "Alt", shift: "Shift",
  super: "Super", meta: "Super", cmd: "Super", command: "Super",
};
const MODIFIER_SYMBOLS: Record<Modifier, string> = {
  Control: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘",
};
const SUPPORTED_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Enter|Equal|Minus)$/;
const MODIFIER_KEY = /^(Control|Alt|Shift|Meta|Super|OS)(Left|Right)?$/;
const EDITING_KEYS = new Set(["KeyA", "KeyB", "KeyC", "KeyI", "KeyU", "KeyV", "KeyX", "KeyY", "KeyZ"]);
const WINDOW_KEYS = new Set(["KeyH", "KeyM", "KeyQ", "KeyW"]);
let recording = false;

type ParsedShortcut = { code: string; modifiers: Set<Modifier> };

function parseShortcut(value: string): ParsedShortcut | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // A trailing '+' is the shifted Equal key, including accelerator strings like Cmd++.
  const plusKey = /\+\s*\+$/.test(trimmed);
  const parts = (plusKey ? trimmed.replace(/\+\s*\+$/, "+Equal") : trimmed)
    .split("+").map((part) => part.trim());
  const modifiers = new Set<Modifier>();
  let code: string | null = null;
  if (plusKey) modifiers.add("Shift");

  for (const part of parts) {
    const name = part.toLowerCase();
    const modifier = Object.hasOwn(MODIFIER_ALIASES, name) ? MODIFIER_ALIASES[name] : undefined;
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (code || !part) return null;
    if (/^(key)?[a-z]$/i.test(part)) code = `Key${part.slice(-1).toUpperCase()}`;
    else if (/^(digit)?[0-9]$/i.test(part)) code = `Digit${part.slice(-1)}`;
    else if (/^f([1-9]|1[0-2])$/i.test(part)) code = part.toUpperCase();
    else if (/^(enter|return)$/i.test(part) || part === "↵" || part === "⏎") code = "Enter";
    else if (/^equal$/i.test(part) || part === "=") code = "Equal";
    else if (/^minus$/i.test(part) || part === "-" || part === "_") {
      code = "Minus";
      if (part === "_") modifiers.add("Shift");
    } else return null;
  }

  if (!code || !["Control", "Alt", "Super"].some((modifier) => modifiers.has(modifier as Modifier))) {
    return null;
  }
  return { code, modifiers };
}

function serializeShortcut({ code, modifiers }: ParsedShortcut): string {
  return [...MODIFIERS.filter((modifier) => modifiers.has(modifier)), code].join("+");
}

export function normalizeShortcut(shortcut: string): string | null {
  const parsed = parseShortcut(shortcut);
  return parsed ? serializeShortcut(parsed) : null;
}

export function formatShortcut(shortcut: string): string {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;
  const key = parsed.code.startsWith("Key") ? parsed.code.slice(3)
    : parsed.code.startsWith("Digit") ? parsed.code.slice(5)
    : ({ Enter: "↵", Equal: "=", Minus: "−" }[parsed.code] ?? parsed.code);
  return MODIFIERS.filter((modifier) => parsed.modifiers.has(modifier))
    .map((modifier) => MODIFIER_SYMBOLS[modifier]).join("") + key;
}

function reservedShortcut(parsed: ParsedShortcut): boolean {
  const commandOrControl = parsed.modifiers.has("Super") || parsed.modifiers.has("Control");
  return commandOrControl && (
    WINDOW_KEYS.has(parsed.code) || (!parsed.modifiers.has("Alt") && EDITING_KEYS.has(parsed.code)) ||
    (parsed.modifiers.has("Alt") && /^Digit[0-6]$/.test(parsed.code)) ||
    (parsed.modifiers.has("Super") && parsed.modifiers.has("Control") && parsed.code === "KeyF")
  );
}

function shortcutError(shortcut: string): string | null {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return "Use a letter, number, Enter, +, −, or F1–F12 with ⌥, ⌃, or ⌘.";
  if (reservedShortcut(parsed)) return "This shortcut is used by macOS or for editing. Choose another.";
  return null;
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): ShortcutResult {
  if (event.repeat || event.isComposing || event.key === "Escape" || event.key === "Tab") return null;
  if (MODIFIER_KEY.test(event.code) || MODIFIER_KEY.test(event.key) || event.key === "AltGraph" || event.key === "Fn") return null;
  if (!event.altKey && !event.ctrlKey && !event.metaKey) return { error: "Include ⌥, ⌃, or ⌘ in your shortcut." };
  if (!SUPPORTED_CODE.test(event.code)) return { error: "Use a letter, number, Enter, +, −, or F1–F12 with your modifier keys." };
  const modifiers = new Set<Modifier>();
  if (event.ctrlKey) modifiers.add("Control");
  if (event.altKey) modifiers.add("Alt");
  if (event.shiftKey) modifiers.add("Shift");
  if (event.metaKey) modifiers.add("Super");
  const shortcut = serializeShortcut({ code: event.code, modifiers });
  const error = shortcutError(shortcut);
  return error ? { error } : { shortcut };
}

function eventCode(event: ShortcutKeyboardEvent): string {
  if (event.code) return event.code;
  // Physical codes remain authoritative; key fallback supports synthetic events without a code.
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  if (event.key === "+" || event.key === "=") return "Equal";
  if (event.key === "-" || event.key === "_") return "Minus";
  return event.key;
}

export function matchesShortcut(event: ShortcutKeyboardEvent, shortcut: string): boolean {
  if (event.repeat || event.isComposing) return false;
  const parsed = parseShortcut(shortcut);
  if (!parsed || eventCode(event) !== parsed.code) return false;
  if (event.ctrlKey !== parsed.modifiers.has("Control") ||
      event.altKey !== parsed.modifiers.has("Alt") ||
      event.metaKey !== parsed.modifiers.has("Super")) return false;
  // Zoom's conventional '+' and '_' forms also match unshifted Equal/Minus bindings.
  const shiftAlias = !parsed.modifiers.has("Shift") && (parsed.code === "Equal" || parsed.code === "Minus");
  return shiftAlias || event.shiftKey === parsed.modifiers.has("Shift");
}

function shortcutsOverlap(left: string, right: string): boolean {
  const a = parseShortcut(left);
  const b = parseShortcut(right);
  if (!a || !b || a.code !== b.code) return false;
  if (["Control", "Alt", "Super"].some((modifier) => a.modifiers.has(modifier as Modifier) !== b.modifiers.has(modifier as Modifier))) return false;
  return a.code === "Equal" || a.code === "Minus" || a.modifiers.has("Shift") === b.modifiers.has("Shift");
}

export function validateShortcut(
  shortcut: string,
  id: AppShortcutId,
  preferences: AppShortcuts,
  globalCaptureShortcut?: string,
): string | null {
  const error = shortcutError(shortcut);
  if (error) return error;
  if (globalCaptureShortcut && shortcutsOverlap(shortcut, globalCaptureShortcut)) {
    return "This shortcut is already used for Capture.";
  }
  const scope = appShortcutDefinitions.find((definition) => definition.id === id)?.scope;
  const conflict = appShortcutDefinitions.find((definition) =>
    definition.id !== id && definition.scope === scope && shortcutsOverlap(shortcut, preferences[definition.id]),
  );
  return conflict ? `This shortcut is already used for ${conflict.label}.` : null;
}

export function validateGlobalCaptureShortcut(shortcut: string, preferences: AppShortcuts): string | null {
  const error = shortcutError(shortcut);
  if (error) return error;
  const conflict = appShortcutDefinitions.find((definition) => shortcutsOverlap(shortcut, preferences[definition.id]));
  return conflict ? `This shortcut is already used for ${conflict.label}.` : null;
}

function safePreferences(value: unknown): AppShortcuts {
  const preferences = { ...DEFAULT_APP_SHORTCUTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) return preferences;
  const saved = value as Record<string, unknown>;
  for (const { id } of appShortcutDefinitions) {
    if (typeof saved[id] === "string" && !shortcutError(saved[id])) {
      preferences[id] = normalizeShortcut(saved[id])!;
    }
  }
  // Reset both conflicting values, then recheck: restoring a default can reveal another conflict.
  for (let pass = 0; pass < appShortcutDefinitions.length; pass++) {
    const conflicts = appShortcutDefinitions.filter(({ id }) => validateShortcut(preferences[id], id, preferences));
    if (!conflicts.length) break;
    for (const { id } of conflicts) preferences[id] = DEFAULT_APP_SHORTCUTS[id];
  }
  return preferences;
}

export function readAppShortcuts(): AppShortcuts {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved ? safePreferences(JSON.parse(saved)) : { ...DEFAULT_APP_SHORTCUTS };
  } catch {
    return { ...DEFAULT_APP_SHORTCUTS };
  }
}

export function writeAppShortcuts(preferences: AppShortcuts): void {
  const normalized = { ...DEFAULT_APP_SHORTCUTS };
  for (const { id } of appShortcutDefinitions) {
    const error = validateShortcut(preferences[id], id, preferences);
    if (error) throw new Error(error);
    normalized[id] = normalizeShortcut(preferences[id])!;
  }
  const serialized = JSON.stringify(normalized);
  if (window.localStorage.getItem(STORAGE_KEY) === serialized) return;
  window.localStorage.setItem(STORAGE_KEY, serialized);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function watchAppShortcuts(listener: (preferences: AppShortcuts) => void): () => void {
  const refresh = () => listener(readAppShortcuts());
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch { /* readAppShortcuts supplies defaults if storage access is blocked. */ }
    refresh();
  };
  refresh();
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, refresh);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, refresh);
  };
}

export function setShortcutRecording(active: boolean): void {
  recording = active;
}

export function isShortcutRecording(target?: EventTarget | null): boolean {
  if (recording) return true;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest("[data-shortcut-recorder]")) return true;
  return typeof document !== "undefined" && !!document.activeElement?.closest("[data-shortcut-recorder]");
}
