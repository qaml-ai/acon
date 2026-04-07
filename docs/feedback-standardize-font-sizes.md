# Feedback: Standardize Font Sizes Implementation

## Issues to Fix

### 1. `.font-display` utility may not work — move into `@utility`

The `.font-display` class in `src/styles/globals.css` (line 587) is defined as a plain CSS rule outside any Tailwind layer. In Tailwind v4, custom utilities should use `@utility` so they participate in the cascade correctly and can be used with modifiers (`hover:font-display`, etc.).

**Current (line 587-589):**
```css
.font-display {
  font-family: var(--font-display);
}
```

**Change to:**
```css
@utility font-display {
  font-family: var(--font-display);
}
```

This is likely why the display font isn't visually appearing on settings pages even though the class is present in the markup — it may be getting overridden by Tailwind's `font-sans` reset on the body.

### 2. Settings header `text-2xl` is fine — keep as-is

`src/components/settings/settings-header.tsx` line 16 uses `text-2xl font-semibold font-display`. This is correct — the display font looks good at this size. No change needed.

### 3. Welcome heading `text-3xl` is fine — keep as-is

`src/routes/_onboarding.welcome.tsx` uses `text-3xl font-display`. This is the one place where `text-3xl` is allowed — it's a splash/welcome screen. Do not use `text-3xl` anywhere else.

### 4. Button text bumped to `text-sm` but heights unchanged — may look cramped

`src/components/ui/button.tsx`: Button text was changed from `text-xs/relaxed` to `text-sm`, but the heights stayed at `h-7` (default), `h-6` (sm), and `h-8` (lg). With larger text in the same container, buttons may feel vertically cramped. Visually verify and consider bumping heights by 1 step if needed:
- default: `h-7` → `h-8`
- sm: `h-6` → `h-7`
- lg: `h-8` → `h-9`

Only do this if the buttons look visually tight after rendering.

### 5. Redundant responsive override in prompt-input

`src/components/prompt-input.tsx` line 326:
```
'text-sm md:text-sm p-3.5 max-h-96 overflow-y-auto'
```

The `md:text-sm` is redundant since it's the same as `text-sm`. Simplify to just `text-sm`.

### 6. Redundant `text-xs` overrides on badges

Several badge usages now pass `text-xs` as a className override, but the Badge component default was already changed to `text-xs`. These overrides are harmless but redundant — clean them up:

- `src/components/pages/computer/computer-page-content.tsx` (2 Badge instances with `text-xs`)
- `src/components/sidebar/app-sidebar.tsx` (Beta badge with `text-xs`)
- `src/components/history/chat-row.tsx` (workspace badge with `text-xs`)
- `src/components/pages/apps/AppCard.tsx` (workspace badge with `text-xs`)

### 7. Monaco editor fontSize should stay at 13

`src/components/pages/computer/computer-page-content.tsx` line 1578: `fontSize` was changed from `13` to `14`. Monaco editor / code editors conventionally use 13px. This is a code editor context (like VS Code), not app UI text — it's an exception similar to PDF rendering. Revert to `fontSize: 13`.

## Looks Good

These changes are correct and well-done:
- All `text-[11px]`, `text-[10px]`, `text-[13px]`, `text-[0.7rem]`, `text-[0.65rem]` arbitrary sizes replaced with `text-xs` or `text-sm`
- Card body text bumped from `text-xs/relaxed` to `text-sm`
- Label bumped from `text-xs/relaxed` to `text-sm`
- Input responsive override `md:text-xs/relaxed` removed
- Textarea responsive override removed
- Sidebar menu buttons bumped from `text-xs` to `text-sm`
- Extension Lab: CardTitle overrides removed, plugin ID/path standardized to `text-xs`
- Desktop chrome CSS: fractional rem values normalized to `0.75rem`
- Chat input: `text-base` → `text-sm`
- Display font added to admin page headings, Extension Lab, welcome page
- `font-display` utility class created in globals.css
