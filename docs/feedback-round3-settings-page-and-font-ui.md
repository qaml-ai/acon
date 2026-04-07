# Round 3 Feedback: Settings Page + Font Preview Redesign

## Previous Issues — Status

All critical/high items from rounds 1 and 2 have been resolved:
- [x] Vite `publicDir` fix — fonts loading correctly
- [x] `hsl(var(--background))` wrappers removed from desktop styles (all 24 occurrences)
- [x] `hsl(var(--sidebar-border))` in sidebar.tsx fixed
- [x] Avatar component restored (custom sizes + `content` prop)
- [x] Font files re-downloaded from Google Fonts API (correct metadata)
- [x] New fonts added (Fraunces, IBM Plex Mono), old fonts deleted (DM Sans, Merriweather, Playfair Display)
- [x] `@font-face` declarations updated in globals.css
- [x] `BODY_FONTS` / `HEADING_FONTS` arrays updated in appearance.ts
- [x] `font-family: var(--font-sans)` added to desktop body CSS
- [x] .ttf files deleted

---

## 1. Font Preview Redesign

### Problem

The current card-based font picker puts "Aa", a full sample sentence, font name, and description inside every button card. With 4 fonts × 2 sections, that's 8 large cards crammed into the dialog — overwhelming and chaotic.

### Requested design

Simplify the font buttons to just show the font name styled in its own typeface (like a compact pill/chip). Then add **one shared preview area** at the bottom of the font section that shows the currently-selected fonts in action with a header + subheader.

### Implementation

```tsx
// src/components/settings/font-preference.tsx

function FontChip({ font, isActive, onClick }: {
  font: FontOption;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg border-2 px-3 py-2 transition-colors",
        isActive ? "border-ring bg-accent" : "border-transparent hover:border-border",
      )}
    >
      {/* Large "Aa" in the font's typeface */}
      <span
        className="text-2xl leading-none text-foreground"
        style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
      >
        Aa
      </span>
      {/* Font name */}
      <span className="text-[10px] text-muted-foreground">{font.label}</span>
    </button>
  );
}

export function FontPreference() {
  const { prefs, updatePrefs } = useAppearance();

  const activeBody = BODY_FONTS.find(f => f.family === prefs.bodyFont) ?? BODY_FONTS[0];
  const activeHeading = HEADING_FONTS.find(f => f.family === prefs.headingFont) ?? HEADING_FONTS[0];

  return (
    <div className="space-y-4">
      {/* Body font selector */}
      <div className="space-y-2">
        <Label>Body Font</Label>
        <div className="flex gap-2">
          {BODY_FONTS.map((font) => (
            <FontChip
              key={font.family}
              font={font}
              isActive={prefs.bodyFont === font.family}
              onClick={() => updatePrefs({ bodyFont: font.family })}
            />
          ))}
        </div>
      </div>

      {/* Heading font selector */}
      <div className="space-y-2">
        <Label>Heading Font</Label>
        <div className="flex gap-2">
          {HEADING_FONTS.map((font) => (
            <FontChip
              key={font.family}
              font={font}
              isActive={prefs.headingFont === font.family}
              onClick={() => updatePrefs({ headingFont: font.family })}
            />
          ))}
        </div>
      </div>

      {/* Shared live preview */}
      <div className="rounded-lg border bg-card p-4 space-y-1">
        <h3
          className="text-lg font-semibold text-foreground"
          style={{ fontFamily: `"${activeHeading.family}", ${activeHeading.fallback}` }}
        >
          The quick brown fox jumps over the lazy dog
        </h3>
        <p
          className="text-sm text-muted-foreground"
          style={{ fontFamily: `"${activeBody.family}", ${activeBody.fallback}` }}
        >
          Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.
        </p>
      </div>
    </div>
  );
}
```

### Key design decisions
- **Font chips** are compact — just "Aa" in the font's typeface + the name below. Laid out horizontally in a `flex` row, not a 2-col grid
- **One shared preview** at the bottom shows both the heading and body font together, so the user sees how they pair. The heading is styled larger/bolder, the body is regular
- The preview updates live when either font selection changes
- No descriptions cluttering the buttons — the "Aa" preview IS the description

---

## 2. Settings as a Full Page (Not a Dialog)

### Problem

Settings is currently an `AppearanceDialog` (shadcn Dialog overlay). As settings grow beyond appearance (e.g., keyboard shortcuts, AI provider config, workspace settings), a dialog will feel cramped and doesn't scale. The user wants settings to be a full page with tabs.

### Architectural approach

The desktop app uses a **view/surface system** — the sidebar lists workbench views, and clicking one renders a surface in the main content area. Settings should be another surface in this system, not a dialog overlay.

The cleanest approach: make Settings a **built-in workbench view** that renders directly in the main content area (same as chat threads, extension lab, etc.), with tabs for different settings categories.

### Implementation

#### 2a. Create a Settings page component

**New file:** `desktop/renderer/src/settings-page.tsx`

A full-page settings component with a tabbed layout:

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemePreference } from "@/components/settings/theme-preference";
import { FontPreference } from "@/components/settings/font-preference";
import { ColorSchemePreference } from "@/components/settings/color-scheme-preference";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

export function SettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-6 pt-5 pb-0">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Customize your workspace preferences.
        </p>
      </div>
      <Tabs defaultValue="appearance" className="flex min-h-0 flex-1 flex-col">
        <div className="px-6 pt-4">
          <TabsList>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            {/* Future tabs: */}
            {/* <TabsTrigger value="general">General</TabsTrigger> */}
            {/* <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger> */}
            {/* <TabsTrigger value="ai">AI Provider</TabsTrigger> */}
          </TabsList>
        </div>
        <ScrollArea className="flex-1">
          <TabsContent value="appearance" className="mt-0 px-6 py-4">
            <div className="max-w-lg space-y-6">
              <ThemePreference />
              <Separator />
              <FontPreference />
              <Separator />
              <ColorSchemePreference />
            </div>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}
```

#### 2b. Wire Settings as a local view in App.tsx

The app already has a pattern for rendering different content based on the active view. Settings should follow this same pattern but as a **local UI view** (not a plugin-contributed view).

In `App.tsx`:

1. Add a `showSettings` boolean state (replaces `settingsOpen`)
2. When `showSettings` is true, render `<SettingsPage />` in the main content area instead of the active workbench surface
3. The sidebar's Settings button sets `showSettings = true`; selecting any sidebar view/thread sets it back to `false`

```tsx
// In App.tsx:
const [showSettings, setShowSettings] = useState(false);

// Sidebar callbacks:
onOpenSettings={() => setShowSettings(true)}
onSelectView={(viewId) => { setShowSettings(false); handleSelectView(viewId); }}
onSelectThread={(threadId) => { setShowSettings(false); handleSelectThread(threadId); }}

// In the render, replace the surface pane:
{showSettings ? (
  <SettingsPage />
) : activeSurfaceProps ? (
  <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
    {/* ...existing surface rendering... */}
  </div>
) : (
  /* ...no active view fallback... */
)}
```

#### 2c. Delete the dialog

Remove `desktop/renderer/src/appearance-dialog.tsx` — it's replaced by the full-page `SettingsPage`. Also remove the `AppearanceDialog` import and render from `App.tsx`.

#### 2d. Optional: Highlight Settings in sidebar

To show the user they're "on" the settings page, you could add an `isActive` state to the Settings sidebar button when `showSettings` is true. Pass `showSettings` as a prop to `DesktopSidebar`:

```tsx
// In DesktopSidebar:
<SidebarMenuButton
  tooltip="Settings"
  isActive={showSettings}
  onClick={onOpenSettings}
>
  <Settings />
  <span>Settings</span>
</SidebarMenuButton>
```

Add `showSettings: boolean` to `DesktopSidebarProps`.

---

## Summary of Changes

| File | Change |
|---|---|
| `src/components/settings/font-preference.tsx` | Rewrite: compact "Aa" chips + shared preview area |
| `desktop/renderer/src/settings-page.tsx` | **New:** Full-page settings with tabs |
| `desktop/renderer/src/App.tsx` | Replace dialog with full-page settings view; add `showSettings` state |
| `desktop/renderer/src/desktop-sidebar.tsx` | Add `showSettings` prop for active state on Settings button; clear settings on view/thread select |
| `desktop/renderer/src/appearance-dialog.tsx` | **Delete** — replaced by settings page |
