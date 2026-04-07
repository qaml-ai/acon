import { Label } from "@/components/ui/label";
import { useAppearance } from "@/components/appearance-provider";
import { BODY_FONTS, HEADING_FONTS, type FontOption } from "@/lib/appearance";
import { cn } from "@/lib/utils";

function FontCard({
  font,
  isActive,
  onClick,
}: {
  font: FontOption;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-lg border-2 p-3 text-left transition-colors",
        isActive ? "border-ring" : "border-transparent hover:border-border",
      )}
    >
      <span
        className="text-3xl leading-none text-foreground"
        style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
      >
        Aa
      </span>
      <p
        className="line-clamp-2 text-sm text-muted-foreground"
        style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
      >
        The quick brown fox jumps over the lazy dog
      </p>
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
