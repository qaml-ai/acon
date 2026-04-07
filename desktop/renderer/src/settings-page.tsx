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
  general: { title: "General", component: () => <PlaceholderContent title="General" /> },
  appearance: { title: "Appearance", component: AppearanceContent },
  "workspace-general": { title: "General", component: () => <PlaceholderContent title="Workspace General" /> },
  "workspace-ai": { title: "AI Provider", component: () => <PlaceholderContent title="AI Provider" /> },
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
