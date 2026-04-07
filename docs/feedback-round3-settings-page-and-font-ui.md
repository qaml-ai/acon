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

### Visual layout

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Body Font                                                  │
│                                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │         │  │         │  │         │  │         │       │
│  │   Aa    │  │   Aa    │  │   Aa    │  │   Aa    │       │
│  │         │  │         │  │         │  │         │       │
│  │ Figtree │  │  Inter  │  │  Lora   │  │IBM Plex │       │
│  │ (ring)  │  │         │  │         │  │  Mono   │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
│   ▲ active     Each "Aa" is rendered in that font's         │
│                own typeface so you can see the style         │
│                                                             │
│  Heading Font                                               │
│                                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │         │  │         │  │         │  │         │       │
│  │   Aa    │  │   Aa    │  │   Aa    │  │   Aa    │       │
│  │         │  │         │  │         │  │         │       │
│  │ Source  │  │Fraunces │  │ Plus    │  │IBM Plex │       │
│  │ Serif 4 │  │         │  │ Jakarta │  │  Mono   │       │
│  │ (ring)  │  │         │  │  Sans   │  │         │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                                                     │    │
│  │  The quick brown fox jumps over       ← heading     │    │
│  │  the lazy dog                           font        │    │
│  │                                                     │    │
│  │  Pack my box with five dozen liquor   ← body        │    │
│  │  jugs. How vexingly quick daft          font        │    │
│  │  zebras jump.                                       │    │
│  │                                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│   ▲ shared preview — updates live when either               │
│     selection changes. Heading is lg/semibold,              │
│     body is sm/normal. Bordered card.                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key design decisions
- **Font chips** are compact — just "Aa" in the font's typeface + the name below. Laid out horizontally in a `flex` row, not a 2-col grid
- **One shared preview** at the bottom shows both the heading and body font together, so the user sees how they pair. The heading is styled larger/bolder, the body is regular
- The preview updates live when either font selection changes
- No descriptions cluttering the buttons — the "Aa" preview IS the description

---

## 2. Settings as a Full Page with Left Nav (Not a Dialog)

### Problem

Settings is currently an `AppearanceDialog` (shadcn Dialog overlay). As settings grow, a dialog won't scale. The user wants settings to be a full page matching the web app's design — a left-side nav listing all settings categories, with the selected category's content on the right.

### Architectural approach

Settings becomes a **built-in view** that renders in the main content area (same as chat threads, extension lab, etc.). The content area is split into a **left nav** and a **right content pane** — matching the web app's existing settings pattern (see screenshot reference: grouped nav with USER / WORKSPACE sections, active item highlighted, page title + description + form content on the right).

**Appearance gets its own nav item** (not nested under General) because:
- It already has 3 substantial sections (theme, fonts, colors) — enough to own a page
- "General" typically means functional prefs (language, notifications, default model) — mixing visual customization there makes both harder to find
- Industry standard: VS Code, Slack, Discord, Figma all separate Appearance from General

### Visual layout

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  [tab] [tab] [tab]                                              (titlebar)          │
├──────────┬───────────────────────────────────────────────────────────────────────────┤
│          │                                                                          │
│ SIDEBAR  │  ┌──────────────┬────────────────────────────────────────────────────┐   │
│          │  │              │                                                    │   │
│ Workbench│  │  USER        │  Appearance                                       │   │
│  Chat    │  │              │  Customize how the app looks and feels.            │   │
│  Ext Lab │  │  General     │                                                    │   │
│          │  │  Appearance  │  ─────────────────────────────────────────         │   │
│──────────│  │   (active)   │                                                    │   │
│ Recent   │  │              │  Appearance                                        │   │
│  Thread 1│  │              │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │   │
│  Thread 2│  │  WORKSPACE   │  │ ○ System │ │ ☀ Light  │ │ ◑ Dark   │           │   │
│  Thread 3│  │              │  └──────────┘ └──────────┘ └──────────┘           │   │
│          │  │  General     │                                                    │   │
│          │  │  AI Provider │  ─────────────────────────────────────────         │   │
│          │  │              │                                                    │   │
│          │  │              │  Body Font                                         │   │
│          │  │              │  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐          │   │
│          │  │              │  │  Aa   │ │  Aa   │ │  Aa   │ │  Aa   │          │   │
│          │  │              │  │Figtree│ │ Inter │ │ Lora  │ │IBM Plx│          │   │
│          │  │              │  └───────┘ └───────┘ └───────┘ └───────┘          │   │
│          │  │              │                                                    │   │
│          │  │              │  Heading Font                                      │   │
│          │  │              │  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐          │   │
│          │  │              │  │  Aa   │ │  Aa   │ │  Aa   │ │  Aa   │          │   │
│          │  │              │  │Src Srf│ │Fraunce│ │Jkrta S│ │IBM Plx│          │   │
│          │  │              │  └───────┘ └───────┘ └───────┘ └───────┘          │   │
│          │  │              │                                                    │   │
│          │  │              │  ┌──────────────────────────────────────┐          │   │
│          │  │              │  │ The quick brown fox jumps  ← heading│          │   │
│          │  │              │  │ over the lazy dog                   │          │   │
│          │  │              │  │                                     │          │   │
│          │  │              │  │ Pack my box with five     ← body   │          │   │
│          │  │              │  │ dozen liquor jugs.                  │          │   │
│          │  │              │  └──────────────────────────────────────┘          │   │
│          │  │              │                                                    │   │
│          │  │              │  ─────────────────────────────────────────         │   │
│          │  │              │                                                    │   │
│          │  │              │  Color Scheme                                      │   │
│          │  │              │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐         │   │
│          │  │              │  │ ███ │ │ ███ │ │ ███ │ │ ███ │ │ ███ │         │   │
│          │  │              │  │Mist │ │Zinc │ │Slate│ │Stone│ │Neutr│         │   │
│          │  │              │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘         │   │
│          │  │              │                                                    │   │
│──────────│  └──────────────┴────────────────────────────────────────────────────┘   │
│ Settings │                                                                          │
│ (active) │  (right pane scrolls independently)                                      │
│ Get Help │                                                                          │
└──────────┴──────────────────────────────────────────────────────────────────────────┘
```

### Settings left nav structure

| Group | Nav Item | Content | Status |
|---|---|---|---|
| **USER** | General | Display name, notifications, language | Placeholder for now |
| | Appearance | Theme mode, fonts, color scheme | **Building now** |
| **WORKSPACE** | General | Workspace name, default model | Placeholder for now |
| | AI Provider | LLM provider selection, API keys | Placeholder for now |

Only Appearance has content right now. The other items should exist in the nav but show a simple placeholder ("Coming soon" or an empty state) when clicked. This establishes the structure from day one so it scales naturally.

### Implementation

#### 2a. Create the Settings left nav component

**New file:** `desktop/renderer/src/settings-nav.tsx`

A left nav matching the web app's `SettingsNav` pattern. Takes the active page ID and an `onNavigate` callback.

```tsx
import { cn } from "@/lib/utils";

interface SettingsNavItem {
  id: string;
  label: string;
}

interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: "User",
    items: [
      { id: "general", label: "General" },
      { id: "appearance", label: "Appearance" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "workspace-general", label: "General" },
      { id: "workspace-ai", label: "AI Provider" },
    ],
  },
];

export function SettingsNav({
  activeId,
  onNavigate,
}: {
  activeId: string;
  onNavigate: (id: string) => void;
}) {
  return (
    <nav className="w-48 shrink-0 space-y-4 py-4 pl-4 pr-2">
      {SETTINGS_NAV.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          {group.items.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                activeId === item.id
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
```

#### 2b. Create the Settings page component

**New file:** `desktop/renderer/src/settings-page.tsx`

A full-page layout with the left nav and a content area. Uses local state for the active settings panel.

```tsx
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ThemePreference } from "@/components/settings/theme-preference";
import { FontPreference } from "@/components/settings/font-preference";
import { ColorSchemePreference } from "@/components/settings/color-scheme-preference";
import { SettingsNav } from "./settings-nav";

function SettingsHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function AppearanceContent() {
  return (
    <div className="max-w-lg space-y-6">
      <SettingsHeader
        title="Appearance"
        description="Customize how the app looks and feels."
      />
      <Separator />
      <ThemePreference />
      <Separator />
      <FontPreference />
      <Separator />
      <ColorSchemePreference />
    </div>
  );
}

function PlaceholderContent({ title }: { title: string }) {
  return (
    <div className="max-w-lg space-y-6">
      <SettingsHeader title={title} description="Coming soon." />
      <Separator />
      <p className="text-sm text-muted-foreground">
        This settings page is not yet available.
      </p>
    </div>
  );
}

const SETTINGS_PANELS: Record<string, { title: string; component: React.ComponentType }> = {
  general:             { title: "General",     component: () => <PlaceholderContent title="General" /> },
  appearance:          { title: "Appearance",  component: AppearanceContent },
  "workspace-general": { title: "General",     component: () => <PlaceholderContent title="Workspace General" /> },
  "workspace-ai":      { title: "AI Provider", component: () => <PlaceholderContent title="AI Provider" /> },
};

export function SettingsPage() {
  const [activePanel, setActivePanel] = useState("appearance");
  const panel = SETTINGS_PANELS[activePanel] ?? SETTINGS_PANELS.appearance;
  const PanelComponent = panel.component;

  return (
    <div className="flex min-h-0 flex-1">
      <SettingsNav activeId={activePanel} onNavigate={setActivePanel} />
      <ScrollArea className="flex-1">
        <div className="px-6 py-5">
          <PanelComponent />
        </div>
      </ScrollArea>
    </div>
  );
}
```

#### 2c. Wire Settings as a local view in App.tsx

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

#### 2d. Delete the dialog

Remove `desktop/renderer/src/appearance-dialog.tsx` — it's replaced by the full-page `SettingsPage`. Also remove the `AppearanceDialog` import and render from `App.tsx`.

#### 2e. Highlight Settings in sidebar

Pass `showSettings` as a prop to `DesktopSidebar` so the Settings button shows an active state:

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
| `desktop/renderer/src/settings-page.tsx` | **New:** Full-page settings with left nav + content pane |
| `desktop/renderer/src/settings-nav.tsx` | **New:** Left nav component with grouped sections (USER / WORKSPACE) |
| `desktop/renderer/src/App.tsx` | Replace dialog with full-page settings view; add `showSettings` state; clear on view/thread select |
| `desktop/renderer/src/desktop-sidebar.tsx` | Add `showSettings` prop for active state on Settings button |
| `desktop/renderer/src/appearance-dialog.tsx` | **Delete** — replaced by settings page |
