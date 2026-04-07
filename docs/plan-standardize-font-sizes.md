# Plan: Standardize Font Sizes

## Problem

Font sizes across the app are inconsistent with no clear rationale. Examples:
- The chat input (`prompt-input.tsx`) uses `text-base` (16px) while message body text inherits browser defaults and code blocks use `text-sm` (14px)
- The Extension Lab has 5+ different font sizes within a single view
- Arbitrary pixel values like `text-[11px]`, `text-[13px]`, `text-[0.7rem]` are scattered throughout non-UI components
- shadcn component defaults have been overridden in places (e.g. CardTitle overridden from `text-sm` to `text-base` in Extension Lab)
- The heading/display font (`--font-display`, defaulting to "Source Serif 4") is configured and loaded but essentially unused outside of `.notebook-report` markdown styles in `globals.css`

## Typography Scale (Design Guide)

Establish a **4-tier font size system** using only standard Tailwind classes. No arbitrary `text-[Npx]` values outside of special rendering contexts (PDF, email, avatar initials).

| Tier | Tailwind Class | Size | Usage |
|------|---------------|------|-------|
| **Display** | `text-lg` | 18px | Page/section headings only (e.g. "Extension Lab", "Settings"). Uses `font-display` (heading font family). Sparingly used. |
| **Body** | `text-sm` | 14px | **Default for everything.** Conversation messages, input fields, card titles, descriptions, button text, labels, sidebar items, form fields. This is the workhorse size. |
| **Caption** | `text-xs` | 12px | Secondary/metadata: timestamps, version numbers, keyboard shortcuts, badge text, muted helper text, plugin IDs/paths. |
| **Micro** | `text-[0.625rem]` | 10px | Only for the existing `xs` button size variant and badge shortcuts. Do not add new uses. |

### Font Family Rules

- **Body font** (`--font-sans`, default: Figtree): Used for all text unless specified otherwise.
- **Display font** (`--font-display`, default: Source Serif 4): Used **only** for Display-tier headings. This is the "special header font" — it should feel distinct and reserved for top-level titles.
- **Mono font** (`--font-mono`, default: GeistMono): Code blocks, inline code, technical values only.

### Display Font Usage Guidelines

The display font should be used for **H1-level section titles** — the kind of text a user scans to orient themselves. Think of it like a chapter heading in a book.

**Good uses of `font-display`:**
- Page titles: "Extension Lab", "Settings", "Integrations"
- Modal/dialog titles (the main title, not sub-section labels)
- Welcome screen heading

**Do NOT use `font-display` for:**
- Card titles, form labels, sub-section headers (use `text-sm font-semibold` instead)
- Every input field label in a modal (that would be overuse)
- Buttons, badges, nav items, or body text

Apply via: `className="font-[family-name:var(--font-display)] text-lg"`

## Implementation Steps

### Step 1: Add `font-display` utility to globals.css

In `src/styles/globals.css`, ensure Tailwind can resolve `font-display` as a utility. The CSS variable `--font-display` is already defined and dynamically set by `applyAppearance()`.

Add to the `@theme` block (or equivalent):
```css
--font-display: "Source Serif 4", ui-serif, Georgia, "Times New Roman", serif;
```

Verify that `font-[family-name:var(--font-display)]` works in Tailwind v4, or add a custom utility class:
```css
.font-display {
  font-family: var(--font-display);
}
```

### Step 2: Normalize shadcn UI component base sizes

These components define the base typography. Ensure they align with the Body tier (`text-sm`) or Caption tier (`text-xs`) as appropriate.

**Files to check/update in `src/components/ui/`:**

| Component | File | Current | Target | Notes |
|-----------|------|---------|--------|-------|
| Card body | `card.tsx` line 15 | `text-xs/relaxed` | `text-sm` | Card body text should be readable at Body tier |
| CardTitle | `card.tsx` line 40 | `text-sm font-medium` | `text-sm font-medium` | Already correct, leave as-is |
| CardDescription | `card.tsx` line 50 | `text-xs/relaxed` | `text-xs/relaxed` | Correct for caption/secondary info |
| Label | `label.tsx` line 16 | `text-xs/relaxed` | `text-sm` | Form labels should match body text |
| Input | `input.tsx` line 11 | `text-sm` + `md:text-xs/relaxed` | `text-sm` (remove md override) | Inputs should be consistent Body size across breakpoints |
| Button | `button.tsx` | `text-xs/relaxed` (all sizes) | `text-sm` for default/sm/lg; keep `text-[0.625rem]` for xs only | Buttons are hard to read at 12px |
| Breadcrumb | `breadcrumb.tsx` | `text-xs/relaxed` | `text-xs/relaxed` | OK as caption-level nav |
| Badge | `badge.tsx` | `text-[0.625rem]` | `text-xs` | Badges should be legible |
| Sidebar menu items | `sidebar.tsx` | Check current | `text-sm` | Sidebar labels should be Body tier |

### Step 3: Fix the chat input vs conversation mismatch

**File: `src/components/prompt-input.tsx` (line 326)**
- Current: `text-base md:text-base` (16px)
- Change to: `text-sm md:text-sm` (14px)
- This aligns the input with the Body tier and matches message content

**File: `src/components/ui/textarea.tsx`**
- Verify the base class is `text-sm` and no responsive overrides change it

**File: `src/components/markdown-renderer.tsx`**
- Verify paragraph text inherits correctly at ~14px (Body tier)
- Heading sizes are fine as-is (text-2xl/xl/lg/base for h1-h4)
- Code blocks at `text-sm` are correct

### Step 4: Fix the Extension Lab font inconsistencies

**File: `desktop/renderer/src/App.tsx` (ExtensionCatalogPane, lines ~515-742)**

| Element | Current | Target | Change |
|---------|---------|--------|--------|
| "Extension Lab" heading (line ~579) | `text-lg` | `text-lg font-display` | Add display font family |
| Description text (line ~580) | `text-sm` | `text-sm` | Already correct |
| "Installed plugins" card title (line ~632) | CardTitle + `text-base` override | Remove `text-base` override, use CardTitle default (`text-sm font-medium`) | Remove className override |
| Plugin name (line ~664) | CardTitle + `text-base` override | Remove override, use default `text-sm font-medium` | Remove className override |
| Plugin description (line ~677) | CardDescription default | CardDescription default (`text-xs/relaxed`) | No change needed |
| Plugin version (line ~681) | `text-xs` | `text-xs` | Already correct |
| Plugin ID / path (lines ~715, ~718) | `text-[11px]` | `text-xs` | Standardize to Caption tier |
| Capabilities text (lines ~686-705) | `text-sm` | `text-sm` | Already correct |

### Step 5: Remove arbitrary pixel font sizes from app components

Search for and replace all `text-[Npx]` and `text-[N.Nrem]` values in non-special-rendering files. Map each to the nearest tier.

**Exceptions (DO NOT change):**
- Avatar component (`avatar.tsx`) — initials sizing is proportional to avatar dimensions, these custom sizes are correct
- PDF rendering files (`pdf-document.tsx`, `pdf-markdown.tsx`, `pdf-table.tsx`) — pt-based sizes for PDF generation
- Email templates (`src/lib/email/templates/`) — inline styles for HTML email rendering

**Files to update:**

| File | Current | Target |
|------|---------|--------|
| `src/components/tool-call-details-shared.tsx` | `text-[0.7rem]` | `text-xs` |
| `src/components/ui/input-group.tsx` | `text-[0.625rem]` on kbd elements | `text-xs` |
| `src/components/context-indicator.tsx` | `text-[11px]` | `text-xs` |
| `src/components/onboarding-loading-modal.tsx` | `text-[11px]` or `text-[13px]` | `text-xs` or `text-sm` respectively |
| `src/components/computer-page-content.tsx` | `text-[13px]` and inline `fontSize: 13` | `text-sm` |
| `desktop/renderer/src/App.tsx` | `text-[10px]`, `text-[11px]` | `text-xs` |

### Step 6: Standardize desktop-specific CSS

**File: `desktop/renderer/src/styles.css`**

| Selector | Current | Target |
|----------|---------|--------|
| `.desktop-titlebar-brand-label` | `font-size: 0.7rem` (11.2px) | `font-size: 0.75rem` (12px, matches `text-xs`) |
| `.desktop-workbench-tab-title` | `font-size: 0.78rem` (12.48px) | `font-size: 0.75rem` (12px, matches `text-xs`) or `0.875rem` (14px, matches `text-sm`) — use `text-xs` if tabs should be compact, `text-sm` if readable |
| `.desktop-workbench-tab-subtitle` | `font-size: 0.6875rem` (11px) | `font-size: 0.75rem` (12px, matches `text-xs`) |

### Step 7: Add display font to key page headings

Add `font-display` (or `font-[family-name:var(--font-display)]`) to top-level page/section headings throughout the app. These are the places where the special heading font should appear:

Locate all primary page headings across routes/views and add the display font class. Likely candidates:
- Extension Lab title (`desktop/renderer/src/App.tsx`)
- Settings page title (`src/routes/_app.settings*.tsx`)
- Welcome screen heading
- Any modal main titles (Dialog components with a primary heading)
- Sidebar section group labels (if applicable — evaluate whether this feels right; if it makes the sidebar too heavy, skip it)

**Do NOT apply display font to:** card titles, form labels, tab labels, button text, badge text, or any text below Display tier.

### Step 8: Update notebook/markdown report styles

**File: `src/styles/globals.css` (lines ~681-712)**

The `.notebook-report .markdown-content` styles already use `--font-display` for h1/h2/h3 — this is correct. Verify the font sizes align with the scale:
- h2 at `1.25rem` (20px) — fine for rendered markdown
- h3 at `1.125rem` (18px) — fine for rendered markdown
- These are for rendered content, not app UI, so they can deviate from the 4-tier scale

## Reference

The canonical UI design guidelines live in `.claude/skills/ui-design/SKILL.md`. After implementing this plan, all font choices should conform to that skill sheet. Future UI work should consult it before choosing font sizes or font families.

## Verification

After implementation, verify these specific scenarios:
1. **Chat view**: Input field and message text should be the same size (both `text-sm` / 14px)
2. **Extension Lab**: Plugin list should have a clean 2-level hierarchy — name at `text-sm font-medium` and description/metadata at `text-xs`
3. **Settings pages**: Labels and input values should be the same size (`text-sm`)
4. **Modals/dialogs**: Title uses display font, body text is `text-sm`, helper text is `text-xs`
5. **Sidebar**: All menu items at `text-sm`, no size variation between different sidebar items
6. **Desktop tabs**: Consistent caption-level sizing, no fractional rem oddities
7. **No arbitrary pixel sizes remain** outside of avatar, PDF, and email rendering

## Files Changed (Expected)

Core UI components (~10 files):
- `src/components/ui/card.tsx`
- `src/components/ui/label.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/badge.tsx`
- `src/components/ui/input-group.tsx`
- `src/components/ui/sidebar.tsx`
- `src/components/ui/textarea.tsx`
- `src/styles/globals.css`

App components (~6 files):
- `src/components/prompt-input.tsx`
- `src/components/tool-call-details-shared.tsx`
- `src/components/context-indicator.tsx`
- `src/components/onboarding-loading-modal.tsx`
- `src/components/computer-page-content.tsx`
- `desktop/renderer/src/App.tsx`

Desktop styles:
- `desktop/renderer/src/styles.css`

Page headings (varies — search for top-level heading patterns across routes).
