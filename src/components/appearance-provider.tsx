import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useTheme } from "next-themes";
import {
  type AppearancePrefs,
  DEFAULT_PREFS,
  loadPrefs,
  savePrefs,
  applyAppearance,
} from "@/lib/appearance";

interface AppearanceContextValue {
  prefs: AppearancePrefs;
  updatePrefs: (patch: Partial<AppearancePrefs>) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
  prefs: DEFAULT_PREFS,
  updatePrefs: () => {},
});

export const useAppearance = () => useContext(AppearanceContext);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_PREFS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    applyAppearance(prefs, (resolvedTheme as "light" | "dark") ?? "light");
  }, [prefs, resolvedTheme, mounted]);

  const updatePrefs = useCallback((patch: Partial<AppearancePrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  return (
    <AppearanceContext.Provider value={{ prefs, updatePrefs }}>
      {children}
    </AppearanceContext.Provider>
  );
}
