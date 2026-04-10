'use client';

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const PREVIEW_TEXT_CLASS = 'text-[#221b12]';
const PREVIEW_MUTED_TEXT_CLASS = 'text-[#6b5f49]';

type MermaidPreviewProps = {
  content: string;
  filename: string;
  layout: 'panel' | 'dialog';
};

type MermaidStatus = 'loading' | 'ready' | 'error';

export function MermaidPreview({ content, filename, layout }: MermaidPreviewProps) {
  const renderId = useId().replace(/[:]/g, '-');
  const [status, setStatus] = useState<MermaidStatus>('loading');
  const [svg, setSvg] = useState('');
  const [errorMessage, setErrorMessage] = useState('Unable to render this Mermaid diagram.');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setSvg('');
    setErrorMessage('Unable to render this Mermaid diagram.');

    void import('mermaid')
      .then(async (module) => {
        const mermaid = module.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        });
        const response = await mermaid.render(`mermaid-preview-${renderId}`, content);
        if (cancelled) return;
        setSvg(response.svg);
        setStatus('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        const nextMessage =
          error instanceof Error && error.message
            ? error.message
            : 'Unable to render this Mermaid diagram.';
        setErrorMessage(nextMessage);
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [content, renderId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-[#fbfaf7]">
      <div className="border-b border-border/70 px-3 py-2">
        <p className={cn('truncate text-sm font-medium', PREVIEW_TEXT_CLASS)}>{filename}</p>
        <p className={cn('truncate text-xs', PREVIEW_MUTED_TEXT_CLASS)}>Mermaid diagram preview</p>
      </div>

      <div
        className={cn(
          'relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top_left,_rgba(205,192,167,0.24),_transparent_36%),linear-gradient(180deg,_#f7f3e8,_#f2ede0)] p-4',
          layout === 'dialog' && 'max-h-[70vh]',
        )}
      >
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className={cn('size-6 animate-spin', PREVIEW_MUTED_TEXT_CLASS)} />
          </div>
        )}

        {status === 'error' && (
          <div className="flex h-full min-h-[240px] items-center justify-center px-6 text-center">
            <div className="max-w-sm space-y-2">
              <p className={cn('text-sm font-medium', PREVIEW_TEXT_CLASS)}>Diagram render failed</p>
              <p className={cn('text-xs', PREVIEW_MUTED_TEXT_CLASS)}>{errorMessage}</p>
            </div>
          </div>
        )}

        {status === 'ready' && (
          <div className="mx-auto flex min-h-full min-w-fit items-start justify-center">
            <div
              data-testid="mermaid-preview"
              className="rounded-2xl border border-border/70 bg-white p-5 shadow-sm [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:overflow-visible"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
