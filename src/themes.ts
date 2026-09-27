export const THEMES = [
  { id: "default", name: "Default" },
  { id: "caffeine", name: "Caffeine" },
  { id: "tangerine", name: "Tangerine" },
  { id: "terracotta", name: "Claude" },
  { id: "sand", name: "Sand" },
  { id: "nature", name: "Nature" },
  { id: "sage", name: "Sage" },
  { id: "blush", name: "Blush" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
