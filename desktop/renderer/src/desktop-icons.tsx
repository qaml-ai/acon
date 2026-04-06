import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  BookOpen,
  Cable,
  FolderSearch,
  Globe,
  LayoutGrid,
  MessagesSquare,
  Puzzle,
  Settings2,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Blocks,
  BookOpen,
  Cable,
  FolderSearch,
  Globe,
  LayoutGrid,
  MessagesSquare,
  Puzzle,
  Settings2,
};

export function getDesktopIcon(name: string | null | undefined): LucideIcon {
  if (!name) {
    return Puzzle;
  }

  return ICONS[name] ?? Puzzle;
}
