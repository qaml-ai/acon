# Implementation Feedback: Theme Config + Appearance Customization

## What's Working

- Color scheme switching — all 5 built-in themes (mist, zinc, slate, stone, neutral) apply correctly
- `appearance.ts` data layer is clean — framework-agnostic, extensible for custom schemes
- `AppearanceProvider` correctly coordinates with `next-themes` for light/dark reapplication
- FOUC prevention script in `desktop/renderer/index.html` is correctly placed
- `components.json` updated (baseColor → mist, CSS path fixed)
- Mist theme variables in `globals.css` — oklch values look correct
- All 72 .woff2 files are present in `public/fonts/`
- `@font-face` declarations for all 9 font families × 8 variants are in `globals.css`
- Sidebar Settings button and AppearanceDialog are correctly wired
- `AppearanceProvider` is mounted in `main.tsx` inside `ThemeProvider` — correct order
- `ColorSchemePreference` swatch grid with radio group accessibility is well done
- `FontPreference` correctly uses `useAppearance()` hook and inline `fontFamily` styles
- `SKILL.md` updated with new config values
- `--font-mono` updated from `var(--font-geist-mono)` to explicit `"GeistMono"` font-face name

---

## Critical: Fonts Not Loading

### Root cause: Vite `publicDir` mismatch

The `@font-face` declarations in `globals.css` use absolute paths like:
```css
src: url("/fonts/Figtree-Regular.woff2") format("woff2");
```

But the Vite config (`desktop/vite.config.ts`) sets `root: resolve(__dirname, 'renderer')`, which means Vite's dev server looks for a `public/` directory at `desktop/renderer/public/` — **this directory does not exist**. The actual font files are at the project-root `public/fonts/`.

Vite only serves static assets from `{root}/public/` by default. Since the Vite root is `desktop/renderer/`, requests to `/fonts/Figtree-Regular.woff2` return 404.

### Fix (choose one)

**Option A (recommended):** Add `publicDir` to the Vite config pointing to the project-root public directory:

```ts
// desktop/vite.config.ts
export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  publicDir: resolve(__dirname, '../public'),  // ← add this
  // ...rest unchanged
});
```

**Option B:** Symlink or copy `public/` into `desktop/renderer/public/`.

**Option C:** Change all `@font-face` `src` URLs to relative paths from the CSS file location, but this is fragile with Tailwind's CSS processing.

Option A is the simplest and most correct fix.

### Why font previews in Select dropdowns also don't work

The `style={{ fontFamily: font.family }}` on `SelectItem` in `font-preference.tsx` is correct in principle, but since the `@font-face` rules can't load (404), the browser falls back to the system default (Arial/Helvetica). Once the Vite publicDir fix is applied, the inline `fontFamily` styles should work since all fonts have `@font-face` declarations in `globals.css`.

---

## Critical: Avatar Component Reinstall Broke Custom API

The `--overwrite` reinstall of `avatar.tsx` **destroyed project-specific customizations** that are actively used across the codebase. The plan explicitly warned to review the diff before committing — this is why.

### What was lost

1. **Custom size variants removed:** The project had 7 Avatar sizes (`2xs`, `xs`, `sm`, `md`, `default`, `lg`, `xl`) with per-size font scaling. The reinstall replaced this with only 3 sizes (`sm`, `default`, `lg`). **15+ components** across the codebase still reference the removed sizes:
   - `size="xl"` — used in `_admin.users.$id.tsx`, `avatar-picker.tsx`, `profile-form.tsx`, `workspace-general-form.tsx`, `workspace-edit-form.tsx`
   - `size="xs"` — used in `container-loading-dialog.tsx`, `AppCard.tsx`, `switch-workspace-dialog.tsx`, `chat-row.tsx`
   - `size="2xs"` — used in `AppCard.tsx`, `chat-row.tsx`
   - `size="md"` — used in `workspace-switcher.tsx`

2. **`content` prop removed from `AvatarFallback`:** The project had a custom `content` prop that powered emoji detection and character-count-based font sizing. **8 components** still pass `content=` to `AvatarFallback`:
   - `desktop-sidebar.tsx:90` — `<AvatarFallback content="CA">`
   - `AppCard.tsx`, `chat-row.tsx`, `team-table.tsx`, `workspace-switcher.tsx`, `nav-user.tsx`

3. **`AvatarSizeContext` and `isEmoji` import removed:** The font-sizing logic that used `Intl.Segmenter` for proper emoji/grapheme handling is gone.

### Fix

Restore `avatar.tsx` to the pre-reinstall version. It was already customized for a reason — it should not have been in the `--overwrite` list. Run:
```bash
git checkout main -- src/components/ui/avatar.tsx
```

Then re-apply only the class reordering changes from the reinstall if desired (purely cosmetic Tailwind class sorting).

---

## High: Incomplete `hsl(var(--background))` Fix in Desktop Styles

The plan called for replacing all 49 `hsl(var(--...))` occurrences in `desktop/renderer/src/styles.css`. The fix was **partially applied** — simple `var(--...)` references were fixed (body background, borders, foreground colors), but **24 instances of `hsl(var(--background))` remain** inside `color-mix()` expressions throughout the file.

These produce invalid CSS like `color-mix(in oklab, hsl(oklch(1 0 0)) 82%, white 18%)` — `hsl()` wrapping an `oklch()` value. Browsers will silently drop these declarations, causing the titlebar, tabs, and toolbar controls to lose their gradient/translucency effects.

### Remaining occurrences

All 24 are `hsl(var(--background))` inside `color-mix()` calls:
- **Titlebar gradients** (lines 50-52, 64-66)
- **Toolbar controls** (lines 118, 123)
- **Toolbar badge** (lines 129, 134)
- **New thread button** (lines 139, 144)
- **Workbench tab backgrounds** (lines 196-197, 207-208, 232-233, 242-243)
- **Active tab** (lines 252, 256)
- **Chat model switcher** (lines 344, 349)

### Fix

Find-and-replace all remaining `hsl(var(--background))` → `var(--background)` in `desktop/renderer/src/styles.css`.

---

## High: `hsl()` Wrapper in Reinstalled Sidebar Component

The shadcn component reinstall introduced a new `hsl(var(--...))` occurrence in `src/components/ui/sidebar.tsx` line 481:

```tsx
"bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]"
```

This is the same `hsl(oklch(...))` mismatch bug. The reinstalled component assumes HSL variables but the project uses oklch. Fix by replacing `hsl(var(--sidebar-border))` → `var(--sidebar-border)` and `hsl(var(--sidebar-accent))` → `var(--sidebar-accent)` in the Tailwind arbitrary value.

**Note:** This may indicate that other reinstalled components also assume HSL. Grep all reinstalled component files for `hsl(var(--`:

```bash
grep -r "hsl(var(--" src/components/ui/
```

---

## Medium: .ttf Files Not Deleted

The plan's Step 1.4c called for `rm public/fonts/*.ttf`. The 5 original .ttf files are still present:
- `Figtree-Bold.ttf`, `Figtree-Regular.ttf`
- `GeistMono-Bold.ttf`, `GeistMono-Regular.ttf`
- `SourceSerif4-Regular.ttf`

These are dead weight (~1.6MB) now that .woff2 versions exist for all fonts. Delete them.

**Caveat:** `src/components/chat-file-preview/notebook-preview/pdf-export.ts` references `.ttf` files at lines 125-126 (`GeistMono-Regular.ttf`, `GeistMono-Bold.ttf`). Either:
- Keep those two .ttf files for PDF export, or
- Update the references to .woff2 (but verify `@react-pdf/renderer` supports .woff2 first)

---

## Low: Radius Changed Beyond Plan

The plan specified `--radius: 0.75rem` (large). The implementation used `--radius: 0.875rem` and changed the radius calculation formulas from additive to multiplicative:

```css
/* Plan specified */
--radius: 0.75rem;
--radius-sm: calc(var(--radius) - 4px);

/* Actually implemented */
--radius: 0.875rem;
--radius-sm: calc(var(--radius) * 0.6);
```

This likely came from running the shadcn preset directly. The multiplicative approach is arguably better (scales proportionally), but `0.875rem` is larger than planned. Verify this looks right visually — if elements look too rounded, try `0.75rem` with the multiplicative formulas.

---

## Low: Component Reinstall — Other Changes to Review

The `--overwrite` reinstall touched 27 component files. Most changes are harmless Tailwind class reordering (alphabetization), but a few are worth verifying:

1. **`toggle-group.tsx`** — Fully rewritten to import `toggleVariants` from `toggle.tsx` instead of defining its own `toggleGroupItemVariants`. The variant/size APIs changed. Verify any code that uses `ToggleGroup` or `ToggleGroupItem` still compiles and renders correctly.

2. **`sidebar.tsx`** — Fixed `"offExamples"` → `"offcanvas"` (this was a pre-existing typo, so this is a good fix). Also added `dir` prop support. Added `hsl()` wrapper issue noted above.

3. **`resizable.tsx`** — Check for API changes since this component has custom drag handle styling.

4. **`sonner.tsx`** — Minor changes, verify toast notifications still render.

The remaining component diffs (alert, badge, button, card, checkbox, dialog, dropdown-menu, input, label, pagination, etc.) appear to be purely Tailwind class reordering with no functional changes.

---

## Summary of Required Fixes

| Priority | Issue | Effort |
|---|---|---|
| **Critical** | Add `publicDir` to `desktop/vite.config.ts` so fonts load | 1 line |
| **Critical** | Restore `avatar.tsx` — reinstall broke custom sizes + `content` prop used in 15+ files | `git checkout` + selective merge |
| **High** | Replace remaining 24 `hsl(var(--background))` in `desktop/renderer/src/styles.css` | Find-and-replace |
| **High** | Fix `hsl(var(--sidebar-border))` in reinstalled `sidebar.tsx` line 481 | 2 string replacements |
| **Medium** | Delete 5 .ttf files (check pdf-export.ts first) | 1 command |
| **Low** | Verify radius 0.875rem looks right visually | Manual check |
| **Low** | Verify `toggle-group.tsx` rewrite doesn't break existing usage | Grep + test |
