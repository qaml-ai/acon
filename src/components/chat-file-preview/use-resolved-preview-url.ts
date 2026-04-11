'use client';

import { useEffect, useState } from 'react';
import type { PreviewTarget } from '@/types';

export function useResolvedPreviewUrl(
  previewUrl: string,
  previewTarget?: PreviewTarget
): string | null {
  const [resolvedPreviewUrl, setResolvedPreviewUrl] = useState<string | null>(previewUrl);

  useEffect(() => {
    let cancelled = false;

    async function resolvePreviewUrl() {
      if (!window.desktopShell?.resolvePreviewSrc || !previewTarget) {
        setResolvedPreviewUrl(previewUrl);
        return;
      }

      try {
        const nextUrl = await window.desktopShell.resolvePreviewSrc(previewTarget);
        if (!cancelled) {
          setResolvedPreviewUrl(nextUrl || null);
        }
      } catch {
        if (!cancelled) {
          setResolvedPreviewUrl(null);
        }
      }
    }

    void resolvePreviewUrl();

    return () => {
      cancelled = true;
    };
  }, [previewTarget, previewUrl]);

  return resolvedPreviewUrl;
}
