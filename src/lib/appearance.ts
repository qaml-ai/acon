// ── Types ──────────────────────────────────────────────────────────

export type ColorSchemeId = string;

export interface ColorScheme {
  id: string;
  name: string;
  light: Record<string, string>;
  dark: Record<string, string>;
  builtin: boolean;
}

export interface AppearancePrefs {
  bodyFont: string;
  headingFont: string;
  colorScheme: ColorSchemeId;
}

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_PREFS: AppearancePrefs = {
  bodyFont: "Figtree",
  headingFont: "Source Serif 4",
  colorScheme: "mist",
};

// ── Font registry ──────────────────────────────────────────────────

export interface FontOption {
  family: string;
  label: string;
  description: string;
  category: "sans-serif" | "serif";
  fallback: string;
}

export const BODY_FONTS: FontOption[] = [
  { family: "Figtree", label: "Figtree", description: "Geometric, friendly", category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "Inter", label: "Inter", description: "Clean, neutral UI standard", category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "Lora", label: "Lora", description: "Calligraphy-inspired serif", category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "IBM Plex Mono", label: "IBM Plex Mono", description: "Clean, technical monospace", category: "sans-serif", fallback: "ui-monospace, monospace" },
];

export const HEADING_FONTS: FontOption[] = [
  { family: "Source Serif 4", label: "Source Serif 4", description: "Clean, versatile serif", category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Fraunces", label: "Fraunces", description: "Old-style, quirky display", category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Plus Jakarta Sans", label: "Plus Jakarta Sans", description: "Modern geometric sans", category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "IBM Plex Mono", label: "IBM Plex Mono", description: "Clean, technical monospace", category: "sans-serif", fallback: "ui-monospace, monospace" },
];

// ── Built-in color schemes ─────────────────────────────────────────

export const BUILTIN_SCHEMES: ColorScheme[] = [
  {
    id: "mist",
    name: "Mist",
    builtin: true,
    light: {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.148 0.004 228.8)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.148 0.004 228.8)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.148 0.004 228.8)",
      "--primary": "oklch(0.218 0.008 223.9)",
      "--primary-foreground": "oklch(0.987 0.002 197.1)",
      "--secondary": "oklch(0.963 0.002 197.1)",
      "--secondary-foreground": "oklch(0.218 0.008 223.9)",
      "--muted": "oklch(0.963 0.002 197.1)",
      "--muted-foreground": "oklch(0.56 0.021 213.5)",
      "--accent": "oklch(0.963 0.002 197.1)",
      "--accent-foreground": "oklch(0.218 0.008 223.9)",
      "--destructive": "oklch(0.577 0.245 27.325)",
      "--border": "oklch(0.925 0.005 214.3)",
      "--input": "oklch(0.925 0.005 214.3)",
      "--ring": "oklch(0.723 0.014 214.4)",
      "--chart-1": "oklch(0.872 0.007 219.6)",
      "--chart-2": "oklch(0.56 0.021 213.5)",
      "--chart-3": "oklch(0.45 0.017 213.2)",
      "--chart-4": "oklch(0.378 0.015 216)",
      "--chart-5": "oklch(0.275 0.011 216.9)",
      "--sidebar": "oklch(0.987 0.002 197.1)",
      "--sidebar-foreground": "oklch(0.148 0.004 228.8)",
      "--sidebar-primary": "oklch(0.218 0.008 223.9)",
      "--sidebar-primary-foreground": "oklch(0.987 0.002 197.1)",
      "--sidebar-accent": "oklch(0.963 0.002 197.1)",
      "--sidebar-accent-foreground": "oklch(0.218 0.008 223.9)",
      "--sidebar-border": "oklch(0.925 0.005 214.3)",
      "--sidebar-ring": "oklch(0.723 0.014 214.4)",
    },
    dark: {
      "--background": "oklch(0.148 0.004 228.8)",
      "--foreground": "oklch(0.987 0.002 197.1)",
      "--card": "oklch(0.218 0.008 223.9)",
      "--card-foreground": "oklch(0.987 0.002 197.1)",
      "--popover": "oklch(0.218 0.008 223.9)",
      "--popover-foreground": "oklch(0.987 0.002 197.1)",
      "--primary": "oklch(0.925 0.005 214.3)",
      "--primary-foreground": "oklch(0.218 0.008 223.9)",
      "--secondary": "oklch(0.275 0.011 216.9)",
      "--secondary-foreground": "oklch(0.987 0.002 197.1)",
      "--muted": "oklch(0.275 0.011 216.9)",
      "--muted-foreground": "oklch(0.723 0.014 214.4)",
      "--accent": "oklch(0.275 0.011 216.9)",
      "--accent-foreground": "oklch(0.987 0.002 197.1)",
      "--destructive": "oklch(0.704 0.191 22.216)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.56 0.021 213.5)",
      "--chart-1": "oklch(0.872 0.007 219.6)",
      "--chart-2": "oklch(0.56 0.021 213.5)",
      "--chart-3": "oklch(0.45 0.017 213.2)",
      "--chart-4": "oklch(0.378 0.015 216)",
      "--chart-5": "oklch(0.275 0.011 216.9)",
      "--sidebar": "oklch(0.218 0.008 223.9)",
      "--sidebar-foreground": "oklch(0.987 0.002 197.1)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.987 0.002 197.1)",
      "--sidebar-accent": "oklch(0.275 0.011 216.9)",
      "--sidebar-accent-foreground": "oklch(0.987 0.002 197.1)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
      "--sidebar-ring": "oklch(0.56 0.021 213.5)",
    },
  },
  {
    id: "zinc",
    name: "Zinc",
    builtin: true,
    light: {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.141 0.005 285.823)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.141 0.005 285.823)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.141 0.005 285.823)",
      "--primary": "oklch(0.21 0.006 285.885)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--secondary": "oklch(0.967 0.001 286.375)",
      "--secondary-foreground": "oklch(0.21 0.006 285.885)",
      "--muted": "oklch(0.967 0.001 286.375)",
      "--muted-foreground": "oklch(0.552 0.016 285.938)",
      "--accent": "oklch(0.967 0.001 286.375)",
      "--accent-foreground": "oklch(0.21 0.006 285.885)",
      "--destructive": "oklch(0.577 0.245 27.325)",
      "--border": "oklch(0.92 0.004 286.32)",
      "--input": "oklch(0.92 0.004 286.32)",
      "--ring": "oklch(0.705 0.015 286.067)",
      "--chart-1": "oklch(0.871 0.006 286.286)",
      "--chart-2": "oklch(0.552 0.016 285.938)",
      "--chart-3": "oklch(0.442 0.017 285.786)",
      "--chart-4": "oklch(0.37 0.013 285.805)",
      "--chart-5": "oklch(0.274 0.006 286.033)",
      "--sidebar": "oklch(0.985 0 0)",
      "--sidebar-foreground": "oklch(0.141 0.005 285.823)",
      "--sidebar-primary": "oklch(0.21 0.006 285.885)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": "oklch(0.967 0.001 286.375)",
      "--sidebar-accent-foreground": "oklch(0.21 0.006 285.885)",
      "--sidebar-border": "oklch(0.92 0.004 286.32)",
      "--sidebar-ring": "oklch(0.705 0.015 286.067)",
    },
    dark: {
      "--background": "oklch(0.141 0.005 285.823)",
      "--foreground": "oklch(0.985 0 0)",
      "--card": "oklch(0.21 0.006 285.885)",
      "--card-foreground": "oklch(0.985 0 0)",
      "--popover": "oklch(0.21 0.006 285.885)",
      "--popover-foreground": "oklch(0.985 0 0)",
      "--primary": "oklch(0.92 0.004 286.32)",
      "--primary-foreground": "oklch(0.21 0.006 285.885)",
      "--secondary": "oklch(0.274 0.006 286.033)",
      "--secondary-foreground": "oklch(0.985 0 0)",
      "--muted": "oklch(0.274 0.006 286.033)",
      "--muted-foreground": "oklch(0.705 0.015 286.067)",
      "--accent": "oklch(0.274 0.006 286.033)",
      "--accent-foreground": "oklch(0.985 0 0)",
      "--destructive": "oklch(0.704 0.191 22.216)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.552 0.016 285.938)",
      "--chart-1": "oklch(0.871 0.006 286.286)",
      "--chart-2": "oklch(0.552 0.016 285.938)",
      "--chart-3": "oklch(0.442 0.017 285.786)",
      "--chart-4": "oklch(0.37 0.013 285.805)",
      "--chart-5": "oklch(0.274 0.006 286.033)",
      "--sidebar": "oklch(0.21 0.006 285.885)",
      "--sidebar-foreground": "oklch(0.985 0 0)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": "oklch(0.274 0.006 286.033)",
      "--sidebar-accent-foreground": "oklch(0.985 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
      "--sidebar-ring": "oklch(0.552 0.016 285.938)",
    },
  },
  {
    id: "slate",
    name: "Slate",
    builtin: true,
    light: {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.129 0.042 264.695)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.129 0.042 264.695)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.129 0.042 264.695)",
      "--primary": "oklch(0.208 0.042 265.755)",
      "--primary-foreground": "oklch(0.984 0.003 247.858)",
      "--secondary": "oklch(0.968 0.007 247.896)",
      "--secondary-foreground": "oklch(0.208 0.042 265.755)",
      "--muted": "oklch(0.968 0.007 247.896)",
      "--muted-foreground": "oklch(0.554 0.046 257.417)",
      "--accent": "oklch(0.968 0.007 247.896)",
      "--accent-foreground": "oklch(0.208 0.042 265.755)",
      "--destructive": "oklch(0.577 0.245 27.325)",
      "--border": "oklch(0.929 0.013 255.508)",
      "--input": "oklch(0.929 0.013 255.508)",
      "--ring": "oklch(0.704 0.04 256.788)",
      "--chart-1": "oklch(0.646 0.222 41.116)",
      "--chart-2": "oklch(0.6 0.118 184.704)",
      "--chart-3": "oklch(0.398 0.07 227.392)",
      "--chart-4": "oklch(0.828 0.189 84.429)",
      "--chart-5": "oklch(0.769 0.188 70.08)",
      "--sidebar": "oklch(0.984 0.003 247.858)",
      "--sidebar-foreground": "oklch(0.129 0.042 264.695)",
      "--sidebar-primary": "oklch(0.208 0.042 265.755)",
      "--sidebar-primary-foreground": "oklch(0.984 0.003 247.858)",
      "--sidebar-accent": "oklch(0.968 0.007 247.896)",
      "--sidebar-accent-foreground": "oklch(0.208 0.042 265.755)",
      "--sidebar-border": "oklch(0.929 0.013 255.508)",
      "--sidebar-ring": "oklch(0.704 0.04 256.788)",
    },
    dark: {
      "--background": "oklch(0.129 0.042 264.695)",
      "--foreground": "oklch(0.984 0.003 247.858)",
      "--card": "oklch(0.208 0.042 265.755)",
      "--card-foreground": "oklch(0.984 0.003 247.858)",
      "--popover": "oklch(0.208 0.042 265.755)",
      "--popover-foreground": "oklch(0.984 0.003 247.858)",
      "--primary": "oklch(0.929 0.013 255.508)",
      "--primary-foreground": "oklch(0.208 0.042 265.755)",
      "--secondary": "oklch(0.279 0.041 260.031)",
      "--secondary-foreground": "oklch(0.984 0.003 247.858)",
      "--muted": "oklch(0.279 0.041 260.031)",
      "--muted-foreground": "oklch(0.704 0.04 256.788)",
      "--accent": "oklch(0.279 0.041 260.031)",
      "--accent-foreground": "oklch(0.984 0.003 247.858)",
      "--destructive": "oklch(0.704 0.191 22.216)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.551 0.027 264.364)",
      "--chart-1": "oklch(0.488 0.243 264.376)",
      "--chart-2": "oklch(0.696 0.17 162.48)",
      "--chart-3": "oklch(0.769 0.188 70.08)",
      "--chart-4": "oklch(0.627 0.265 303.9)",
      "--chart-5": "oklch(0.645 0.246 16.439)",
      "--sidebar": "oklch(0.208 0.042 265.755)",
      "--sidebar-foreground": "oklch(0.984 0.003 247.858)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.984 0.003 247.858)",
      "--sidebar-accent": "oklch(0.279 0.041 260.031)",
      "--sidebar-accent-foreground": "oklch(0.984 0.003 247.858)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
      "--sidebar-ring": "oklch(0.551 0.027 264.364)",
    },
  },
  {
    id: "stone",
    name: "Stone",
    builtin: true,
    light: {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.147 0.004 49.25)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.147 0.004 49.25)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.147 0.004 49.25)",
      "--primary": "oklch(0.216 0.006 56.043)",
      "--primary-foreground": "oklch(0.985 0.001 106.423)",
      "--secondary": "oklch(0.97 0.001 106.424)",
      "--secondary-foreground": "oklch(0.216 0.006 56.043)",
      "--muted": "oklch(0.97 0.001 106.424)",
      "--muted-foreground": "oklch(0.553 0.013 58.071)",
      "--accent": "oklch(0.97 0.001 106.424)",
      "--accent-foreground": "oklch(0.216 0.006 56.043)",
      "--destructive": "oklch(0.577 0.245 27.325)",
      "--border": "oklch(0.923 0.003 48.717)",
      "--input": "oklch(0.923 0.003 48.717)",
      "--ring": "oklch(0.709 0.01 56.259)",
      "--chart-1": "oklch(0.869 0.005 56.366)",
      "--chart-2": "oklch(0.553 0.013 58.071)",
      "--chart-3": "oklch(0.444 0.011 73.639)",
      "--chart-4": "oklch(0.374 0.01 67.558)",
      "--chart-5": "oklch(0.268 0.007 34.298)",
      "--sidebar": "oklch(0.985 0.001 106.423)",
      "--sidebar-foreground": "oklch(0.147 0.004 49.25)",
      "--sidebar-primary": "oklch(0.216 0.006 56.043)",
      "--sidebar-primary-foreground": "oklch(0.985 0.001 106.423)",
      "--sidebar-accent": "oklch(0.97 0.001 106.424)",
      "--sidebar-accent-foreground": "oklch(0.216 0.006 56.043)",
      "--sidebar-border": "oklch(0.923 0.003 48.717)",
      "--sidebar-ring": "oklch(0.709 0.01 56.259)",
    },
    dark: {
      "--background": "oklch(0.147 0.004 49.25)",
      "--foreground": "oklch(0.985 0.001 106.423)",
      "--card": "oklch(0.216 0.006 56.043)",
      "--card-foreground": "oklch(0.985 0.001 106.423)",
      "--popover": "oklch(0.216 0.006 56.043)",
      "--popover-foreground": "oklch(0.985 0.001 106.423)",
      "--primary": "oklch(0.923 0.003 48.717)",
      "--primary-foreground": "oklch(0.216 0.006 56.043)",
      "--secondary": "oklch(0.268 0.007 34.298)",
      "--secondary-foreground": "oklch(0.985 0.001 106.423)",
      "--muted": "oklch(0.268 0.007 34.298)",
      "--muted-foreground": "oklch(0.709 0.01 56.259)",
      "--accent": "oklch(0.268 0.007 34.298)",
      "--accent-foreground": "oklch(0.985 0.001 106.423)",
      "--destructive": "oklch(0.704 0.191 22.216)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.553 0.013 58.071)",
      "--chart-1": "oklch(0.869 0.005 56.366)",
      "--chart-2": "oklch(0.553 0.013 58.071)",
      "--chart-3": "oklch(0.444 0.011 73.639)",
      "--chart-4": "oklch(0.374 0.01 67.558)",
      "--chart-5": "oklch(0.268 0.007 34.298)",
      "--sidebar": "oklch(0.216 0.006 56.043)",
      "--sidebar-foreground": "oklch(0.985 0.001 106.423)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.985 0.001 106.423)",
      "--sidebar-accent": "oklch(0.268 0.007 34.298)",
      "--sidebar-accent-foreground": "oklch(0.985 0.001 106.423)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
      "--sidebar-ring": "oklch(0.553 0.013 58.071)",
    },
  },
  {
    id: "neutral",
    name: "Neutral",
    builtin: true,
    light: {
      "--background": "oklch(1 0 0)",
      "--foreground": "oklch(0.145 0 0)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.145 0 0)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.145 0 0)",
      "--primary": "oklch(0.205 0 0)",
      "--primary-foreground": "oklch(0.985 0 0)",
      "--secondary": "oklch(0.97 0 0)",
      "--secondary-foreground": "oklch(0.205 0 0)",
      "--muted": "oklch(0.97 0 0)",
      "--muted-foreground": "oklch(0.556 0 0)",
      "--accent": "oklch(0.97 0 0)",
      "--accent-foreground": "oklch(0.205 0 0)",
      "--destructive": "oklch(0.577 0.245 27.325)",
      "--border": "oklch(0.922 0 0)",
      "--input": "oklch(0.922 0 0)",
      "--ring": "oklch(0.708 0 0)",
      "--chart-1": "oklch(0.87 0 0)",
      "--chart-2": "oklch(0.556 0 0)",
      "--chart-3": "oklch(0.439 0 0)",
      "--chart-4": "oklch(0.371 0 0)",
      "--chart-5": "oklch(0.269 0 0)",
      "--sidebar": "oklch(0.985 0 0)",
      "--sidebar-foreground": "oklch(0.145 0 0)",
      "--sidebar-primary": "oklch(0.205 0 0)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": "oklch(0.97 0 0)",
      "--sidebar-accent-foreground": "oklch(0.205 0 0)",
      "--sidebar-border": "oklch(0.922 0 0)",
      "--sidebar-ring": "oklch(0.708 0 0)",
    },
    dark: {
      "--background": "oklch(0.145 0 0)",
      "--foreground": "oklch(0.985 0 0)",
      "--card": "oklch(0.205 0 0)",
      "--card-foreground": "oklch(0.985 0 0)",
      "--popover": "oklch(0.205 0 0)",
      "--popover-foreground": "oklch(0.985 0 0)",
      "--primary": "oklch(0.922 0 0)",
      "--primary-foreground": "oklch(0.205 0 0)",
      "--secondary": "oklch(0.269 0 0)",
      "--secondary-foreground": "oklch(0.985 0 0)",
      "--muted": "oklch(0.269 0 0)",
      "--muted-foreground": "oklch(0.708 0 0)",
      "--accent": "oklch(0.269 0 0)",
      "--accent-foreground": "oklch(0.985 0 0)",
      "--destructive": "oklch(0.704 0.191 22.216)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.556 0 0)",
      "--chart-1": "oklch(0.87 0 0)",
      "--chart-2": "oklch(0.556 0 0)",
      "--chart-3": "oklch(0.439 0 0)",
      "--chart-4": "oklch(0.371 0 0)",
      "--chart-5": "oklch(0.269 0 0)",
      "--sidebar": "oklch(0.205 0 0)",
      "--sidebar-foreground": "oklch(0.985 0 0)",
      "--sidebar-primary": "oklch(0.488 0.243 264.376)",
      "--sidebar-primary-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": "oklch(0.269 0 0)",
      "--sidebar-accent-foreground": "oklch(0.985 0 0)",
      "--sidebar-border": "oklch(1 0 0 / 10%)",
      "--sidebar-ring": "oklch(0.556 0 0)",
    },
  },
];

// ── Application logic ──────────────────────────────────────────────

const STORAGE_KEY = "appearance-prefs";
const USER_SCHEMES_KEY = "appearance-custom-schemes";

export function loadPrefs(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: AppearancePrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function loadCustomSchemes(): ColorScheme[] {
  try {
    const raw = localStorage.getItem(USER_SCHEMES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveCustomSchemes(schemes: ColorScheme[]): void {
  localStorage.setItem(USER_SCHEMES_KEY, JSON.stringify(schemes));
}

export function getAllSchemes(): ColorScheme[] {
  return [...BUILTIN_SCHEMES, ...loadCustomSchemes()];
}

export function resolveScheme(id: ColorSchemeId): ColorScheme | undefined {
  return getAllSchemes().find((s) => s.id === id);
}

/** Apply appearance prefs to the DOM. Call on mount and on pref change. */
export function applyAppearance(
  prefs: AppearancePrefs,
  resolvedTheme: "light" | "dark",
): void {
  const el = document.documentElement;

  // Fonts
  const bodyFont = BODY_FONTS.find((f) => f.family === prefs.bodyFont) ?? BODY_FONTS[0];
  const headingFont = HEADING_FONTS.find((f) => f.family === prefs.headingFont) ?? HEADING_FONTS[0];
  el.style.setProperty("--font-sans", `"${bodyFont.family}", ${bodyFont.fallback}`);
  el.style.setProperty("--font-display", `"${headingFont.family}", ${headingFont.fallback}`);

  // Color scheme
  const scheme = resolveScheme(prefs.colorScheme);
  if (scheme) {
    const vars = resolvedTheme === "dark" ? scheme.dark : scheme.light;
    for (const [key, value] of Object.entries(vars)) {
      el.style.setProperty(key, value);
    }
  }
}
