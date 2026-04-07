# Round 2 Feedback: Font Files, Font Switching, and UI Redesign

## 1. Source Serif 4 Looking Sans-Serif — Root Cause + Fix

### What happened

The original .woff2 files downloaded from gwfh.mranftl.com had **wrong embedded font family names** for many weights. The gwfh API served optical-size-specific variants instead of the standard weights:

| Font | Expected internal name | Actual internal name from gwfh |
|---|---|---|
| Figtree (all weights) | `Figtree` | `Figtree Light` |
| Source Serif 4 (500, 600) | `Source Serif 4` | `Source Serif 4 Medium`, `Source Serif 4 SemiBold` |
| Merriweather (all weights) | `Merriweather` | `Merriweather Light 18pt` |
| DM Sans (all weights) | `DM Sans` | `DM Sans 9pt` |

When `@font-face` declares `font-family: "Source Serif 4"` but the file's internal name doesn't match, browsers may fail to use the font for certain weights, falling back to the system sans-serif.

### Fix applied

All Google Fonts have been **re-downloaded directly from the Google Fonts CSS API** (`fonts.googleapis.com/css2`), which serves properly-subsetted variable fonts with correct metadata. The gwfh-sourced files have been replaced.

Note: The Google Fonts API serves **variable font binaries** for Figtree, Inter, Source Serif 4, Fraunces, Lora, and Plus Jakarta Sans. This means the Regular/Medium/SemiBold/Bold files for each style (normal/italic) are identical binaries — the browser extracts the requested weight from the variable font range. This is functionally correct but storage-wasteful. A future optimization could deduplicate to 2 files per family (normal + italic) with `font-weight: 400 700` ranges in `@font-face`.

---

## 2. Font Selection Not Updating UI — Root Cause + Fix

### Two separate issues

**Issue A: Desktop body has no `font-family` binding**

The desktop app's `<body>` and root elements have **no `font-sans` class or `font-family` declaration**. In the web app, `src/root.tsx` has `<body className="font-sans antialiased">`, but the desktop renderer (`desktop/renderer/src/main.tsx` / `App.tsx`) never applies this.

When `applyAppearance()` updates `--font-sans`, nothing in the desktop UI references that variable. The body inherits the browser default font.

**Fix:** Add `font-sans antialiased` to the desktop shell root element. Either:

```css
/* In desktop/renderer/src/styles.css, add to the body rule: */
body {
  background: var(--background);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
```

Or add `className="font-sans antialiased"` to the `<body>` tag in `desktop/renderer/index.html`.

**Issue B: `@theme inline` specificity vs inline styles**

Tailwind v4's `@theme inline` compiles `--font-sans` into a `:root` CSS custom property. The `applyAppearance()` function sets the same property via `document.documentElement.style.setProperty()`. Inline styles on `:root` should override stylesheet declarations, so this should work in theory. However, verify by checking the computed style in DevTools after switching fonts — if the `@theme` declaration wins, you may need to set the property with `!important` or use a different approach (e.g., setting a `data-font` attribute and using a CSS selector).

---

## 3. Font List Updated

### New font families

**Heading fonts:**
| Font | Description | Status |
|---|---|---|
| Source Serif 4 | Clean, versatile serif (default) | Re-downloaded (correct files) |
| Fraunces | Old-style, quirky variable serif | **NEW** — downloaded |
| Plus Jakarta Sans | Modern, slightly warm sans | Re-downloaded (correct files) |
| IBM Plex Mono | IBM's monospaced family | **NEW** — downloaded |

**Body fonts:**
| Font | Description | Status |
|---|---|---|
| Figtree | Geometric, friendly (default) | Re-downloaded (correct files) |
| Inter | Clean, neutral UI standard | Re-downloaded (correct files) |
| Lora | Calligraphy-inspired, contemporary | Re-downloaded (correct files) |
| IBM Plex Mono | IBM's monospaced family | **NEW** — downloaded |

### Removed fonts (files deleted)
- DM Sans (all 8 variants)
- Merriweather (all 8 variants)
- Playfair Display (all 8 variants)

### Also deleted
- All 5 .ttf files (Figtree, GeistMono, SourceSerif4)

### Current state: 64 .woff2 files, ~3.8MB total
- 8 font families × 8 variants each (Regular, Italic, Medium, MediumItalic, SemiBold, SemiBoldItalic, Bold, BoldItalic)

### Files that need updating

**`src/lib/appearance.ts`** — Update `BODY_FONTS` and `HEADING_FONTS` arrays:

```ts
export const BODY_FONTS: FontOption[] = [
  { family: "Figtree",       label: "Figtree",       description: "Geometric, friendly",              category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "Inter",          label: "Inter",          description: "Clean, neutral UI standard",      category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "Lora",           label: "Lora",           description: "Calligraphy-inspired serif",      category: "serif",      fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "IBM Plex Mono",  label: "IBM Plex Mono",  description: "Clean, technical monospace",      category: "sans-serif", fallback: "ui-monospace, monospace" },
];

export const HEADING_FONTS: FontOption[] = [
  { family: "Source Serif 4",    label: "Source Serif 4",    description: "Clean, versatile serif",       category: "serif",      fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Fraunces",          label: "Fraunces",          description: "Old-style, quirky display",    category: "serif",      fallback: 'ui-serif, Georgia, "Times New Roman", serif' },
  { family: "Plus Jakarta Sans", label: "Plus Jakarta Sans", description: "Modern geometric sans",        category: "sans-serif", fallback: "ui-sans-serif, system-ui, sans-serif" },
  { family: "IBM Plex Mono",     label: "IBM Plex Mono",     description: "Clean, technical monospace",   category: "sans-serif", fallback: "ui-monospace, monospace" },
];
```

**`src/styles/globals.css`** — Update `@font-face` declarations:
- Remove: DM Sans, Merriweather, Playfair Display, Plus Jakarta Sans (body — it moves to heading only)
- Add: Fraunces (8 variants), IBM Plex Mono (8 variants)
- Keep: Figtree, Source Serif 4, GeistMono, Inter, Lora, Plus Jakarta Sans

---

## 4. Font Picker UI Redesign

### Current
Two `Select` dropdowns — font name in a dropdown, hard to see the actual font.

### Requested
Card-based selection like the color scheme picker, with:
- Large "Aa" preview in the font's own typeface
- Header/subheader preview blurb so users see the font's character
- Visual cards instead of dropdowns

### Proposed design

Replace `font-preference.tsx` with a card grid layout. Each font gets a clickable card showing:

```
┌─────────────────────────────┐
│                             │
│       Aa                    │  ← large, in the font's typeface
│                             │
│  The quick brown fox jumps  │  ← body preview text, in the font
│  over the lazy dog          │
│                             │
│  Font Name                  │  ← label
│  Short description          │  ← muted text
└─────────────────────────────┘
```

For heading fonts, the "Aa" and preview should feel heading-like (larger weight, maybe a header + subheader combo). For body fonts, the preview should feel body-like (regular weight, paragraph text).

### Implementation guidance

```tsx
// src/components/settings/font-preference.tsx

function FontCard({ font, isActive, onClick }: {
  font: FontOption;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-lg border-2 p-3 text-left transition-colors",
        isActive ? "border-ring" : "border-transparent hover:border-border"
      )}
    >
      {/* Large "Aa" preview */}
      <span
        className="text-3xl leading-none text-foreground"
        style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
      >
        Aa
      </span>
      {/* Sample text */}
      <p
        className="text-sm text-muted-foreground line-clamp-2"
        style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
      >
        The quick brown fox jumps over the lazy dog
      </p>
      {/* Label */}
      <div>
        <p className="text-xs font-medium">{font.label}</p>
        <p className="text-xs text-muted-foreground">{font.description}</p>
      </div>
    </button>
  );
}

export function FontPreference() {
  const { prefs, updatePrefs } = useAppearance();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Body Font</Label>
        <div className="grid grid-cols-2 gap-2">
          {BODY_FONTS.map((font) => (
            <FontCard
              key={font.family}
              font={font}
              isActive={prefs.bodyFont === font.family}
              onClick={() => updatePrefs({ bodyFont: font.family })}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Heading Font</Label>
        <div className="grid grid-cols-2 gap-2">
          {HEADING_FONTS.map((font) => (
            <FontCard
              key={font.family}
              font={font}
              isActive={prefs.headingFont === font.family}
              onClick={() => updatePrefs({ headingFont: font.family })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

**Important for the `style` prop:** Use the full `fontFamily` string including fallbacks — `"${font.family}", ${font.fallback}` — so the preview renders correctly even during font load.

---

## Summary of Required Changes

| Priority | Task | Details |
|---|---|---|
| **Critical** | Add `font-family: var(--font-sans)` to desktop body | Either in CSS or as class on body/root element |
| **High** | Update `BODY_FONTS` / `HEADING_FONTS` in `appearance.ts` | Remove DM Sans, Merriweather, Playfair Display; Add Fraunces, IBM Plex Mono |
| **High** | Update `@font-face` declarations in `globals.css` | Remove deleted fonts, add Fraunces + IBM Plex Mono |
| **High** | Rewrite `font-preference.tsx` as card grid | See design spec above |
| **Medium** | Verify `@theme inline` specificity works with inline style overrides | Check in DevTools after applying the body font fix |
