import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { FilePreviewContent } from '@/components/chat-file-preview/file-preview-content';
import { getPreviewType } from '@/components/chat-file-preview/file-type-utils';
import { MermaidPreview } from '@/components/chat-file-preview/mermaid-preview';

const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(async (_id: string, content: string) => ({
    svg: `<svg role="img" aria-label="Mock Mermaid"><text>${content}</text></svg>`,
  })),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

describe('mermaid preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes mermaid files and mime types to the mermaid preview', () => {
    expect(getPreviewType('diagram.mmd')).toBe('mermaid');
    expect(getPreviewType('diagram.txt', 'application/vnd.ant.mermaid')).toBe('mermaid');
    expect(getPreviewType('diagram.txt', 'text/x-mermaid')).toBe('mermaid');
  });

  it('renders svg output from the mermaid runtime', async () => {
    render(
      <MermaidPreview
        content={'graph TD\nA[Start] --> B[Ship]'}
        filename="flow.mmd"
        layout="panel"
      />,
    );

    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledWith(
        expect.stringContaining('mermaid-preview-'),
        'graph TD\nA[Start] --> B[Ship]',
      );
    });

    expect(initializeMock).toHaveBeenCalled();
    expect(await screen.findByTestId('mermaid-preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Mock Mermaid')).toBeInTheDocument();
  });

  it('fetches diagram source and renders the mermaid preview from FilePreviewContent', async () => {
    const textSpy = vi.fn().mockResolvedValue('graph LR\nA --> B');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: textSpy,
    } as Response);

    render(
      <FilePreviewContent
        filename="flowchart.mmd"
        previewUrl="https://example.test/flowchart.mmd"
        layout="panel"
      />,
    );

    expect(await screen.findByText('Mermaid diagram preview')).toBeInTheDocument();
    expect(await screen.findByTestId('mermaid-preview')).toBeInTheDocument();
    expect(textSpy).toHaveBeenCalledTimes(1);
  });
});
