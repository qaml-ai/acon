# Plan: Update Theme Config + User Appearance Customization

## Context

This is a **desktop-only Electron app**. The codebase was forked from a web app and still contains web infrastructure (`src/routes/`, `src/root.tsx`, server files, etc.) that will be cleaned up by another developer. This plan ignores all web app code and builds exclusively on the desktop app's architecture.

**Desktop app entry point:** `desktop/renderer/src/main.tsx` → `App.tsx`
**Desktop app structure:** Flat Vite SPA with sidebar (`DesktopSidebar`), titlebar with workbench tabs, and content panes. No router — views are rendered via a plugin/surface system. State comes from a backend service over WebSocket/IPC.
**Shared code used by desktop:** `src/components/ui/*` (shadcn), `src/components/theme-provider.tsx`, `src/styles/globals.css`, `src/lib/utils`, `src/lib/streaming`, `src/types`

This plan covers two phases:

1. **Phase 1 — Theme migration**: Fix color system bug, migrate from zinc to mist theme, increase radius, convert fonts to .woff2
2. **Phase 2 — Appearance settings UI**: Let users customize fonts, color mode, and color scheme from within the desktop app

---

## Phase 1: Theme Migration

### Summary of Changes

| Setting | Current | New |
|---|---|---|
| Base color | zinc | mist |
| Theme / Chart colors | zinc palette | mist palette |
| Heading font (`--font-display`) | Source Serif 4 | Source Serif 4 (no change) |
| Body font (`--font-sans`) | Figtree | Figtree (no change) |
| Radius | 0.625rem | 0.75rem (large) |
| Font format | .ttf, 2 weights (~1.6MB) | .woff2, 4 weights + italics (~1.9MB for 9 families × 8 variants) |
| Desktop color system | broken `hsl(oklch(...))` | fixed `var(--...)` directly |
| Style | radix-mira | radix-mira (no change) |
| Icons | Lucide | Lucide (no change) |

### Step 1.0: Fix Desktop `hsl()` / `oklch()` Mismatch (Pre-existing Bug)

**File:** `desktop/renderer/src/styles.css`

The desktop renderer styles wrap theme CSS variables with `hsl()` (e.g. `background: hsl(var(--background))`), but `globals.css` defines those variables as full oklch color values (e.g. `--background: oklch(1 0 0)`). This produces invalid CSS like `hsl(oklch(1 0 0))`. There are **49 occurrences** of this pattern.

**Fix:** Replace all `hsl(var(--...))` with `var(--...)` throughout the file. The oklch values are already complete color values — they don't need a function wrapper.

For example:
```css
/* Before */
background: hsl(var(--background));
border-bottom: 1px solid color-mix(in oklab, hsl(var(--border)) 78%, transparent);

/* After */
background: var(--background);
border-bottom: 1px solid color-mix(in oklab, var(--border) 78%, transparent);
```

Apply this find-and-replace across the entire file. The `color-mix()` calls continue to work — they accept any CSS color as arguments.

### Step 1.1: Generate the New Theme CSS Variables

Use the shadcn preset to generate the exact mist theme values:

```bash
# In a temporary directory, run:
npx shadcn@latest init --preset b4cwnZvlhI
```

This will generate a `globals.css` with the complete mist theme (light + dark mode CSS custom properties, chart colors, sidebar colors). Extract the `:root` and `.dark` blocks from the generated output — these are the replacement values for Step 1.3.

**Important:** The preset generates the authoritative color values. Do NOT hand-write oklch values — use only what the preset produces.

### Step 1.2: Update `components.json`

**File:** `components.json` (project root)

Two changes needed:

1. Update `baseColor` from `"zinc"` to `"mist"`
2. Fix the CSS path from `"src/app/globals.css"` to `"src/styles/globals.css"` (pre-existing bug)

Result:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-mira",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/globals.css",
    "baseColor": "mist",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "registries": {}
}
```

### Step 1.3: Replace Theme CSS Variables in `globals.css`

**File:** `src/styles/globals.css`

Replace the `:root { ... }` block (lines 123-156) and `.dark { ... }` block (lines 158-190) with the mist theme values generated from Step 1.1.

Additionally, update the `--radius` value:
```css
--radius: 0.75rem;  /* was 0.625rem */
```

**What to preserve (do NOT overwrite):**
- Everything above line 123 (`@import` statements, `@custom-variant` blocks, `@utility`, `@theme inline` block)
- Everything below line 190 (`@layer base`, markdown styles, keyframe animations, all custom CSS)
- The `@theme inline` block (lines 77-121) does NOT need changes — it maps CSS variables to Tailwind tokens and is theme-agnostic

**What to replace:**
- Only the `:root { ... }` and `.dark { ... }` blocks (the raw CSS custom property definitions)

### Step 1.4: Convert All Fonts to .woff2

.woff2 is fully supported in Electron (Chromium) and dramatically smaller than .ttf. All .woff2 files are **already downloaded** and in `public/fonts/`.

#### Font weights rationale

The codebase uses four Tailwind font-weight classes:
- `font-normal` (400) — 8 uses
- `font-medium` (500) — **186 uses** (labels, nav items, card titles, shadcn component internals)
- `font-semibold` (600) — **52 uses** (section headings, emphasis)
- `font-bold` (700) — 6 uses

Previously only 400 and 700 were bundled, meaning all 238 uses of `font-medium` and `font-semibold` were browser-synthesized — the font engine guesses rather than using the designed weight. Now each font includes all four weights plus italics (needed for markdown `*emphasis*` and blockquotes).

#### Font file inventory

Every font family ships **8 variants**: Regular, Italic, Medium, MediumItalic, SemiBold, SemiBoldItalic, Bold, BoldItalic (.woff2 format).

**All 72 files are already downloaded in `public/fonts/`. No download action needed.**

| Font Family | Files | Size per file | Total |
|---|---|---|---|
| Figtree (body, default) | 8 | 11-12K | ~92K |
| Inter (body option) | 8 | 23-25K | ~194K |
| DM Sans (body option) | 8 | 14-15K | ~116K |
| Plus Jakarta Sans (body option) | 8 | 12-13K | ~100K |
| Source Serif 4 (heading, default) | 8 | 20-24K | ~168K |
| Merriweather (heading option) | 8 | 48-51K | ~392K |
| Playfair Display (heading option) | 8 | 21-23K | ~176K |
| Lora (heading option) | 8 | 21-23K | ~176K |
| GeistMono (monospace, fixed) | 8 | 50-55K | ~416K |
| **Total** | **72** | | **~1.9MB** |

File naming convention: `{FontName}-{Variant}.woff2` where Variant is one of:
`Regular`, `Italic`, `Medium`, `MediumItalic`, `SemiBold`, `SemiBoldItalic`, `Bold`, `BoldItalic`

#### 1.4a. Add `@font-face` declarations

Add `@font-face` rules to `src/styles/globals.css` (at the top, after the `@import` lines but before `@custom-variant`).

For Phase 1, declare the three default font families with all 8 variants each. Use this pattern for every variant (example showing Figtree — repeat for all weights/styles):

```css
/* ── Figtree (body sans-serif) ── */
@font-face {
  font-family: "Figtree";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/Figtree-Regular.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/Figtree-Italic.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("/fonts/Figtree-Medium.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: italic;
  font-weight: 500;
  font-display: swap;
  src: url("/fonts/Figtree-MediumItalic.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("/fonts/Figtree-SemiBold.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: italic;
  font-weight: 600;
  font-display: swap;
  src: url("/fonts/Figtree-SemiBoldItalic.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/Figtree-Bold.woff2") format("woff2");
}
@font-face {
  font-family: "Figtree";
  font-style: italic;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/Figtree-BoldItalic.woff2") format("woff2");
}

/* ── Source Serif 4 (heading serif) ── same 8-variant pattern ── */
/* ── GeistMono (monospace) ── same 8-variant pattern ── */
```

That's 24 `@font-face` rules for Phase 1 (3 families × 8 variants). In Phase 2, the remaining 5 font families (40 more rules) get added — see Step 2.5.

#### 1.4b. Update `--font-mono` CSS variable

In the `@theme inline` block, update the mono font variable to use the explicit font-face name instead of a Next.js variable:

```css
--font-mono: "GeistMono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

#### 1.4c. Delete all .ttf files

Remove all `.ttf` files from `public/fonts/`:
```bash
rm public/fonts/*.ttf
```

### Step 1.5: Update Font References for .woff2 Migration

Search the codebase for any references to `.ttf` font filenames and update them:

```bash
grep -r "\.ttf" src/ desktop/
```

Known locations to check:
- PDF export configuration (search for `@react-pdf/renderer` usage) — font registration may reference filenames. Note: `@react-pdf/renderer` may not support .woff2 — if so, keep one .ttf copy for PDF export only
- Any `@font-face` declarations outside of `globals.css`

Also remove the **Google Fonts CDN link** in `src/root.tsx` (line 26-35) — these fonts are now self-hosted. This line will likely be removed when the web app cleanup happens, but flag it if it's still present.

### Step 1.6: Update the SKILL.md Documentation

**File:** `.claude/skills/shadcn-components/SKILL.md`

Update the "Current Project Configuration" section to reflect the new config:
- Base color: mist
- Theme: mist
- Chart Color: mist
- Heading: Source Serif 4
- Font: Figtree
- Radius: Large (0.75rem)

Remove references to the old zinc/Inter config.

### Step 1.7: Reinstall All Existing shadcn Components

After the theme update, reinstall all standard components so they pick up any style changes from the new base color / theme:

```bash
npx shadcn@latest add alert-dialog alert avatar badge breadcrumb button card checkbox collapsible context-menu dialog dropdown-menu input label pagination progress radio-group resizable scroll-area select separator sheet sidebar skeleton sonner switch table tabs textarea toggle-group tooltip --overwrite
```

**Do NOT overwrite these custom components** (they are not standard shadcn components):
- `confirm-dialog.tsx`
- `input-group.tsx`
- `logo.tsx`
- `navigation-progress.tsx`
- `radial-grid-background.tsx`
- `slot-machine-prompt.tsx`

After reinstalling, review the diff to ensure no destructive changes were made to component behavior.

---

## Phase 2: User Appearance Customization

### Current State

The desktop app is a flat SPA (`desktop/renderer/src/App.tsx`) with no router. The UI has:
- A **sidebar** (`DesktopSidebar`) with workspace header, workbench views, recent chats, and a footer with a "Get Help" button
- A **titlebar** with workbench tab strip
- A **content area** that renders plugin-contributed surfaces (chat, extension lab, etc.)

Theme switching (light/dark/system) exists at `src/components/settings/theme-preference.tsx` but is currently only reachable from the web app's profile settings page — **it is not accessible from the desktop app UI**.

### Goal

Add an **Appearance settings dialog** accessible from the desktop sidebar, where users can:
1. **Color mode** — Light / Dark / System
2. **Body font** — Choose from a curated list of sans-serif fonts
3. **Heading font** — Choose from a curated list of serif/display fonts
4. **Color scheme** — Choose from built-in palettes (extensible later for user-created schemes)

### Step 2.1: Add Settings Entry Point to Desktop Sidebar

**File:** `desktop/renderer/src/desktop-sidebar.tsx`

Add a **Settings gear icon button** to the sidebar footer (next to the existing "Get Help" button). Clicking it opens the appearance dialog.

```tsx
// In the SidebarFooter, add above or next to "Get Help":
<SidebarMenuItem>
  <SidebarMenuButton tooltip="Settings" onClick={onOpenSettings}>
    <Settings />
    <span>Settings</span>
  </SidebarMenuButton>
</SidebarMenuItem>
```

Add `onOpenSettings: () => void` to `DesktopSidebarProps`.

### Step 2.2: Create the Appearance Dialog

**New file:** `desktop/renderer/src/appearance-dialog.tsx`

A shadcn `Dialog` (or `Sheet` — side panel might feel more native for a settings surface) containing all appearance controls. This is a **desktop-specific** component since the desktop app has no router/pages.

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function AppearanceDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-2">
          <ThemePreference />
          <Separator />
          <FontPreference />
          <Separator />
          <ColorSchemePreference />
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

Wire this into `App.tsx` with `useState<boolean>` for open state, passed to the sidebar's `onOpenSettings` callback.

### Step 2.3: Create the Appearance Preferences System

**New file:** `src/lib/appearance.ts`

A framework-agnostic module that defines appearance types, defaults, and the CSS application logic. No React dependencies — this is pure data + DOM manipulation so it can be used by both the FOUC prevention script and the React provider.

```ts
// ── Types ──────────────────────────────────────────────────────────

export type ColorSchemeId = string  // "mist" | "zinc" | ... | user-defined

export interface ColorScheme {
  id: string
  name: string
  light: Record<string, string>  // CSS variable name → oklch value
  dark: Record<string, string>
  builtin: boolean               // false for user-created schemes
}

export interface AppearancePrefs {
  bodyFont: string
  headingFont: string
  colorScheme: ColorSchemeId
}

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_PREFS: AppearancePrefs = {
  bodyFont: "Figtree",
  headingFont: "Source Serif 4",
  colorScheme: "mist",
}

// ── Font registry ──────────────────────────────────────────────────

export interface FontOption {
  family: string
  label: string
  description: string
  category: "sans-serif" | "serif"
  fallback: string  // CSS fallback stack
}

export const BODY_FONTS: FontOption[] = [
  { family: "Figtree",           label: "Figtree",           description: "Geometric, friendly",       category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "Inter",             label: "Inter",             description: "Clean, neutral UI standard", category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "DM Sans",           label: "DM Sans",           description: "Slightly rounded geometric", category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "Plus Jakarta Sans", label: "Plus Jakarta Sans", description: "Modern, slightly warm",      category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
]

export const HEADING_FONTS: FontOption[] = [
  { family: "Source Serif 4",    label: "Source Serif 4",    description: "Clean, versatile serif",             category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Merriweather",      label: "Merriweather",      description: "Warm, readable serif",              category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Playfair Display",  label: "Playfair Display",  description: "Elegant, high-contrast display",    category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Lora",              label: "Lora",              description: "Calligraphy-inspired, contemporary", category: "serif", fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
]

// ── Built-in color schemes ─────────────────────────────────────────
// Values generated from shadcn presets. See generation instructions below.

export const BUILTIN_SCHEMES: ColorScheme[] = [
  {
    id: "mist",
    name: "Mist",
    builtin: true,
    light: { "--background": "oklch(...)", "--foreground": "oklch(...)", /* ... all vars */ },
    dark:  { "--background": "oklch(...)", "--foreground": "oklch(...)", /* ... all vars */ },
  },
  // zinc, slate, stone, neutral — same structure
]

// ── Application logic ──────────────────────────────────────────────

const STORAGE_KEY = "appearance-prefs"
const USER_SCHEMES_KEY = "appearance-custom-schemes"

export function loadPrefs(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: AppearancePrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

export function loadCustomSchemes(): ColorScheme[] {
  try {
    const raw = localStorage.getItem(USER_SCHEMES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveCustomSchemes(schemes: ColorScheme[]): void {
  localStorage.setItem(USER_SCHEMES_KEY, JSON.stringify(schemes))
}

export function getAllSchemes(): ColorScheme[] {
  return [...BUILTIN_SCHEMES, ...loadCustomSchemes()]
}

export function resolveScheme(id: ColorSchemeId): ColorScheme | undefined {
  return getAllSchemes().find(s => s.id === id)
}

/** Apply appearance prefs to the DOM. Call on mount and on pref change. */
export function applyAppearance(prefs: AppearancePrefs, resolvedTheme: "light" | "dark"): void {
  const el = document.documentElement

  // Fonts
  const bodyFont = BODY_FONTS.find(f => f.family === prefs.bodyFont) ?? BODY_FONTS[0]
  const headingFont = HEADING_FONTS.find(f => f.family === prefs.headingFont) ?? HEADING_FONTS[0]
  el.style.setProperty("--font-sans", `"${bodyFont.family}", ${bodyFont.fallback}`)
  el.style.setProperty("--font-display", `"${headingFont.family}", ${headingFont.fallback}`)

  // Color scheme
  const scheme = resolveScheme(prefs.colorScheme)
  if (scheme) {
    const vars = resolvedTheme === "dark" ? scheme.dark : scheme.light
    for (const [key, value] of Object.entries(vars)) {
      el.style.setProperty(key, value)
    }
  }
}
```

**Why framework-agnostic:** The `applyAppearance` function can be called from both the React provider AND a tiny inline FOUC-prevention script, without importing React.

**Generating built-in scheme values:** For each scheme (mist, zinc, slate, stone, neutral), run `npx shadcn@latest init` with the appropriate base color in a temporary directory and extract the `:root` / `.dark` CSS variable blocks. Convert them into the `light` / `dark` objects in `BUILTIN_SCHEMES`. These are static, committed to source.

### Step 2.4: Create the Appearance Context Provider

**New file:** `src/components/appearance-provider.tsx`

A React context provider that:
1. Reads prefs from localStorage on mount via `loadPrefs()`
2. Calls `applyAppearance()` whenever prefs or the resolved theme change
3. Exposes `prefs` and `updatePrefs()` via context for the settings UI

```tsx
import { createContext, useContext, useEffect, useState, useCallback } from "react"
import { useTheme } from "next-themes"
import {
  type AppearancePrefs,
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  applyAppearance,
} from "@/lib/appearance"

interface AppearanceContextValue {
  prefs: AppearancePrefs
  updatePrefs: (patch: Partial<AppearancePrefs>) => void
}

const AppearanceContext = createContext<AppearanceContextValue>({
  prefs: DEFAULT_PREFS,
  updatePrefs: () => {},
})

export const useAppearance = () => useContext(AppearanceContext)

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme()
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_PREFS)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setPrefs(loadPrefs())
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    applyAppearance(prefs, (resolvedTheme as "light" | "dark") ?? "light")
  }, [prefs, resolvedTheme, mounted])

  const updatePrefs = useCallback((patch: Partial<AppearancePrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  return (
    <AppearanceContext.Provider value={{ prefs, updatePrefs }}>
      {children}
    </AppearanceContext.Provider>
  )
}
```

**Mount in:** `desktop/renderer/src/main.tsx`, inside the existing `ThemeProvider`:

```tsx
<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
  <AppearanceProvider>
    <App />
    <Toaster />
  </AppearanceProvider>
</ThemeProvider>
```

### Step 2.5: Create the Font Preference Component

**New file:** `src/components/settings/font-preference.tsx`

UI for selecting body and heading fonts. Two `Select` dropdowns.

Each option renders in its own typeface for a live preview. Uses `useAppearance()` to read/write prefs.

```
Body Font
┌──────────────────────────┐
│ Figtree                ▾ │  ← rendered in Figtree
└──────────────────────────┘
Used for all body text and UI elements.

Heading Font
┌──────────────────────────┐
│ Source Serif 4         ▾ │  ← rendered in Source Serif 4
└──────────────────────────┘
Used for headings in notebooks and reports.
```

To render each option in its typeface, apply an inline `style={{ fontFamily: font.family }}` on each `SelectItem`. All candidate fonts have `@font-face` declarations so the browser loads them on demand.

**Add `@font-face` declarations for the remaining 5 candidate font families** in `globals.css` (expanding the Phase 1 declarations). Each family gets the same 8-variant pattern (Regular, Italic, Medium, MediumItalic, SemiBold, SemiBoldItalic, Bold, BoldItalic) from Step 1.4a — that's 40 additional rules. All 72 .woff2 files are already downloaded. Fonts with `font-display: swap` are only fetched when actually referenced in the DOM, so unused fonts add zero load-time cost.

### Step 2.6: Create the Color Scheme Preference Component

**New file:** `src/components/settings/color-scheme-preference.tsx`

A grid of clickable scheme previews. Uses `useAppearance()` to read/write.

#### Built-in Schemes

| Scheme | Description |
|---|---|
| Mist | Cool blue-gray (default) |
| Zinc | Neutral gray (previous default) |
| Slate | Cool, slightly blue-tinted gray |
| Stone | Warm, slightly brown-tinted gray |
| Neutral | Pure neutral gray |

#### UI Design

Each scheme is a small card showing a mini preview — a rounded rectangle with bands of the scheme's background, primary, secondary, and border colors. The active scheme gets a ring highlight. Use a radio group for accessibility.

```
Color Scheme

  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │ ██████  │  │ ██████  │  │ ██████  │  │ ██████  │  │ ██████  │
  │ ███  ── │  │ ███  ── │  │ ███  ── │  │ ███  ── │  │ ███  ── │
  │ ──────  │  │ ──────  │  │ ──────  │  │ ──────  │  │ ──────  │
  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘
     Mist          Zinc        Slate        Stone       Neutral
    (ring)
```

Each swatch card renders its preview using inline styles from the scheme's color values (not the active theme), so you see the actual colors before selecting.

### Step 2.7: Initialize Appearance Before First Paint (FOUC Prevention)

**File:** `desktop/renderer/index.html` (or wherever the Electron renderer HTML shell lives)

Add a small inline `<script>` in `<head>` that reads appearance prefs from localStorage and applies CSS custom properties before React mounts. This prevents a flash where the default theme shows before the provider kicks in.

```html
<script>
  (function() {
    try {
      var raw = localStorage.getItem("appearance-prefs");
      if (!raw) return;
      var prefs = JSON.parse(raw);
      // Font overrides
      if (prefs.bodyFont) {
        document.documentElement.style.setProperty("--font-sans",
          '"' + prefs.bodyFont + '", ui-sans-serif, system-ui, sans-serif');
      }
      if (prefs.headingFont) {
        document.documentElement.style.setProperty("--font-display",
          '"' + prefs.headingFont + '", ui-serif, Georgia, "Times New Roman", serif');
      }
      // Color scheme — read the full scheme data from a second key
      // or inline the most critical variables (background, foreground)
      // Full scheme application happens once React mounts
    } catch(e) {}
  })();
</script>
```

This script is intentionally minimal — it handles fonts (which cause the most visible FOUC). The full color scheme application happens when `AppearanceProvider` mounts, which is fast enough to be imperceptible.

---

## Future: User-Created Color Schemes

The architecture in Step 2.3 is designed for this. The key design decisions that support it:

1. **`ColorScheme` is a plain data object** — `{ id, name, light: Record<string, string>, dark: Record<string, string>, builtin: boolean }`. User-created schemes have the exact same shape as built-in ones.

2. **Custom schemes stored separately** — `localStorage` key `appearance-custom-schemes` holds an array of user-created `ColorScheme` objects. `getAllSchemes()` merges built-in + custom.

3. **Scheme IDs are strings, not enums** — `ColorSchemeId` is `string`, not a union type. User-created schemes get unique IDs (e.g. UUID or slugified name).

4. **`resolveScheme(id)` is the single lookup** — all code that needs scheme data goes through this function, which searches both built-in and custom arrays.

When ready to implement the "create your own" UI, you'll need:
- A color picker interface (hue, saturation, lightness adjustments on top of a base scheme)
- Save/delete/rename operations on `loadCustomSchemes()` / `saveCustomSchemes()`
- An "export/import" mechanism (JSON) for sharing schemes
- The swatch grid in `ColorSchemePreference` already renders both built-in and custom schemes via `getAllSchemes()`

No architectural changes needed — just new UI on top of the existing data layer.

---

## New Files Summary

| File | Purpose |
|---|---|
| `src/lib/appearance.ts` | Types, defaults, font/scheme registries, `applyAppearance()`, localStorage helpers |
| `src/components/appearance-provider.tsx` | React context provider, coordinates with next-themes |
| `src/components/settings/font-preference.tsx` | Font selection UI (body + heading) |
| `src/components/settings/color-scheme-preference.tsx` | Color scheme selection UI (swatch grid) |
| `desktop/renderer/src/appearance-dialog.tsx` | Desktop-specific settings dialog shell |

## Modified Files Summary

| File | Change |
|---|---|
| `desktop/renderer/src/styles.css` | Fix `hsl(var(--...))` → `var(--...)` (49 occurrences) |
| `desktop/renderer/src/main.tsx` | Add `AppearanceProvider` inside `ThemeProvider` |
| `desktop/renderer/src/App.tsx` | Add settings dialog state, pass `onOpenSettings` to sidebar |
| `desktop/renderer/src/desktop-sidebar.tsx` | Add Settings button to sidebar footer |
| `desktop/renderer/index.html` | Add FOUC prevention script |
| `components.json` | baseColor → mist, fix CSS path |
| `src/styles/globals.css` | Mist theme vars, radius, all `@font-face` declarations, font var updates |
| `.claude/skills/shadcn-components/SKILL.md` | Update config docs |
| `public/fonts/` | Delete .ttf files (keep .woff2 only) |

---

## Verification Checklist

### Phase 1
- [ ] Desktop styles no longer contain `hsl(var(--...))` wrappers
- [ ] App builds without errors
- [ ] Light mode renders with mist color palette (cooler blue-gray tones, not warm zinc grays)
- [ ] Dark mode renders correctly with mist dark palette
- [ ] Border radius appears larger (0.75rem vs 0.625rem) on buttons, cards, inputs
- [ ] Headings use Source Serif 4, body text uses Figtree
- [ ] No broken font loading (check DevTools console for 404s)
- [ ] `components.json` CSS path correctly points to `src/styles/globals.css`
- [ ] All .ttf files removed, .woff2 files load correctly

### Phase 2
- [ ] Settings gear icon visible in desktop sidebar footer
- [ ] Clicking Settings opens the appearance dialog
- [ ] Color mode switcher works (light/dark/system)
- [ ] Body font selector changes all UI text immediately on selection
- [ ] Heading font selector changes notebook/report headings immediately
- [ ] Font selection persists across app restart (localStorage)
- [ ] Color scheme swatch grid shows all built-in schemes with accurate previews
- [ ] Selecting a color scheme updates all UI colors immediately
- [ ] Color scheme persists across app restart
- [ ] Switching between light/dark mode preserves the selected color scheme
- [ ] No FOUC on app launch — fonts apply before first paint
- [ ] Select dropdowns render each font option in its own typeface

## Risk Notes

- **Desktop `hsl()` vs `oklch()` mismatch** (Step 1.0): Pre-existing bug — 49 occurrences. Straightforward find-and-replace but test the titlebar, tabs, and toolbar controls carefully since they use complex `color-mix()` expressions.
- **Component reinstall** (Step 1.7): The `--overwrite` flag replaces component files. Review the git diff for any custom modifications to standard shadcn components before committing.
- **Preset fidelity**: The mist theme values MUST come from the preset (`--preset b4cwnZvlhI`). If the preset code expires, regenerate from the shadcn theme builder with the same settings.
- **Font bundle size**: 9 font families × 8 variants = 72 .woff2 files totaling ~1.9MB on disk. Only the active fonts are loaded at runtime (3 families × 8 variants = ~676K for the defaults). Acceptable for a desktop app.
- **Color scheme generation**: Each built-in scheme's CSS variable set must be generated from shadcn's official presets/init command. Do not hand-author oklch values.
- **PDF export**: If `@react-pdf/renderer` is used and references font files, it may not support .woff2. Check and keep .ttf copies for PDF if needed.
- **Web app cleanup interaction**: This plan avoids modifying web-only files (`src/routes/`, `src/root.tsx`). The other developer's cleanup should not conflict, but coordinate on `src/styles/globals.css` and `src/components/` changes.
