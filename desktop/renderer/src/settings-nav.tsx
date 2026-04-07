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
                  ? "bg-accent font-medium text-accent-foreground"
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
