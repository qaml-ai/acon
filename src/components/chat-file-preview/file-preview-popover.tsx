'use client';

import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { FilePreviewContent } from './file-preview-content';
import type { PreviewTarget } from '@/types';
import { useResolvedPreviewUrl } from './use-resolved-preview-url';

export interface FilePreviewPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filename: string;
  previewUrl: string;
  contentType?: string;
  previewTarget?: PreviewTarget;
}

export function FilePreviewPopover({
  open,
  onOpenChange,
  filename,
  previewUrl,
  contentType,
  previewTarget,
}: FilePreviewPopoverProps) {
  const resolvedPreviewUrl = useResolvedPreviewUrl(previewUrl, previewTarget);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[calc(100%-2rem)] p-0 sm:max-w-3xl"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <DialogTitle className="truncate text-sm font-medium">{filename}</DialogTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={resolvedPreviewUrl ?? previewUrl}
                download={filename}
                aria-label={`Download ${filename}`}
              >
                <Download className="h-4 w-4" />
              </a>
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close preview">
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
        </div>
        <div className="overflow-hidden p-4">
          <FilePreviewContent
            filename={filename}
            previewUrl={previewUrl}
            contentType={contentType}
            previewTarget={previewTarget}
            layout="dialog"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
