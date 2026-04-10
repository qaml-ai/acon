import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { utils, write } from 'xlsx';
import { FilePreviewContent } from '@/components/chat-file-preview/file-preview-content';
import { getPreviewType } from '@/components/chat-file-preview/file-type-utils';
import {
  extractEmbeddedChartsFromWorkbookFiles,
  SpreadsheetPreview,
} from '@/components/chat-file-preview/spreadsheet-preview';

function toArrayBuffer(value: ArrayBuffer | Uint8Array) {
  if (value instanceof ArrayBuffer) {
    return value;
  }

  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function createWorkbookBuffer() {
  const workbook = utils.book_new();

  const suppliersSheet = utils.aoa_to_sheet([
    ['Company', 'Revenue'],
    ['Acme', 42],
    ['Beta', 100],
  ]);

  const summarySheet = utils.aoa_to_sheet([['', 'Label']]);
  summarySheet.A1 = {
    t: 'n',
    f: "SUM('Supplier Stock Tracker'!B2:B3)",
  };
  summarySheet.B1 = {
    t: 's',
    v: 'Total Revenue',
  };
  summarySheet['!ref'] = 'A1:B1';

  utils.book_append_sheet(workbook, suppliersSheet, 'Supplier Stock Tracker');
  utils.book_append_sheet(workbook, summarySheet, 'Summary');

  return toArrayBuffer(write(workbook, { type: 'array', bookType: 'xlsx' }));
}

describe('spreadsheet preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('routes xlsx files to the spreadsheet preview', () => {
    expect(getPreviewType('report.xlsx')).toBe('spreadsheet');
    expect(getPreviewType('report.xls')).toBe('spreadsheet');
  });

  it('renders the workbook shell with sheet tabs and formula bar content', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    expect(screen.getByText('Workbook preview')).toBeInTheDocument();
    expect(screen.getByText('Supplier Stock Tracker')).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('A1')).toBeInTheDocument();
    expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveTextContent('Company');

    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));

    await waitFor(() => {
      expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveTextContent(
        "=SUM('Supplier Stock Tracker'!B2:B3)",
      );
    });
  });

  it('supports keyboard navigation, range extension, and copy', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Spreadsheet grid' });
    const writeText = vi.mocked(navigator.clipboard.writeText);

    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('B1')).toBeInTheDocument();
      expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveTextContent('Revenue');
    });

    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grid, { key: 'c', metaKey: true });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Revenue\n42');
    });
  });

  it('pans the spreadsheet viewport with space-drag', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Spreadsheet grid' });
    const viewport = screen.getByTestId('spreadsheet-viewport');

    Object.defineProperty(viewport, 'scrollLeft', {
      configurable: true,
      writable: true,
      value: 120,
    });
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 90,
    });

    fireEvent.keyDown(grid, { code: 'Space', key: ' ' });
    fireEvent.pointerDown(grid, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(grid, { pointerId: 1, clientX: 70, clientY: 60 });

    await waitFor(() => {
      expect(viewport.scrollLeft).toBe(150);
      expect(viewport.scrollTop).toBe(130);
    });

    fireEvent.pointerUp(grid, { pointerId: 1 });
  });

  it('renders inferred workbook charts in a dedicated charts view', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Charts' }));

    expect(await screen.findByTestId('spreadsheet-chart-workspace')).toBeInTheDocument();
    expect(screen.getByText('Revenue by Company')).toBeInTheDocument();
    expect(screen.getByLabelText('Revenue by Company')).toBeInTheDocument();
  });

  it('rebinds the data viewport observer after switching back from charts', async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();

    class ResizeObserverMock {
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);

    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    await waitFor(() => {
      expect(observe).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Charts' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));

    await waitFor(() => {
      expect(observe).toHaveBeenCalledTimes(2);
    });
  });

  it('shows a hover tooltip for chart data points', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Charts' }));
    const datum = (await screen.findAllByTestId('spreadsheet-chart-datum'))[0];

    fireEvent.mouseMove(datum, { clientX: 120, clientY: 120 });

    expect(await screen.findByTestId('spreadsheet-chart-tooltip')).toHaveTextContent('Revenue');
    expect(screen.getByTestId('spreadsheet-chart-tooltip')).toHaveTextContent('Acme');
    expect(screen.getByTestId('spreadsheet-chart-tooltip')).toHaveTextContent('42');
  });

  it('extracts embedded excel charts from workbook relationship files', () => {
    const charts = extractEmbeddedChartsFromWorkbookFiles(
      {
        'xl/worksheets/_rels/sheet1.xml.rels': {
          content: `<?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml" />
            </Relationships>`,
        },
        'xl/drawings/_rels/drawing1.xml.rels': {
          content: `<?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml" />
            </Relationships>`,
        },
        'xl/charts/chart1.xml': {
          content: `<?xml version="1.0" encoding="UTF-8"?>
            <c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <c:chart>
                <c:title>
                  <c:tx>
                    <c:rich>
                      <a:p><a:r><a:t>Quarterly Revenue</a:t></a:r></a:p>
                    </c:rich>
                  </c:tx>
                </c:title>
                <c:plotArea>
                  <c:barChart>
                    <c:ser>
                      <c:tx><c:v>Revenue</c:v></c:tx>
                      <c:cat>
                        <c:strRef>
                          <c:strCache>
                            <c:pt idx="0"><c:v>Q1</c:v></c:pt>
                            <c:pt idx="1"><c:v>Q2</c:v></c:pt>
                          </c:strCache>
                        </c:strRef>
                      </c:cat>
                      <c:val>
                        <c:numRef>
                          <c:numCache>
                            <c:pt idx="0"><c:v>12</c:v></c:pt>
                            <c:pt idx="1"><c:v>18</c:v></c:pt>
                          </c:numCache>
                        </c:numRef>
                      </c:val>
                    </c:ser>
                  </c:barChart>
                </c:plotArea>
              </c:chart>
            </c:chartSpace>`,
        },
      },
      ['Revenue'],
    );

    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      title: 'Quarterly Revenue',
      kind: 'bar',
      sheetName: 'Revenue',
      source: 'embedded',
      categories: ['Q1', 'Q2'],
    });
    expect(charts[0]?.series[0]?.values).toEqual([12, 18]);
  });

  it('opens a context menu copy action for the current selection', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Spreadsheet grid' });
    const writeText = vi.mocked(navigator.clipboard.writeText);

    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({
      bottom: 400,
      height: 400,
      left: 0,
      right: 600,
      top: 0,
      width: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.contextMenu(grid, { clientX: 64, clientY: 64 });
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Company');
    });
  });

  it('fetches binary workbook content for xlsx previews', async () => {
    const arrayBuffer = createWorkbookBuffer();
    const arrayBufferSpy = vi.fn().mockResolvedValue(arrayBuffer);
    const textSpy = vi.fn().mockResolvedValue('text path should not be used');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: arrayBufferSpy,
      text: textSpy,
    } as Response);

    render(
      <FilePreviewContent
        filename="suppliers.xlsx"
        previewUrl="https://example.test/suppliers.xlsx"
        layout="panel"
      />,
    );

    await screen.findByText('Workbook preview');

    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
