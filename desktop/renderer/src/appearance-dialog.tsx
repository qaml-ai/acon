import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ThemePreference } from "@/components/settings/theme-preference";
import { FontPreference } from "@/components/settings/font-preference";
import { ColorSchemePreference } from "@/components/settings/color-scheme-preference";

export function AppearanceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-2">
          <ThemePreference />
          <Separator />
          <FontPreference />
          <Separator />
          <ColorSchemePreference />
        </div>
      </DialogContent>
    </Dialog>
  );
}
