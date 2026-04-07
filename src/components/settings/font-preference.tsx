import { Label } from "@/components/ui/label";
import { useAppearance } from "@/components/appearance-provider";
import { BODY_FONTS, HEADING_FONTS, type FontOption } from "@/lib/appearance";
import { cn } from "@/lib/utils";

function FontChip({
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
        "flex flex-col items-center gap-1 rounded-lg border-2 px-3 py-2 transition-colors",
        isActive ? "border-ring bg-accent" : "border-transparent hover:border-border",
      )}
    >
      <span
        className="text-2xl leading-none text-foreground"
        style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
      >
        Aa
      </span>
      <span className="text-xs text-muted-foreground">{font.label}</span>
    </button>
  );
}

export function FontPreference() {
  const { prefs, updatePrefs } = useAppearance();

  const activeBody = BODY_FONTS.find((f) => f.family === prefs.bodyFont) ?? BODY_FONTS[0];
  const activeHeading = HEADING_FONTS.find((f) => f.family === prefs.headingFont) ?? HEADING_FONTS[0];

  return (
    <div className="space-y-4">
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

      <div className="space-y-1 rounded-lg border bg-card p-4">
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
