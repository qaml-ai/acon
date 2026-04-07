import { Label } from "@/components/ui/label";
import { useAppearance } from "@/components/appearance-provider";
import { useTheme } from "next-themes";
import { getAllSchemes } from "@/lib/appearance";
import { cn } from "@/lib/utils";

export function ColorSchemePreference() {
  const { prefs, updatePrefs } = useAppearance();
  const { resolvedTheme } = useTheme();
  const schemes = getAllSchemes();
  const mode = (resolvedTheme as "light" | "dark") ?? "light";

  return (
    <div className="space-y-2">
      <Label>Color Scheme</Label>
      <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Color scheme">
        {schemes.map((scheme) => {
          const vars = mode === "dark" ? scheme.dark : scheme.light;
          const isActive = prefs.colorScheme === scheme.id;

          return (
            <button
              key={scheme.id}
              role="radio"
              aria-checked={isActive}
              onClick={() => updatePrefs({ colorScheme: scheme.id })}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border-2 p-2 transition-colors",
                isActive
                  ? "border-ring"
                  : "border-transparent hover:border-border",
              )}
            >
              <div
                className="flex h-12 w-full flex-col overflow-hidden rounded-md border"
                style={{ borderColor: vars["--border"] }}
              >
                <div
                  className="flex-1"
                  style={{ backgroundColor: vars["--background"] }}
                />
                <div
                  className="h-3"
                  style={{ backgroundColor: vars["--primary"] }}
                />
                <div
                  className="h-2"
                  style={{ backgroundColor: vars["--muted"] }}
                />
              </div>
              <span className="text-xs text-muted-foreground">{scheme.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
