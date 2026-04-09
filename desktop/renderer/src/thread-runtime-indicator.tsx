import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DesktopThreadRuntimeState } from "../../shared/protocol";

interface ThreadRuntimeIndicatorProps {
  runtime: DesktopThreadRuntimeState | null | undefined;
  className?: string;
}

export function ThreadRuntimeIndicator({
  runtime,
  className,
}: ThreadRuntimeIndicatorProps) {
  if (!runtime?.isRunning) {
    return null;
  }

  const label = runtime.stopRequested ? "Chat stopping" : "Chat running";

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <Loader2
        className={cn(
          "size-3.5 animate-spin",
          runtime.stopRequested && "opacity-70",
        )}
      />
    </span>
  );
}
