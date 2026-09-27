import { THEMES, type ThemeId } from "./themes";

const MODE_KEY = "diary.theme";
const PALETTE_KEY = "diary.palette";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreferences = {
  themeId: ThemeId;
  darkMode: boolean;
};

function resolveThemeId(value: string | null): ThemeId {
  return THEMES.find((theme) => theme.id === value)?.id ?? "default";
}

export function readTheme(): ThemePreferences {
  const mode = window.localStorage.getItem(MODE_KEY);
  return {
    themeId: resolveThemeId(window.localStorage.getItem(PALETTE_KEY)),
    darkMode: mode === "dark" || (
      mode !== "light" && window.matchMedia(DARK_QUERY).matches
    ),
  };
}

export function applyTheme({ themeId, darkMode }: ThemePreferences) {
  document.documentElement.dataset.theme = resolveThemeId(themeId);
  document.documentElement.classList.toggle("dark", darkMode);
}

export function writeTheme(preferences: ThemePreferences) {
  applyTheme(preferences);
  const values = {
    [MODE_KEY]: preferences.darkMode ? "dark" : "light",
    [PALETTE_KEY]: resolveThemeId(preferences.themeId),
  };
  for (const [key, value] of Object.entries(values)) {
    if (window.localStorage.getItem(key) !== value) {
      window.localStorage.setItem(key, value);
    }
  }
}

export function watchTheme(listener?: (preferences: ThemePreferences) => void) {
  const media = window.matchMedia(DARK_QUERY);
  const refresh = () => {
    const preferences = readTheme();
    applyTheme(preferences);
    listener?.(preferences);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key === null || event.key === MODE_KEY || event.key === PALETTE_KEY) {
      refresh();
    }
  };

  refresh();
  media.addEventListener("change", refresh);
  window.addEventListener("storage", onStorage);

  return () => {
    media.removeEventListener("change", refresh);
    window.removeEventListener("storage", onStorage);
  };
}
