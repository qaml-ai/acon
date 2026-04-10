'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Copy } from 'lucide-react';
import { read, utils, type CellObject, type WorkBook } from 'xlsx';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getFileExtension } from './file-type-utils';

const INDEX_COLUMN_WIDTH = 56;
const HEADER_ROW_HEIGHT = 34;
const DEFAULT_ROW_HEIGHT = 28;
const MIN_COLUMN_WIDTH = 88;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLUMNS = 120;

type SpreadsheetSelection = {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
};

type SpreadsheetCell = {
  value: string | null;
  formula?: string | null;
  numberValue?: number | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  textAlign?: CanvasTextAlign | null;
};

type SpreadsheetMerge = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

type SpreadsheetSheet = {
  name: string;
  rows: SpreadsheetCell[][];
  rowCount: number;
  columnCount: number;
  rowHeights: number[];
  columnWidths: number[];
  merges: SpreadsheetMerge[];
  rowKinds: Array<'body' | 'header' | 'title'>;
  isFirstRowHeader: boolean;
  wasTrimmed: boolean;
};

type SpreadsheetChartSeries = {
  name: string;
  values: Array<number | null>;
  color: string;
};

type SpreadsheetChart = {
  id: string;
  kind: 'bar' | 'line' | 'pie' | 'doughnut';
  title: string;
  sheetName: string;
  categoryLabel: string;
  categories: string[];
  series: SpreadsheetChartSeries[];
  source: 'embedded' | 'inferred';
};

type SpreadsheetWorkbook = {
  sheets: SpreadsheetSheet[];
  charts: SpreadsheetChart[];
  kind: 'excel' | 'delimited';
};

interface SpreadsheetPreviewProps {
  content: string | ArrayBuffer;
  filename: string;
  contentType?: string;
  layout: 'panel' | 'dialog';
}

type ColumnResizeState = {
  columnIndex: number;
  pointerX: number;
  startWidth: number;
} | null;

type ContextMenuState = {
  left: number;
  top: number;
} | null;

type SpreadsheetPanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
} | null;

type SpreadsheetSurface = 'data' | 'charts';

const CHART_COLORS = ['#2563EB', '#14B8A6', '#D97706', '#7C3AED'];
const PREVIEW_TEXT_CLASS = 'text-[#221b12]';
const PREVIEW_MUTED_TEXT_CLASS = 'text-[#6b5f49]';
const PREVIEW_SOFT_MUTED_TEXT_CLASS = 'text-[#7a6a50]';
const PREVIEW_SHELL_CLASS = 'bg-[#fbfaf7]';
const PREVIEW_PANEL_CLASS = 'bg-[#f4f0e5]';
const PREVIEW_SUBTLE_PANEL_CLASS = 'bg-[#f0ece2]';
const PREVIEW_CHIP_CLASS = 'bg-[#efe8d6]';
const PREVIEW_INPUT_CLASS = 'bg-white';

type WorkbookFileEntry = {
  content?: unknown;
};

type ChartHoverState = {
  key: string;
  category: string;
  seriesName: string;
  value: number;
  left: number;
  top: number;
  color: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getCellValue(cell: SpreadsheetCell | null | undefined) {
  return cell?.value ?? '';
}

function getCellFormula(cell: SpreadsheetCell | null | undefined) {
  return cell?.formula ?? null;
}

function getCellNumberValue(cell: SpreadsheetCell | null | undefined) {
  if (typeof cell?.numberValue === 'number' && Number.isFinite(cell.numberValue)) {
    return cell.numberValue;
  }
  return null;
}

function normalizeHexColor(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(trimmed)) return null;
  return `#${trimmed}`;
}

function parseNumericLikeValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/\u00A0/g, '')
    .replace(/[$€£¥,]/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/%$/, '');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getForegroundForBackground(backgroundColor: string | null) {
  if (!backgroundColor) return null;
  const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
  const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.52 ? '#F8FAFC' : '#1F2937';
}

function detectCellAlignment(cell: CellObject | undefined): CanvasTextAlign | null {
  if (!cell) return null;
  if (cell.t === 'n' || cell.t === 'd') return 'right';
  if (cell.t === 'b') return 'center';
  return null;
}

function toColumnLabel(index: number) {
  let current = index;
  let label = '';
  while (current >= 0) {
    label = String.fromCharCode((current % 26) + 65) + label;
    current = Math.floor(current / 26) - 1;
  }
  return label;
}

function getSpreadsheetDelimiter(filename: string, contentType?: string): ',' | '\t' {
  const normalizedContentType = contentType?.toLowerCase();
  if (getFileExtension(filename) === 'tsv') return '\t';
  if (normalizedContentType?.includes('tab-separated-values')) return '\t';
  return ',';
}

function stringifyCellValue(cell: CellObject | undefined): SpreadsheetCell | null {
  if (!cell) return null;
  const formula = typeof cell.f === 'string' ? cell.f : null;
  const numberValue = typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
  const backgroundColor = normalizeHexColor(
    (cell.s as { fgColor?: { rgb?: unknown } } | undefined)?.fgColor?.rgb,
  );
  const textColor = getForegroundForBackground(backgroundColor);
  const textAlign = detectCellAlignment(cell);
  if (cell.w !== undefined && cell.w !== null && String(cell.w).length > 0) {
    return { value: String(cell.w), formula, numberValue, backgroundColor, textColor, textAlign };
  }
  if (cell.v === undefined || cell.v === null || cell.v === '') {
    return { value: null, formula, numberValue, backgroundColor, textColor, textAlign };
  }
  if (typeof cell.v === 'number') {
    return {
      value: Number.isInteger(cell.v) ? String(cell.v) : cell.v.toFixed(2),
      formula,
      numberValue,
      backgroundColor,
      textColor,
      textAlign,
    };
  }
  if (typeof cell.v === 'boolean') {
    return {
      value: cell.v ? 'TRUE' : 'FALSE',
      formula,
      numberValue,
      backgroundColor,
      textColor,
      textAlign,
    };
  }
  return { value: String(cell.v), formula, numberValue, backgroundColor, textColor, textAlign };
}

function parseDelimitedRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      current.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      current.push(field);
      field = '';
      if (current.some((value) => value.length > 0)) {
        rows.push(current);
      }
      current = [];
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }

    field += char;
  }

  current.push(field);
  if (current.some((value) => value.length > 0)) {
    rows.push(current);
  }

  return rows;
}

function parseDelimitedWorkbook(
  text: string,
  filename: string,
  contentType?: string,
): SpreadsheetWorkbook | null {
  const rows = parseDelimitedRows(text, getSpreadsheetDelimiter(filename, contentType));
  if (rows.length === 0) return null;
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => ({
      value: row[index] ?? '',
      formula: null,
      numberValue: parseNumericLikeValue(row[index] ?? ''),
    })),
  );

  const sheets: SpreadsheetSheet[] = [
    {
      name: 'Data',
      rows: normalizedRows,
      rowCount: normalizedRows.length,
      columnCount,
      rowHeights: Array.from({ length: normalizedRows.length }, () => DEFAULT_ROW_HEIGHT),
      columnWidths: [],
      merges: [],
      rowKinds: normalizedRows.map((_, index) => (index === 0 ? 'header' : 'body')),
      isFirstRowHeader: true,
      wasTrimmed: false,
    },
  ];

  return {
    kind: 'delimited',
    sheets,
    charts: inferWorkbookCharts(sheets),
  };
}

function detectWorkbookRowKinds(
  rows: SpreadsheetCell[][],
  merges: SpreadsheetMerge[],
  columnCount: number,
) {
  return rows.map((row, rowIndex) => {
    const nonEmptyCells = row.filter((cell) => Boolean(getCellValue(cell)));
    if (nonEmptyCells.length === 0) return 'body' as const;

    const fullWidthMerge = merges.find(
      (merge) =>
        merge.startRow === rowIndex &&
        merge.startCol === 0 &&
        merge.endCol >= Math.max(0, columnCount - 1),
    );
    if (fullWidthMerge && nonEmptyCells.length === 1) {
      return 'title' as const;
    }

    const fillColors = nonEmptyCells
      .map((cell) => cell.backgroundColor)
      .filter((value): value is string => Boolean(value));
    const hasUniformFill =
      fillColors.length === nonEmptyCells.length && new Set(fillColors).size === 1;
    const mostlyLabels = nonEmptyCells.every((cell) => {
      const value = getCellValue(cell);
      return value.length > 0 && !/[\d$%]/.test(value);
    });

    if (nonEmptyCells.length >= Math.min(3, columnCount) && hasUniformFill && mostlyLabels) {
      return 'header' as const;
    }

    return 'body' as const;
  });
}

function getChartLabel(value: string, fallback: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function getSheetTitle(sheet: SpreadsheetSheet) {
  const titleRowIndex = sheet.rowKinds.findIndex((kind) => kind === 'title');
  if (titleRowIndex < 0) return null;
  const values = sheet.rows[titleRowIndex]
    ?.map((cell) => getCellValue(cell))
    .filter((value) => value.trim().length > 0);
  return values && values.length > 0 ? values.join(' ') : null;
}

function inferChartHeaderRow(sheet: SpreadsheetSheet) {
  const explicitHeaderRow = sheet.rowKinds.findIndex((kind) => kind === 'header');
  if (explicitHeaderRow >= 0) {
    return explicitHeaderRow;
  }

  for (let rowIndex = 0; rowIndex < Math.min(sheet.rowCount, 16); rowIndex += 1) {
    const values = sheet.rows[rowIndex]
      ?.map((cell) => getCellValue(cell))
      .filter((value) => value.trim().length > 0);
    if ((values?.length ?? 0) >= 2) {
      return rowIndex;
    }
  }

  return -1;
}

function inferSheetChart(sheet: SpreadsheetSheet): SpreadsheetChart | null {
  if (sheet.rowCount < 2 || sheet.columnCount < 2) {
    return null;
  }

  const headerRowIndex = inferChartHeaderRow(sheet);
  if (headerRowIndex < 0 || headerRowIndex >= sheet.rowCount - 1) {
    return null;
  }

  const dataRowIndexes: number[] = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < sheet.rowCount; rowIndex += 1) {
    const hasVisibleValue = sheet.rows[rowIndex]?.some((cell) => getCellValue(cell).trim().length > 0);
    if (hasVisibleValue) {
      dataRowIndexes.push(rowIndex);
    }
    if (dataRowIndexes.length >= 32) {
      break;
    }
  }

  if (dataRowIndexes.length < 2) {
    return null;
  }

  const columnStats = Array.from({ length: sheet.columnCount }, (_, columnIndex) => {
    let nonEmptyCount = 0;
    let numericCount = 0;
    let textCount = 0;
    const labels = new Set<string>();

    for (const rowIndex of dataRowIndexes) {
      const cell = sheet.rows[rowIndex]?.[columnIndex];
      const value = getCellValue(cell).trim();
      if (!value) continue;
      nonEmptyCount += 1;
      const numberValue = getCellNumberValue(cell) ?? parseNumericLikeValue(value);
      if (numberValue !== null) {
        numericCount += 1;
      } else {
        textCount += 1;
      }
      if (labels.size < 12) {
        labels.add(value);
      }
    }

    return {
      columnIndex,
      nonEmptyCount,
      numericCount,
      textCount,
      distinctTextCount: labels.size,
    };
  });

  const numericColumns = columnStats
    .filter((column) => column.numericCount >= 2 && column.numericCount >= column.textCount)
    .map((column) => column.columnIndex)
    .slice(0, CHART_COLORS.length);
  if (numericColumns.length === 0) {
    return null;
  }

  const firstNumericColumn = numericColumns[0];
  const categoryColumn =
    columnStats.find(
      (column) =>
        column.columnIndex !== firstNumericColumn &&
        column.nonEmptyCount >= 2 &&
        column.textCount >= Math.max(2, column.numericCount) &&
        column.distinctTextCount >= 2,
    )?.columnIndex ??
    columnStats.find(
      (column) =>
        column.columnIndex < firstNumericColumn &&
        column.columnIndex !== firstNumericColumn &&
        column.nonEmptyCount >= 2,
    )?.columnIndex ??
    null;

  const series = numericColumns.map((columnIndex, seriesIndex) => {
    const label = getChartLabel(
      getCellValue(sheet.rows[headerRowIndex]?.[columnIndex]),
      `${sheet.name} ${toColumnLabel(columnIndex)}`,
    );
    return {
      columnIndex,
      name: label,
      color: CHART_COLORS[seriesIndex] ?? CHART_COLORS[0],
    };
  });

  const preferredKind = series.length > 1 ? 'line' : 'bar';
  const maxPoints = preferredKind === 'line' ? 16 : 10;
  const categories: string[] = [];
  const seriesValues = series.map(() => [] as Array<number | null>);

  for (const rowIndex of dataRowIndexes) {
    const row = sheet.rows[rowIndex];
    const values = series.map(({ columnIndex }) => {
      const cell = row?.[columnIndex];
      return getCellNumberValue(cell) ?? parseNumericLikeValue(getCellValue(cell));
    });
    if (values.every((value) => value === null)) {
      continue;
    }

    const categoryValue =
      categoryColumn !== null
        ? getChartLabel(getCellValue(row?.[categoryColumn]), `Row ${rowIndex + 1}`)
        : `Row ${rowIndex + 1}`;
    categories.push(categoryValue);
    values.forEach((value, index) => {
      seriesValues[index].push(value);
    });

    if (categories.length >= maxPoints) {
      break;
    }
  }

  if (categories.length < 2) {
    return null;
  }

  const categoryLabel =
    categoryColumn !== null
      ? getChartLabel(getCellValue(sheet.rows[headerRowIndex]?.[categoryColumn]), 'Category')
      : 'Row';
  const sheetTitle = getSheetTitle(sheet);
  const title =
    series.length === 1
      ? `${series[0].name} by ${categoryLabel}`
      : `${sheetTitle ?? sheet.name} trends`;

  return {
    id: `${sheet.name}:${preferredKind}`,
    kind: preferredKind,
    title,
    sheetName: sheet.name,
    categoryLabel,
    categories,
    series: series.map((entry, index) => ({
      name: entry.name,
      values: seriesValues[index],
      color: entry.color,
    })),
    source: 'inferred',
  };
}

function inferWorkbookCharts(sheets: SpreadsheetSheet[]) {
  return sheets
    .map((sheet) => inferSheetChart(sheet))
    .filter((chart): chart is SpreadsheetChart => Boolean(chart));
}

function decodeWorkbookFileContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) {
    return new TextDecoder().decode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(content));
  }
  if (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(content)
  ) {
    return content.toString('utf8');
  }
  if (ArrayBuffer.isView(content)) {
    return new TextDecoder().decode(
      new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
    );
  }
  return null;
}

function getWorkbookFileText(
  files: Record<string, WorkbookFileEntry> | undefined,
  path: string,
) {
  if (!files) return null;
  const entry = files[path];
  if (!entry) return null;
  return decodeWorkbookFileContent(entry.content);
}

function parseXmlDocument(text: string | null) {
  if (!text) return null;
  const document = new DOMParser().parseFromString(text, 'text/xml');
  if (document.querySelector('parsererror')) return null;
  return document;
}

function getChildrenByLocalName(node: ParentNode, localName: string) {
  const targetName = localName.toLowerCase();
  return Array.from(node.childNodes).filter(
    (child): child is Element =>
      child.nodeType === Node.ELEMENT_NODE &&
      ((child as Element).localName ?? '').toLowerCase() === targetName,
  );
}

function getFirstChildByLocalName(node: ParentNode, localName: string) {
  return getChildrenByLocalName(node, localName)[0] ?? null;
}

function getDescendantsByLocalName(node: ParentNode, localName: string) {
  const targetName = localName.toLowerCase();
  return Array.from((node as Element | Document).getElementsByTagName('*')).filter(
    (element): element is Element => (element.localName ?? '').toLowerCase() === targetName,
  );
}

function getDescendantText(node: ParentNode, localName: string) {
  const target = getDescendantsByLocalName(node, localName)[0];
  return target?.textContent?.trim() || null;
}

function normalizeWorkbookPath(basePath: string, relativePath: string) {
  const stack = basePath.split('/').filter(Boolean);
  if (!basePath.endsWith('/')) {
    stack.pop();
  }
  for (const segment of relativePath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function parseRelationships(
  files: Record<string, WorkbookFileEntry> | undefined,
  relsPath: string,
) {
  const document = parseXmlDocument(getWorkbookFileText(files, relsPath));
  if (!document) return [];
  return getDescendantsByLocalName(document, 'Relationship')
    .map((relationship) => ({
      id: relationship.getAttribute('Id') || '',
      type: relationship.getAttribute('Type') || '',
      target: relationship.getAttribute('Target') || '',
    }))
    .filter((relationship) => relationship.id && relationship.target);
}

function getCachePoints(node: Element | null) {
  if (!node) return [];
  const cache =
    getDescendantsByLocalName(node, 'strCache')[0] ??
    getDescendantsByLocalName(node, 'numCache')[0] ??
    getDescendantsByLocalName(node, 'strLit')[0] ??
    getDescendantsByLocalName(node, 'numLit')[0];
  if (!cache) return [];
  return getChildrenByLocalName(cache, 'pt')
    .sort(
      (left, right) =>
        Number.parseInt(left.getAttribute('idx') ?? '0', 10) -
        Number.parseInt(right.getAttribute('idx') ?? '0', 10),
    )
    .map((point) => getDescendantText(point, 'v') ?? point.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
}

function getSeriesName(seriesNode: Element, fallback: string) {
  const tx = getFirstChildByLocalName(seriesNode, 'tx');
  const text =
    getDescendantText(tx ?? seriesNode, 'v') ??
    getDescendantText(tx ?? seriesNode, 't');
  return text && text.length > 0 ? text : fallback;
}

function getChartTitle(chartSpace: Document, fallback: string) {
  const titleNode = getDescendantsByLocalName(chartSpace, 'title')[0];
  if (!titleNode) return fallback;
  const textParts = getDescendantsByLocalName(titleNode, 't')
    .map((node) => node.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
  return textParts.length > 0 ? textParts.join(' ') : fallback;
}

function parseEmbeddedChartNode(
  chartNode: Element,
  chartFile: string,
  sheetName: string,
) {
  const seriesNodes = getChildrenByLocalName(chartNode, 'ser');
  if (seriesNodes.length === 0) return null;

  const kindMap: Record<string, SpreadsheetChart['kind']> = {
    barChart: 'bar',
    lineChart: 'line',
    areaChart: 'line',
    pieChart: 'pie',
    doughnutChart: 'doughnut',
  };

  const chartKind = kindMap[chartNode.localName] ?? 'line';
  const primaryCategories = getCachePoints(getFirstChildByLocalName(seriesNodes[0], 'cat'));
  const categories =
    primaryCategories.length > 0
      ? primaryCategories
      : getCachePoints(getFirstChildByLocalName(seriesNodes[0], 'xVal'));
  if (categories.length === 0) return null;

  const series = seriesNodes
    .map((seriesNode, index) => {
      const valueNode =
        getFirstChildByLocalName(seriesNode, 'val') ??
        getFirstChildByLocalName(seriesNode, 'yVal');
      const values = getCachePoints(valueNode).map((value) => parseNumericLikeValue(value));
      if (values.every((value) => value === null)) {
        return null;
      }
      return {
        name: getSeriesName(seriesNode, `Series ${index + 1}`),
        values,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0],
      };
    })
    .filter((series): series is SpreadsheetChartSeries => Boolean(series));

  if (series.length === 0) return null;

  const categoryLabel =
    chartKind === 'pie' || chartKind === 'doughnut' ? 'Slice' : 'Category';

  return {
    id: `${sheetName}:${chartFile}:${chartKind}`,
    kind: chartKind,
    title: `${sheetName} chart`,
    sheetName,
    categoryLabel,
    categories,
    series,
    source: 'embedded' as const,
  };
}

export function extractEmbeddedChartsFromWorkbookFiles(
  files: Record<string, WorkbookFileEntry> | undefined,
  sheetNames: string[],
) {
  if (!files || sheetNames.length === 0) return [] as SpreadsheetChart[];

  const chartPathsBySheet = new Map<string, Set<string>>();

  sheetNames.forEach((sheetName, index) => {
    const sheetRelsPath = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`;
    const drawingRelationships = parseRelationships(files, sheetRelsPath).filter((relationship) =>
      relationship.type.includes('/drawing'),
    );
    for (const drawingRelationship of drawingRelationships) {
      const drawingPath = normalizeWorkbookPath(`xl/worksheets/${sheetRelsPath.split('/').pop() ?? ''}`, drawingRelationship.target);
      const drawingRelsPath = drawingPath.replace(
        /^xl\/drawings\/([^/]+)$/,
        'xl/drawings/_rels/$1.rels',
      );
      const chartRelationships = parseRelationships(files, drawingRelsPath).filter((relationship) =>
        relationship.type.includes('/chart'),
      );
      for (const chartRelationship of chartRelationships) {
        const chartPath = normalizeWorkbookPath(drawingPath, chartRelationship.target);
        const existing = chartPathsBySheet.get(sheetName) ?? new Set<string>();
        existing.add(chartPath);
        chartPathsBySheet.set(sheetName, existing);
      }
    }
  });

  const charts: SpreadsheetChart[] = [];

  for (const [sheetName, chartPaths] of chartPathsBySheet) {
    for (const chartPath of chartPaths) {
      const document = parseXmlDocument(getWorkbookFileText(files, chartPath));
      if (!document) continue;
      const chartNode =
        getDescendantsByLocalName(document, 'barChart')[0] ??
        getDescendantsByLocalName(document, 'lineChart')[0] ??
        getDescendantsByLocalName(document, 'pieChart')[0] ??
        getDescendantsByLocalName(document, 'doughnutChart')[0] ??
        getDescendantsByLocalName(document, 'areaChart')[0];
      if (!chartNode) continue;
      const parsedChart = parseEmbeddedChartNode(chartNode, chartPath, sheetName);
      if (!parsedChart) continue;
      parsedChart.title = getChartTitle(document, parsedChart.title);
      charts.push(parsedChart);
    }
  }

  return charts;
}

function parseWorkbookSheet(workbook: WorkBook, sheetName: string): SpreadsheetSheet {
  const worksheet = workbook.Sheets[sheetName];
  const ref = worksheet?.['!ref'];
  if (!worksheet || !ref) {
    return {
      name: sheetName,
      rows: [],
      rowCount: 0,
      columnCount: 0,
      rowHeights: [],
      columnWidths: [],
      merges: [],
      rowKinds: [],
      isFirstRowHeader: false,
      wasTrimmed: false,
    };
  }

  const range = utils.decode_range(ref);
  const rowCount = Math.min(range.e.r + 1, MAX_SHEET_ROWS);
  const columnCount = Math.min(range.e.c + 1, MAX_SHEET_COLUMNS);
  const wasTrimmed = rowCount < range.e.r + 1 || columnCount < range.e.c + 1;
  const merges = ((worksheet['!merges'] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> | undefined) ?? [])
    .filter((merge) => merge.s.r < rowCount && merge.s.c < columnCount)
    .map((merge) => ({
      startRow: merge.s.r,
      startCol: merge.s.c,
      endRow: Math.min(merge.e.r, rowCount - 1),
      endCol: Math.min(merge.e.c, columnCount - 1),
    }));
  const rowHeights = Array.from({ length: rowCount }, (_, rowIndex) => {
    const descriptor = (worksheet['!rows'] as Array<{ hpx?: number } | null> | undefined)?.[rowIndex];
    return clamp(Math.round(descriptor?.hpx ?? DEFAULT_ROW_HEIGHT), 22, 56);
  });
  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const descriptor = (worksheet['!cols'] as Array<{ wpx?: number } | undefined> | undefined)?.[columnIndex];
    return descriptor?.wpx ? clamp(Math.round(descriptor.wpx + 14), MIN_COLUMN_WIDTH, 320) : 0;
  });
  const rows: SpreadsheetCell[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: SpreadsheetCell[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const address = utils.encode_cell({ r: rowIndex, c: columnIndex });
      row.push(
        stringifyCellValue(worksheet[address]) ?? {
          value: null,
          formula: null,
          numberValue: null,
          backgroundColor: null,
          textColor: null,
          textAlign: null,
        },
      );
    }
    rows.push(row);
  }

  const rowKinds = detectWorkbookRowKinds(rows, merges, columnCount);

  return {
    name: sheetName,
    rows,
    rowCount,
    columnCount,
    rowHeights,
    columnWidths,
    merges,
    rowKinds,
    isFirstRowHeader: false,
    wasTrimmed,
  };
}

function parseExcelWorkbook(content: ArrayBuffer): SpreadsheetWorkbook | null {
  const workbook = read(content, {
    type: 'array',
    cellFormula: true,
    cellStyles: true,
    bookFiles: true,
    sheetStubs: true,
    raw: false,
  });

  const sheets = workbook.SheetNames.map((sheetName) => parseWorkbookSheet(workbook, sheetName));
  if (sheets.length === 0) return null;
  const embeddedCharts = extractEmbeddedChartsFromWorkbookFiles(
    (workbook as WorkBook & { files?: Record<string, WorkbookFileEntry> }).files,
    workbook.SheetNames,
  );
  return {
    kind: 'excel',
    sheets,
    charts: embeddedCharts.length > 0 ? embeddedCharts : inferWorkbookCharts(sheets),
  };
}

function parseSpreadsheetWorkbook(
  content: string | ArrayBuffer,
  filename: string,
  contentType?: string,
): SpreadsheetWorkbook | null {
  const extension = getFileExtension(filename);
  if (content instanceof ArrayBuffer || extension === 'xlsx' || extension === 'xls') {
    if (!(content instanceof ArrayBuffer)) return null;
    return parseExcelWorkbook(content);
  }
  return parseDelimitedWorkbook(content, filename, contentType);
}

function createInitialColumnWidths(sheet: SpreadsheetSheet) {
  return Array.from({ length: sheet.columnCount }, (_, columnIndex) => {
    const workbookWidth = sheet.columnWidths[columnIndex];
    if (workbookWidth && workbookWidth > 0) {
      return workbookWidth;
    }
    let maxLength = toColumnLabel(columnIndex).length;
    const sampleRows = Math.min(sheet.rowCount, 40);
    for (let rowIndex = 0; rowIndex < sampleRows; rowIndex += 1) {
      const value = getCellValue(sheet.rows[rowIndex]?.[columnIndex]);
      maxLength = Math.max(maxLength, value.length);
    }
    return clamp(40 + maxLength * 7.5, MIN_COLUMN_WIDTH, 280);
  });
}

function getSelectionBounds(selection: SpreadsheetSelection) {
  return {
    top: Math.min(selection.anchorRow, selection.focusRow),
    bottom: Math.max(selection.anchorRow, selection.focusRow),
    left: Math.min(selection.anchorCol, selection.focusCol),
    right: Math.max(selection.anchorCol, selection.focusCol),
  };
}

function buildClipboardText(sheet: SpreadsheetSheet, selection: SpreadsheetSelection) {
  const bounds = getSelectionBounds(selection);
  const lines: string[] = [];
  for (let rowIndex = bounds.top; rowIndex <= bounds.bottom; rowIndex += 1) {
    const values: string[] = [];
    for (let columnIndex = bounds.left; columnIndex <= bounds.right; columnIndex += 1) {
      values.push(getCellValue(sheet.rows[rowIndex]?.[columnIndex]));
    }
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

function measureSheetWidth(columnWidths: number[]) {
  return INDEX_COLUMN_WIDTH + columnWidths.reduce((total, width) => total + width, 0);
}

function measureSheetHeight(rowHeights: number[]) {
  return HEADER_ROW_HEIGHT + rowHeights.reduce((total, height) => total + height, 0);
}

function getColumnLeft(columnWidths: number[], columnIndex: number) {
  let left = INDEX_COLUMN_WIDTH;
  for (let index = 0; index < columnIndex; index += 1) {
    left += columnWidths[index] ?? MIN_COLUMN_WIDTH;
  }
  return left;
}

function getRowTop(rowOffsets: number[], rowIndex: number) {
  return rowOffsets[rowIndex] ?? HEADER_ROW_HEIGHT;
}

function getSelectionFrame(
  selection: SpreadsheetSelection,
  columnWidths: number[],
  rowOffsets: number[],
  rowHeights: number[],
  mergeByAnchor: Map<string, SpreadsheetMerge>,
) {
  const bounds = getSelectionBounds(selection);
  const merge =
    bounds.top === bounds.bottom && bounds.left === bounds.right
      ? mergeByAnchor.get(`${bounds.top}:${bounds.left}`)
      : null;
  const effectiveLeft = merge?.startCol ?? bounds.left;
  const effectiveRight = merge?.endCol ?? bounds.right;
  const effectiveTop = merge?.startRow ?? bounds.top;
  const effectiveBottom = merge?.endRow ?? bounds.bottom;
  const left = getColumnLeft(columnWidths, effectiveLeft);
  const top = getRowTop(rowOffsets, effectiveTop);
  let width = 0;
  for (let index = effectiveLeft; index <= effectiveRight; index += 1) {
    width += columnWidths[index] ?? MIN_COLUMN_WIDTH;
  }
  let height = 0;
  for (let index = effectiveTop; index <= effectiveBottom; index += 1) {
    height += rowHeights[index] ?? DEFAULT_ROW_HEIGHT;
  }
  return { left, top, width, height };
}

function findRowIndexAtPosition(y: number, rowOffsets: number[], rowHeights: number[]) {
  if (rowOffsets.length === 0) {
    return -1;
  }
  if (y <= HEADER_ROW_HEIGHT) {
    return 0;
  }
  for (let rowIndex = 0; rowIndex < rowOffsets.length; rowIndex += 1) {
    const rowTop = rowOffsets[rowIndex];
    const rowBottom = rowTop + (rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT);
    if (y >= rowTop && y <= rowBottom) {
      return rowIndex;
    }
  }
  return rowOffsets.length - 1;
}

function formatChartValue(value: number) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (absoluteValue >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (absoluteValue >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  if (absoluteValue >= 100) {
    return value.toFixed(0);
  }
  if (absoluteValue >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2).replace(/\.00$/, '');
}

function truncateChartLabel(label: string, maxLength = 12) {
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

function getChartDomain(chart: SpreadsheetChart) {
  const values = chart.series.flatMap((series) =>
    series.values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
  );
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }
  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  if (max === min) {
    return { min: min - 1, max: max + 1 };
  }
  const padding = (max - min) * 0.12;
  return { min: min - padding, max: max + padding };
}

function getChartKindLabel(kind: SpreadsheetChart['kind']) {
  switch (kind) {
    case 'bar':
      return 'Column';
    case 'line':
      return 'Line';
    case 'pie':
      return 'Pie';
    case 'doughnut':
      return 'Doughnut';
    default:
      return 'Chart';
  }
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * (Math.PI / 180);
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeChartSource(chart: SpreadsheetChart) {
  return chart.source === 'embedded' ? 'Embedded Excel chart' : 'Generated from table data';
}

function SpreadsheetChartGraphic({ chart, compact = false }: { chart: SpreadsheetChart; compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [hoveredDatum, setHoveredDatum] = useState<ChartHoverState | null>(null);
  const width = 640;
  const height = compact ? 260 : 360;
  const padding = { top: 18, right: 20, bottom: 44, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const domain = getChartDomain(chart);
  const yScale = (value: number) =>
    padding.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight;
  const zeroY = yScale(0);
  const tickValues = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    return domain.max - (domain.max - domain.min) * ratio;
  });
  const isCircularChart = chart.kind === 'pie' || chart.kind === 'doughnut';
  const categoryColors = chart.categories.map(
    (_, index) => CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0],
  );
  const circularSeries = chart.series[0];
  const circularValues = circularSeries?.values.map((value) => Math.max(value ?? 0, 0)) ?? [];
  const circularTotal = circularValues.reduce((sum, value) => sum + value, 0);
  let currentAngle = 0;

  const positionTooltip = (left: number, top: number) => {
    if (!tooltipRef.current) return;
    tooltipRef.current.style.left = `${left}px`;
    tooltipRef.current.style.top = `${top}px`;
  };

  const showHover = (
    event: ReactMouseEvent<SVGElement>,
    payload: Omit<ChartHoverState, 'left' | 'top'>,
  ) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const left = clamp(localX, 20, Math.max(20, rect.width - 20));
    const top = clamp(localY, 16, Math.max(16, rect.height - 16));

    if (
      hoveredDatum &&
      hoveredDatum.key === payload.key &&
      hoveredDatum.category === payload.category &&
      hoveredDatum.seriesName === payload.seriesName &&
      hoveredDatum.value === payload.value &&
      hoveredDatum.color === payload.color
    ) {
      positionTooltip(left, top);
      return;
    }

    setHoveredDatum({
      ...payload,
      left,
      top,
    });
  };

  useEffect(() => {
    if (!hoveredDatum) return;
    positionTooltip(hoveredDatum.left, hoveredDatum.top);
  }, [hoveredDatum]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      onMouseLeave={() => {
        setHoveredDatum(null);
      }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full"
        role="img"
        aria-label={chart.title}
      >
        <rect x="0" y="0" width={width} height={height} rx="18" fill="#f6f1e6" />

      {isCircularChart ? (
        <>
          <g transform={`translate(${width * 0.34}, ${height / 2})`}>
            <circle cx="0" cy="0" r="84" fill="#efe8d6" />
            {circularTotal > 0 &&
              chart.categories.map((category, index) => {
                const value = circularValues[index] ?? 0;
                if (value <= 0) return null;
                const arcAngle = (value / circularTotal) * 360;
                const start = polarToCartesian(0, 0, 84, currentAngle);
                const end = polarToCartesian(0, 0, 84, currentAngle + arcAngle);
                const largeArc = arcAngle > 180 ? 1 : 0;
                const path = [
                  'M 0 0',
                  `L ${start.x} ${start.y}`,
                  `A 84 84 0 ${largeArc} 1 ${end.x} ${end.y}`,
                  'Z',
                ].join(' ');
                const segment = (
                  <path
                    data-testid="spreadsheet-chart-datum"
                    key={`${category}-${index}`}
                    d={path}
                    fill={categoryColors[index]}
                    stroke="#f6f1e6"
                    strokeWidth={hoveredDatum?.key === `${chart.kind}:${index}:${category}` ? '4' : '2'}
                    onMouseMove={(event) =>
                      showHover(event, {
                        key: `${chart.kind}:${index}:${category}`,
                        category,
                        seriesName: circularSeries?.name ?? chart.title,
                        value,
                        color: categoryColors[index],
                      })
                    }
                  />
                );
                currentAngle += arcAngle;
                return segment;
              })}
            {chart.kind === 'doughnut' && <circle cx="0" cy="0" r="42" fill="#f6f1e6" />}
          </g>

          <g transform={`translate(${width * 0.56}, 48)`}>
            {chart.categories.map((category, index) => {
              const value = circularValues[index] ?? 0;
              const top = index * 28;
              return (
                <g key={`${category}-${index}-legend`} transform={`translate(0, ${top})`}>
                  <circle cx="8" cy="8" r="6" fill={categoryColors[index]} />
                  <text x="24" y="12" fontSize="12" fill="#2f2617">
                    {truncateChartLabel(category, 20)}
                  </text>
                  <text x="220" y="12" fontSize="12" fill="#6b5f49" textAnchor="end">
                    {formatChartValue(value)}
                  </text>
                </g>
              );
            })}
          </g>
        </>
      ) : (
        <>
          {tickValues.map((tickValue, index) => {
            const y = yScale(tickValue);
            return (
              <g key={index}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="#ddd4bf"
                  strokeDasharray="4 6"
                />
                <text
                  x={padding.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="#7a6a50"
                >
                  {formatChartValue(tickValue)}
                </text>
              </g>
            );
          })}
          <line
            x1={padding.left}
            y1={zeroY}
            x2={width - padding.right}
            y2={zeroY}
            stroke="#b7ab92"
            strokeWidth="1.2"
          />

          {chart.kind === 'bar'
            ? (() => {
                const series = chart.series[0];
                const slotWidth = plotWidth / chart.categories.length;
                const barWidth = Math.min(36, slotWidth * 0.62);
                return chart.categories.map((category, index) => {
                  const value = series.values[index];
                  if (value === null) return null;
                  const barHeight = Math.abs(yScale(value) - zeroY);
                  const x = padding.left + slotWidth * index + (slotWidth - barWidth) / 2;
                  const y = value >= 0 ? zeroY - barHeight : zeroY;
                  return (
                    <g key={`${category}-${index}`}>
                      <rect
                        data-testid="spreadsheet-chart-datum"
                        x={x}
                        y={y}
                        width={barWidth}
                        height={Math.max(barHeight, 2)}
                        rx="8"
                        fill={series.color}
                        fillOpacity={hoveredDatum?.key === `${series.name}:${index}:${category}` ? '1' : '0.88'}
                        onMouseMove={(event) =>
                          showHover(event, {
                            key: `${series.name}:${index}:${category}`,
                            category,
                            seriesName: series.name,
                            value,
                            color: series.color,
                          })
                        }
                      />
                      <text
                        x={x + barWidth / 2}
                        y={height - 16}
                        textAnchor="middle"
                        fontSize="11"
                        fill="#7a6a50"
                      >
                        {truncateChartLabel(category)}
                      </text>
                    </g>
                  );
                });
              })()
            : chart.series.map((series) => {
                const slotWidth = plotWidth / Math.max(chart.categories.length - 1, 1);
                let path = '';

                series.values.forEach((value, index) => {
                  if (value === null) return;
                  const x = padding.left + slotWidth * index;
                  const y = yScale(value);
                  path += `${path ? ' L' : 'M'} ${x} ${y}`;
                });

                return (
                  <g key={series.name}>
                    <path
                      d={path}
                      fill="none"
                      stroke={series.color}
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    {series.values.map((value, index) => {
                      if (value === null) return null;
                      const category = chart.categories[index] ?? `Point ${index + 1}`;
                      const x = padding.left + slotWidth * index;
                      const y = yScale(value);
                      return (
                        <circle
                          data-testid="spreadsheet-chart-datum"
                          key={`${series.name}-${index}`}
                          cx={x}
                          cy={y}
                          r={hoveredDatum?.key === `${series.name}:${index}:${category}` ? '6' : '4.5'}
                          fill={series.color}
                          stroke="#fbfaf7"
                          strokeWidth="2"
                          onMouseMove={(event) =>
                            showHover(event, {
                              key: `${series.name}:${index}:${category}`,
                              category,
                              seriesName: series.name,
                              value,
                              color: series.color,
                            })
                          }
                        />
                      );
                    })}
                  </g>
                );
              })}

          {chart.categories.map((category, index) => {
            const slotWidth =
              chart.kind === 'line'
                ? plotWidth / Math.max(chart.categories.length - 1, 1)
                : plotWidth / chart.categories.length;
            const x =
              chart.kind === 'line'
                ? padding.left + slotWidth * index
                : padding.left + slotWidth * index + slotWidth / 2;
            return (
              <text
                key={`${category}-${index}-axis`}
                x={x}
                y={height - 16}
                textAnchor="middle"
                fontSize="11"
                fill="#6b5f49"
              >
                {truncateChartLabel(category)}
              </text>
            );
          })}
        </>
      )}
      </svg>

      {hoveredDatum && (
        <div
          ref={tooltipRef}
          data-testid="spreadsheet-chart-tooltip"
          className="pointer-events-none absolute z-10 rounded-md border border-[#d5ccb9] bg-white/96 px-3 py-2 shadow-lg"
          style={{
            left: hoveredDatum.left,
            top: hoveredDatum.top,
            transform: 'translate(-50%, calc(-100% - 10px))',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full"
              style={{ backgroundColor: hoveredDatum.color }}
            />
            <span className="text-xs font-semibold text-[#221b12]">{hoveredDatum.seriesName}</span>
          </div>
          <div className="mt-1 text-xs text-[#6b5f49]">{hoveredDatum.category}</div>
          <div className="text-sm font-medium text-[#221b12]">{formatChartValue(hoveredDatum.value)}</div>
        </div>
      )}
    </div>
  );
}

function SpreadsheetChartWorkspace({ chart, single }: { chart: SpreadsheetChart; single: boolean }) {
  return (
    <div data-testid="spreadsheet-chart-workspace" className="bg-white rounded-lg shadow-sm border border-gray-200">
      {single && (
        <div className="px-4 py-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {getChartKindLabel(chart.kind)}
            </span>
            <span className="rounded-full bg-[#efe8d6] px-2 py-0.5 text-[11px] font-medium text-[#6a5b41]">
              {chart.sheetName}
            </span>
          </div>
          <h3 className={cn('text-lg font-semibold', PREVIEW_TEXT_CLASS)}>{chart.title || 'Excel Chart'}</h3>
          <p className={cn('text-xs', PREVIEW_MUTED_TEXT_CLASS)}>{describeChartSource(chart)}</p>
        </div>
      )}
      <div className="p-4">
        <div className="relative h-[26rem]">
          <SpreadsheetChartGraphic chart={chart} />
        </div>
      </div>
    </div>
  );
}

function SpreadsheetChartsSurface({
  charts,
  workbookKind,
}: {
  charts: SpreadsheetChart[];
  workbookKind: SpreadsheetWorkbook['kind'];
}) {
  if (charts.length === 0) {
    return (
      <div className={cn('flex h-full min-h-[280px] items-center justify-center px-6 text-center', PREVIEW_PANEL_CLASS)}>
        <div className="max-w-sm space-y-2">
          <p className={cn('text-sm font-medium', PREVIEW_TEXT_CLASS)}>No charts found in this Excel file</p>
          <p className={cn('text-xs', PREVIEW_MUTED_TEXT_CLASS)}>
            {workbookKind === 'excel'
              ? 'This workbook does not expose a clean numeric table yet.'
              : 'Add a header row plus one numeric column to generate chart previews.'}
          </p>
        </div>
      </div>
    );
  }

  const [activeChartIndex, setActiveChartIndex] = useState(0);
  const activeChart = charts[Math.min(activeChartIndex, charts.length - 1)] ?? charts[0];

  useEffect(() => {
    setActiveChartIndex(0);
  }, [charts]);

  if (charts.length === 1 && activeChart) {
    return (
      <div className={cn('min-h-0 min-w-0 flex-1 overflow-auto p-4', PREVIEW_PANEL_CLASS)}>
        <SpreadsheetChartWorkspace chart={activeChart} single />
      </div>
    );
  }

  return (
    <div className={cn('min-h-0 min-w-0 flex-1 overflow-auto', PREVIEW_PANEL_CLASS)}>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="border-b border-gray-300 bg-gray-100 px-2 py-1">
          <div className="overflow-x-auto overflow-y-hidden">
            <div className="flex w-max min-w-full gap-0.5">
              {charts.map((chart, index) => (
                <button
                  key={chart.id}
                  type="button"
                  className={cn(
                    'px-4 py-1.5 text-sm font-medium transition-colors flex-shrink-0 border border-gray-300',
                    index === activeChartIndex
                      ? 'bg-white text-gray-900 relative -mb-[1px] z-10'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-800',
                  )}
                  style={{
                    borderTopLeftRadius: '6px',
                    borderTopRightRadius: '6px',
                    borderBottom: index === activeChartIndex ? '1px solid white' : undefined,
                    minWidth: '100px',
                    maxWidth: '200px',
                  }}
                  onClick={() => setActiveChartIndex(index)}
                  title={chart.title}
                >
                  <div className="truncate">
                    <div>{chart.title || `Chart ${index + 1}`}</div>
                    {chart.sheetName && (
                      <div className="text-xs text-gray-500 font-normal">{chart.sheetName}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4">
          {activeChart ? <SpreadsheetChartWorkspace chart={activeChart} single={false} /> : null}
        </div>
      </div>
    </div>
  );
}

function SpreadsheetCanvasSurface({
  workbook,
  filename,
  layout,
}: {
  workbook: SpreadsheetWorkbook;
  filename: string;
  layout: 'panel' | 'dialog';
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportAnimationFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<{
    width: number;
    height: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [activeSurface, setActiveSurface] = useState<SpreadsheetSurface>('data');
  const [selection, setSelection] = useState<SpreadsheetSelection | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [panState, setPanState] = useState<SpreadsheetPanState>(null);
  const [columnResize, setColumnResize] = useState<ColumnResizeState>(null);
  const [activePointerId, setActivePointerId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [columnWidthsBySheet, setColumnWidthsBySheet] = useState<Record<string, number[]>>(() =>
    Object.fromEntries(workbook.sheets.map((sheet) => [sheet.name, createInitialColumnWidths(sheet)])),
  );
  const [viewport, setViewport] = useState({ width: 0, height: 0, scrollLeft: 0, scrollTop: 0 });
  const [copied, setCopied] = useState(false);

  const activeSheet = workbook.sheets[activeSheetIndex] ?? workbook.sheets[0];
  const columnWidths = columnWidthsBySheet[activeSheet.name] ?? createInitialColumnWidths(activeSheet);
  const rowHeights = activeSheet.rowHeights.length === activeSheet.rowCount
    ? activeSheet.rowHeights
    : Array.from({ length: activeSheet.rowCount }, () => DEFAULT_ROW_HEIGHT);
  const rowOffsets = useMemo(() => {
    const offsets: number[] = [];
    let runningTop = HEADER_ROW_HEIGHT;
    for (let rowIndex = 0; rowIndex < rowHeights.length; rowIndex += 1) {
      offsets[rowIndex] = runningTop;
      runningTop += rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
    }
    return offsets;
  }, [rowHeights]);
  const mergeByAnchor = useMemo(
    () =>
      new Map(activeSheet.merges.map((merge) => [`${merge.startRow}:${merge.startCol}`, merge])),
    [activeSheet.merges],
  );
  const mergeAnchorByCell = useMemo(() => {
    const mapping = new Map<string, { rowIndex: number; columnIndex: number }>();
    for (const merge of activeSheet.merges) {
      for (let rowIndex = merge.startRow; rowIndex <= merge.endRow; rowIndex += 1) {
        for (let columnIndex = merge.startCol; columnIndex <= merge.endCol; columnIndex += 1) {
          mapping.set(`${rowIndex}:${columnIndex}`, {
            rowIndex: merge.startRow,
            columnIndex: merge.startCol,
          });
        }
      }
    }
    return mapping;
  }, [activeSheet.merges]);
  const selectedCell =
    selection ? activeSheet.rows[selection.focusRow]?.[selection.focusCol] ?? null : null;
  const selectedLabel = selection
    ? `${toColumnLabel(selection.focusCol)}${selection.focusRow + 1}`
    : null;
  const selectionFrame = selection
    ? getSelectionFrame(selection, columnWidths, rowOffsets, rowHeights, mergeByAnchor)
    : null;
  const clippedSelectionFrame = selectionFrame
    ? {
        left: Math.max(selectionFrame.left, INDEX_COLUMN_WIDTH),
        top: Math.max(selectionFrame.top, HEADER_ROW_HEIGHT),
        width: Math.max(
          0,
          selectionFrame.width - Math.max(INDEX_COLUMN_WIDTH - selectionFrame.left, 0),
        ),
        height: Math.max(
          0,
          selectionFrame.height - Math.max(HEADER_ROW_HEIGHT - selectionFrame.top, 0),
        ),
      }
    : null;
  const totalWidth = measureSheetWidth(columnWidths);
  const totalHeight = measureSheetHeight(rowHeights);
  const hasCharts = workbook.charts.length > 0;

  useEffect(() => {
    setColumnWidthsBySheet(
      Object.fromEntries(workbook.sheets.map((sheet) => [sheet.name, createInitialColumnWidths(sheet)])),
    );
    setActiveSheetIndex(0);
    setActiveSurface('data');
    setContextMenu(null);
    setSelection(
      workbook.sheets[0] && workbook.sheets[0].rowCount > 0 && workbook.sheets[0].columnCount > 0
        ? { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 }
        : null,
    );
  }, [workbook]);

  useEffect(() => {
    if (!activeSheet || activeSheet.rowCount === 0 || activeSheet.columnCount === 0) {
      setSelection(null);
      return;
    }
    setSelection((current) => {
      if (!current) {
        return { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 };
      }
      return {
        anchorRow: clamp(current.anchorRow, 0, activeSheet.rowCount - 1),
        anchorCol: clamp(current.anchorCol, 0, activeSheet.columnCount - 1),
        focusRow: clamp(current.focusRow, 0, activeSheet.rowCount - 1),
        focusCol: clamp(current.focusCol, 0, activeSheet.columnCount - 1),
      };
    });
  }, [activeSheet]);

  useEffect(() => {
    if (activeSurface !== 'data') return;

    const viewportNode = viewportRef.current;
    if (!viewportNode) return;

    const flushViewport = () => {
      viewportAnimationFrameRef.current = null;
      const nextViewport = pendingViewportRef.current;
      if (!nextViewport) {
        return;
      }

      pendingViewportRef.current = null;
      setViewport((current) =>
        current.width === nextViewport.width &&
        current.height === nextViewport.height &&
        current.scrollLeft === nextViewport.scrollLeft &&
        current.scrollTop === nextViewport.scrollTop
          ? current
          : nextViewport,
      );
    };

    const updateViewport = () => {
      pendingViewportRef.current = {
        width: viewportNode.clientWidth,
        height: viewportNode.clientHeight,
        scrollLeft: viewportNode.scrollLeft,
        scrollTop: viewportNode.scrollTop,
      };

      if (viewportAnimationFrameRef.current !== null) {
        return;
      }

      viewportAnimationFrameRef.current = window.requestAnimationFrame(flushViewport);
    };

    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(viewportNode);
    viewportNode.addEventListener('scroll', updateViewport, { passive: true });
    updateViewport();

    return () => {
      if (viewportAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportAnimationFrameRef.current);
        viewportAnimationFrameRef.current = null;
      }
      pendingViewportRef.current = null;
      resizeObserver.disconnect();
      viewportNode.removeEventListener('scroll', updateViewport);
    };
  }, [activeSurface]);

  useEffect(() => {
    if (!columnResize) return;

    const handlePointerMove = (event: MouseEvent) => {
      setColumnWidthsBySheet((current) => {
        const next = [...(current[activeSheet.name] ?? columnWidths)];
        next[columnResize.columnIndex] = clamp(
          columnResize.startWidth + (event.clientX - columnResize.pointerX),
          MIN_COLUMN_WIDTH,
          420,
        );
        return {
          ...current,
          [activeSheet.name]: next,
        };
      });
    };

    const stopResize = () => setColumnResize(null);

    document.addEventListener('mousemove', handlePointerMove);
    document.addEventListener('mouseup', stopResize);
    return () => {
      document.removeEventListener('mousemove', handlePointerMove);
      document.removeEventListener('mouseup', stopResize);
    };
  }, [activeSheet.name, columnResize, columnWidths]);

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerUp = () => {
      setIsDragging(false);
      setActivePointerId(null);
    };

    document.addEventListener('pointerup', handlePointerUp);
    return () => document.removeEventListener('pointerup', handlePointerUp);
  }, [isDragging]);

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        setIsSpacePressed(false);
      }
    };

    const handleWindowBlur = () => {
      setIsSpacePressed(false);
      setPanState(null);
    };

    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = () => setContextMenu(null);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [contextMenu]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSheet) return;

    const width = Math.max(viewport.width, 1);
    const height = Math.max(viewport.height, 1);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(Math.floor(width * dpr), 1);
    canvas.height = Math.max(Math.floor(height * dpr), 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#fbfaf7';
    context.fillRect(0, 0, width, height);
    context.font = '12px ui-sans-serif, system-ui, sans-serif';
    context.textBaseline = 'middle';

    const visibleLeft = viewport.scrollLeft;
    const visibleTop = viewport.scrollTop;

    const drawText = (text: string, x: number, y: number, maxWidth: number, options?: {
      align?: CanvasTextAlign;
      fillStyle?: string;
      font?: string;
      rectHeight?: number;
    }) => {
      context.save();
      context.fillStyle = options?.fillStyle ?? '#1f2937';
      context.textAlign = options?.align ?? 'left';
      context.font = options?.font ?? '12px ui-sans-serif, system-ui, sans-serif';
      context.beginPath();
      const rectHeight = options?.rectHeight ?? DEFAULT_ROW_HEIGHT;
      context.rect(x, y - rectHeight / 2, maxWidth, rectHeight);
      context.clip();
      const textX =
        options?.align === 'center'
          ? x + maxWidth / 2
          : options?.align === 'right'
            ? x + maxWidth - 8
            : x + 8;
      context.fillText(text, textX, y);
      context.restore();
    };

    const drawRect = (
      x: number,
      y: number,
      rectWidth: number,
      rectHeight: number,
      fillStyle: string,
      strokeStyle = '#d8d3c5',
    ) => {
      context.fillStyle = fillStyle;
      context.fillRect(x, y, rectWidth, rectHeight);
      context.strokeStyle = strokeStyle;
      context.strokeRect(x + 0.5, y + 0.5, rectWidth - 1, rectHeight - 1);
    };

    const firstVisibleRow = Math.max(
      0,
      findRowIndexAtPosition(visibleTop + HEADER_ROW_HEIGHT, rowOffsets, rowHeights),
    );
    const lastVisibleRow = Math.max(
      firstVisibleRow,
      Math.min(
        activeSheet.rowCount - 1,
        findRowIndexAtPosition(visibleTop + height + HEADER_ROW_HEIGHT, rowOffsets, rowHeights),
      ),
    );

    for (let rowIndex = firstVisibleRow; rowIndex <= lastVisibleRow; rowIndex += 1) {
      const drawTop = getRowTop(rowOffsets, rowIndex) - visibleTop;
      const rowHeight = rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
      if (drawTop > height) break;
      const rowBackground = rowIndex % 2 === 0 ? '#ffffff' : '#faf8f3';
      const rowKind = activeSheet.rowKinds[rowIndex] ?? 'body';

      drawRect(
        0,
        drawTop,
        INDEX_COLUMN_WIDTH,
        rowHeight,
        rowKind === 'title' ? '#ddd4bf' : rowKind === 'header' ? '#ede3cf' : '#f5f1e6',
        '#ddd7ca',
      );
      drawText(String(rowIndex + 1), 0, drawTop + rowHeight / 2, INDEX_COLUMN_WIDTH, {
        align: 'center',
        fillStyle: rowKind === 'body' ? '#7a6a50' : '#5b4d35',
        font: '600 11px ui-sans-serif, system-ui, sans-serif',
        rectHeight: rowHeight,
      });

      let cellLeft = INDEX_COLUMN_WIDTH;
      for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
        const columnWidth = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
        const mergeAnchor = mergeAnchorByCell.get(`${rowIndex}:${columnIndex}`);
        if (mergeAnchor && (mergeAnchor.rowIndex !== rowIndex || mergeAnchor.columnIndex !== columnIndex)) {
          cellLeft += columnWidth;
          continue;
        }

        const merge = mergeByAnchor.get(`${rowIndex}:${columnIndex}`);
        let mergedWidth = columnWidth;
        let mergedHeight = rowHeight;
        if (merge) {
          mergedWidth = 0;
          for (let mergedColumnIndex = merge.startCol; mergedColumnIndex <= merge.endCol; mergedColumnIndex += 1) {
            mergedWidth += columnWidths[mergedColumnIndex] ?? MIN_COLUMN_WIDTH;
          }
          mergedHeight = 0;
          for (let mergedRowIndex = merge.startRow; mergedRowIndex <= merge.endRow; mergedRowIndex += 1) {
            mergedHeight += rowHeights[mergedRowIndex] ?? DEFAULT_ROW_HEIGHT;
          }
        }

        const drawLeft = cellLeft - visibleLeft;
        const drawRight = drawLeft + mergedWidth;

        if (drawRight >= INDEX_COLUMN_WIDTH && drawLeft <= width) {
          const cell = activeSheet.rows[rowIndex]?.[columnIndex];
          drawRect(
            drawLeft,
            drawTop,
            mergedWidth,
            mergedHeight,
            cell?.backgroundColor ?? rowBackground,
            '#e3ded1',
          );
          const cellValue = getCellFormula(cell) && !getCellValue(cell)
            ? `=${getCellFormula(cell)}`
            : getCellValue(cell);
          if (cellValue) {
            const isMergedTitle = rowKind === 'title' && Boolean(merge);
            drawText(
              cellValue,
              drawLeft,
              drawTop + mergedHeight / 2,
              mergedWidth,
              {
                align: cell?.textAlign ?? (rowKind === 'header' || isMergedTitle ? 'center' : 'left'),
                fillStyle: cell?.textColor ?? '#111827',
                font:
                  isMergedTitle
                    ? '700 15px ui-sans-serif, system-ui, sans-serif'
                    : rowKind === 'title' || rowKind === 'header'
                      ? '600 12px ui-sans-serif, system-ui, sans-serif'
                      : '12px ui-sans-serif, system-ui, sans-serif',
                rectHeight: mergedHeight,
              },
            );
          }
        }
        cellLeft += columnWidth;
      }
    }

    if (clippedSelectionFrame) {
      const drawLeft = clippedSelectionFrame.left - visibleLeft;
      const drawTop = clippedSelectionFrame.top - visibleTop;
      context.save();
      context.beginPath();
      context.rect(
        INDEX_COLUMN_WIDTH,
        HEADER_ROW_HEIGHT,
        Math.max(width - INDEX_COLUMN_WIDTH, 0),
        Math.max(height - HEADER_ROW_HEIGHT, 0),
      );
      context.clip();
      context.fillStyle = 'rgba(37, 99, 235, 0.10)';
      context.strokeStyle = '#2563eb';
      context.lineWidth = 2;
      context.fillRect(drawLeft, drawTop, clippedSelectionFrame.width, clippedSelectionFrame.height);
      context.strokeRect(
        drawLeft + 1,
        drawTop + 1,
        Math.max(clippedSelectionFrame.width - 2, 0),
        Math.max(clippedSelectionFrame.height - 2, 0),
      );
      context.restore();
    }

    drawRect(0, 0, width, HEADER_ROW_HEIGHT, '#f0ece0', '#d3cabb');
    drawRect(0, 0, INDEX_COLUMN_WIDTH, height, '#f5f1e6', '#d3cabb');
    drawRect(0, 0, INDEX_COLUMN_WIDTH, HEADER_ROW_HEIGHT, '#e9e2d0', '#c9beaa');

    let runningLeft = INDEX_COLUMN_WIDTH;
    for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
      const columnWidth = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      const drawLeft = runningLeft - visibleLeft;
      const drawRight = drawLeft + columnWidth;

      if (drawRight >= INDEX_COLUMN_WIDTH && drawLeft <= width) {
        drawRect(drawLeft, 0, columnWidth, HEADER_ROW_HEIGHT, '#f0ece0', '#d3cabb');
        drawText(
          toColumnLabel(columnIndex),
          drawLeft,
          HEADER_ROW_HEIGHT / 2,
          columnWidth,
          { align: 'center', fillStyle: '#6b5f49', font: '600 11px ui-sans-serif, system-ui, sans-serif' },
        );
      }
      runningLeft += columnWidth;
    }

    for (let rowIndex = firstVisibleRow; rowIndex <= lastVisibleRow; rowIndex += 1) {
      const drawTop = getRowTop(rowOffsets, rowIndex) - visibleTop;
      const rowHeight = rowHeights[rowIndex] ?? DEFAULT_ROW_HEIGHT;
      if (drawTop > height) break;
      const rowKind = activeSheet.rowKinds[rowIndex] ?? 'body';
      drawRect(
        0,
        drawTop,
        INDEX_COLUMN_WIDTH,
        rowHeight,
        rowKind === 'title' ? '#ddd4bf' : rowKind === 'header' ? '#ede3cf' : '#f5f1e6',
        '#ddd7ca',
      );
      drawText(String(rowIndex + 1), 0, drawTop + rowHeight / 2, INDEX_COLUMN_WIDTH, {
        align: 'center',
        fillStyle: rowKind === 'body' ? '#7a6a50' : '#5b4d35',
        font: '600 11px ui-sans-serif, system-ui, sans-serif',
        rectHeight: rowHeight,
      });
    }
  }, [activeSheet, clippedSelectionFrame, columnWidths, mergeAnchorByCell, mergeByAnchor, rowHeights, rowOffsets, viewport]);

  const focusCell = (rowIndex: number, columnIndex: number, extendSelection: boolean) => {
    if (!activeSheet || activeSheet.rowCount === 0 || activeSheet.columnCount === 0) {
      return;
    }

    const nextRow = clamp(rowIndex, 0, activeSheet.rowCount - 1);
    const nextCol = clamp(columnIndex, 0, activeSheet.columnCount - 1);
    setSelection((current) => {
      if (!current || !extendSelection) {
        return {
          anchorRow: nextRow,
          anchorCol: nextCol,
          focusRow: nextRow,
          focusCol: nextCol,
        };
      }
      return {
        ...current,
        focusRow: nextRow,
        focusCol: nextCol,
      };
    });
  };

  const ensureCellVisible = (rowIndex: number, columnIndex: number) => {
    const viewportNode = viewportRef.current;
    if (!viewportNode) return;

    const cellLeft = getColumnLeft(columnWidths, columnIndex);
    const merge = mergeByAnchor.get(`${rowIndex}:${columnIndex}`);
    let cellRight = cellLeft;
    for (let mergeColumnIndex = merge?.startCol ?? columnIndex; mergeColumnIndex <= (merge?.endCol ?? columnIndex); mergeColumnIndex += 1) {
      cellRight += columnWidths[mergeColumnIndex] ?? MIN_COLUMN_WIDTH;
    }
    const cellTop = getRowTop(rowOffsets, merge?.startRow ?? rowIndex);
    let cellBottom = cellTop;
    for (let mergeRowIndex = merge?.startRow ?? rowIndex; mergeRowIndex <= (merge?.endRow ?? rowIndex); mergeRowIndex += 1) {
      cellBottom += rowHeights[mergeRowIndex] ?? DEFAULT_ROW_HEIGHT;
    }

    if (cellLeft < viewportNode.scrollLeft) {
      viewportNode.scrollLeft = Math.max(0, cellLeft - 20);
    } else if (cellRight > viewportNode.scrollLeft + viewportNode.clientWidth) {
      viewportNode.scrollLeft = Math.max(0, cellRight - viewportNode.clientWidth + 20);
    }

    if (cellTop < viewportNode.scrollTop) {
      viewportNode.scrollTop = Math.max(0, cellTop - 20);
    } else if (cellBottom > viewportNode.scrollTop + viewportNode.clientHeight) {
      viewportNode.scrollTop = Math.max(0, cellBottom - viewportNode.clientHeight + 20);
    }
  };

  const copySelection = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(buildClipboardText(activeSheet, selection));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const getGridCoordinates = (
    event:
      | React.MouseEvent<HTMLDivElement>
      | React.PointerEvent<HTMLDivElement>
      | MouseEvent
      | PointerEvent,
  ) => {
    const viewportNode = viewportRef.current;
    if (!viewportNode) return null;
    const rect = viewportNode.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return { x, y };
  };

  const getHitTarget = (x: number, y: number) => {
    if (x < INDEX_COLUMN_WIDTH && y < HEADER_ROW_HEIGHT) {
      return { kind: 'all' } as const;
    }
    if (y < HEADER_ROW_HEIGHT) {
      let runningLeft = INDEX_COLUMN_WIDTH;
      for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
        const width = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
        if (x >= runningLeft && x <= runningLeft + width) {
          return { kind: 'column', columnIndex } as const;
        }
        runningLeft += width;
      }
      return null;
    }
    if (x < INDEX_COLUMN_WIDTH) {
      const rowIndex = findRowIndexAtPosition(y, rowOffsets, rowHeights);
      return rowIndex >= 0 && rowIndex < activeSheet.rowCount
        ? ({ kind: 'row', rowIndex } as const)
        : null;
    }

    const rowIndex = findRowIndexAtPosition(y, rowOffsets, rowHeights);
    if (rowIndex < 0 || rowIndex >= activeSheet.rowCount) return null;

    let runningLeft = INDEX_COLUMN_WIDTH;
    for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
      const width = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      if (x >= runningLeft && x <= runningLeft + width) {
        const mergeAnchor = mergeAnchorByCell.get(`${rowIndex}:${columnIndex}`);
        return {
          kind: 'cell',
          rowIndex: mergeAnchor?.rowIndex ?? rowIndex,
          columnIndex: mergeAnchor?.columnIndex ?? columnIndex,
        } as const;
      }
      runningLeft += width;
    }
    return null;
  };

  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (columnResize) return;
    const viewportNode = viewportRef.current;
    const shouldPan = event.button === 1 || (event.button === 0 && isSpacePressed);
    if (shouldPan) {
      event.preventDefault();
      setContextMenu(null);
      viewportRef.current?.focus();
      viewportRef.current?.setPointerCapture(event.pointerId);
      setActivePointerId(event.pointerId);
      setPanState({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: viewportNode?.scrollLeft ?? 0,
        startScrollTop: viewportNode?.scrollTop ?? 0,
      });
      return;
    }
    if (event.button !== 0) return;
    setContextMenu(null);
    const coordinates = getGridCoordinates(event);
    if (!coordinates) return;

    const target = getHitTarget(coordinates.x, coordinates.y);
    if (!target) return;

    viewportRef.current?.focus();
    viewportRef.current?.setPointerCapture(event.pointerId);
    setIsDragging(true);
    setActivePointerId(event.pointerId);

    if (target.kind === 'all') {
      if (activeSheet.rowCount > 0 && activeSheet.columnCount > 0) {
        setSelection({
          anchorRow: 0,
          anchorCol: 0,
          focusRow: activeSheet.rowCount - 1,
          focusCol: activeSheet.columnCount - 1,
        });
      }
      return;
    }

    if (target.kind === 'row') {
      setSelection({
        anchorRow: target.rowIndex,
        anchorCol: 0,
        focusRow: target.rowIndex,
        focusCol: Math.max(activeSheet.columnCount - 1, 0),
      });
      return;
    }

    if (target.kind === 'column') {
      setSelection({
        anchorRow: 0,
        anchorCol: target.columnIndex,
        focusRow: Math.max(activeSheet.rowCount - 1, 0),
        focusCol: target.columnIndex,
      });
      return;
    }

    setSelection((current) => {
      if (event.shiftKey && current) {
        return {
          ...current,
          focusRow: target.rowIndex,
          focusCol: target.columnIndex,
        };
      }
      return {
        anchorRow: target.rowIndex,
        anchorCol: target.columnIndex,
        focusRow: target.rowIndex,
        focusCol: target.columnIndex,
      };
    });
  };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panState) {
      if (event.pointerId !== panState.pointerId) return;
      const viewportNode = viewportRef.current;
      if (!viewportNode) return;
      viewportNode.scrollLeft = Math.max(
        0,
        panState.startScrollLeft - (event.clientX - panState.startClientX),
      );
      viewportNode.scrollTop = Math.max(
        0,
        panState.startScrollTop - (event.clientY - panState.startClientY),
      );
      return;
    }
    if (!isDragging || !selection || columnResize) return;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const coordinates = getGridCoordinates(event);
    if (!coordinates) return;
    const target = getHitTarget(coordinates.x, coordinates.y);
    if (!target || target.kind !== 'cell') return;
    setSelection((current) =>
      current
        ? {
            ...current,
            focusRow: target.rowIndex,
            focusCol: target.columnIndex,
          }
        : current,
    );
  };

  const handleOverlayPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panState?.pointerId === event.pointerId) {
      viewportRef.current?.releasePointerCapture(event.pointerId);
      setActivePointerId(null);
      setPanState(null);
      return;
    }
    if (activePointerId === event.pointerId) {
      viewportRef.current?.releasePointerCapture(event.pointerId);
      setActivePointerId(null);
    }
    setIsDragging(false);
  };

  const handleOverlayContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!selection) return;
    const viewportNode = viewportRef.current;
    if (!viewportNode) return;
    const rect = viewportNode.getBoundingClientRect();
    viewportRef.current?.focus();
    setContextMenu({
      left: clamp(event.clientX - rect.left, 12, Math.max(12, viewport.width - 124)),
      top: clamp(event.clientY - rect.top, 12, Math.max(12, viewport.height - 44)),
    });
  };

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && contextMenu) {
      event.preventDefault();
      setContextMenu(null);
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      setIsSpacePressed(true);
      return;
    }

    if (!selection) return;

    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      await copySelection();
      return;
    }

    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (activeSheet.rowCount > 0 && activeSheet.columnCount > 0) {
        setSelection({
          anchorRow: 0,
          anchorCol: 0,
          focusRow: activeSheet.rowCount - 1,
          focusCol: activeSheet.columnCount - 1,
        });
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSelection((current) =>
        current
          ? {
              anchorRow: current.focusRow,
              anchorCol: current.focusCol,
              focusRow: current.focusRow,
              focusCol: current.focusCol,
            }
          : current,
      );
      return;
    }

    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    let nextRow = selection.focusRow;
    let nextCol = selection.focusCol;

    switch (event.key) {
      case 'ArrowUp':
        nextRow = meta ? 0 : selection.focusRow - 1;
        break;
      case 'ArrowDown':
        nextRow = meta ? activeSheet.rowCount - 1 : selection.focusRow + 1;
        break;
      case 'ArrowLeft':
        nextCol = meta ? 0 : selection.focusCol - 1;
        break;
      case 'ArrowRight':
        nextCol = meta ? activeSheet.columnCount - 1 : selection.focusCol + 1;
        break;
      default:
        break;
    }

    focusCell(nextRow, nextCol, event.shiftKey);
    ensureCellVisible(nextRow, nextCol);
  };

  const visibleResizeHandles = useMemo(() => {
    const handles: Array<{ columnIndex: number; left: number }> = [];
    let runningLeft = INDEX_COLUMN_WIDTH;
    for (let columnIndex = 0; columnIndex < activeSheet.columnCount; columnIndex += 1) {
      const width = columnWidths[columnIndex] ?? MIN_COLUMN_WIDTH;
      const left = runningLeft + width - 3;
      const viewportLeft = left - viewport.scrollLeft;
      if (viewportLeft >= INDEX_COLUMN_WIDTH - 8 && viewportLeft <= viewport.width + 8) {
        handles.push({ columnIndex, left });
      }
      runningLeft += width;
    }
    return handles;
  }, [activeSheet.columnCount, columnWidths, viewport.scrollLeft, viewport.width]);

  const surface = (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70', PREVIEW_SHELL_CLASS)}>
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
        <div className="min-w-0">
          <p className={cn('truncate text-sm font-medium', PREVIEW_TEXT_CLASS)}>{filename}</p>
          <p className={cn('truncate text-xs', PREVIEW_MUTED_TEXT_CLASS)}>
            {activeSurface === 'charts'
              ? 'Workbook charts'
              : workbook.kind === 'excel'
                ? 'Workbook preview'
                : 'Delimited preview'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {activeSurface === 'data' && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy selection"
              onClick={() => void copySelection()}
            >
              <Copy className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {hasCharts && (
        <div className="border-b border-border/70 bg-white/70 px-3 py-2">
          <div role="tablist" aria-label="Spreadsheet views" className="inline-flex rounded-lg border border-border/70 bg-[#ebe5d8] p-1">
            {(['data', 'charts'] as const).map((surface) => (
              <button
                key={surface}
                type="button"
                role="tab"
                aria-label={surface === 'data' ? 'Data' : 'Charts'}
                aria-selected={activeSurface === surface}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeSurface === surface
                    ? `bg-white shadow-sm ${PREVIEW_TEXT_CLASS}`
                    : `hover:text-[#221b12] ${PREVIEW_MUTED_TEXT_CLASS}`,
                )}
                onClick={() => setActiveSurface(surface)}
              >
                <span>{surface === 'data' ? 'Data' : 'Charts'}</span>
                {surface === 'charts' && (
                  <span
                    className={cn(
                      'ml-2 rounded-full px-2 py-0.5 text-[11px]',
                      activeSurface === surface
                        ? 'bg-blue-100 text-blue-600'
                        : 'bg-[#ddd4bf] text-[#6b5f49]',
                    )}
                  >
                    {workbook.charts.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeSurface === 'data' ? (
        <>
          <div className="flex items-center gap-3 border-b border-border/70 bg-white/70 px-3 py-2">
            <div className={cn('shrink-0 rounded-md border border-border/70 px-2 py-1 text-xs font-medium', PREVIEW_CHIP_CLASS, PREVIEW_MUTED_TEXT_CLASS)}>
              {selectedLabel ?? 'Cell'}
            </div>
            <div className={cn('shrink-0 text-xs font-medium uppercase tracking-[0.18em]', PREVIEW_MUTED_TEXT_CLASS)}>
              fx
            </div>
            <div
              data-testid="spreadsheet-formula-bar"
              className={cn('min-w-0 flex-1 rounded-md border border-border/70 px-3 py-2 font-mono text-xs shadow-sm', PREVIEW_INPUT_CLASS, PREVIEW_TEXT_CLASS)}
            >
              {selectedCell
                ? getCellFormula(selectedCell)
                  ? `=${getCellFormula(selectedCell)}`
                  : getCellValue(selectedCell) || <span className={PREVIEW_MUTED_TEXT_CLASS}>Empty cell</span>
                : <span className={PREVIEW_MUTED_TEXT_CLASS}>Select a cell to inspect its content</span>}
            </div>
            {copied && <span className={cn('text-xs', PREVIEW_MUTED_TEXT_CLASS)}>Copied</span>}
          </div>

          <div className={cn('relative min-h-0 flex-1 overflow-hidden', PREVIEW_PANEL_CLASS)}>
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-0" />
            <div
              ref={viewportRef}
              role="grid"
              aria-label="Spreadsheet grid"
              aria-rowcount={activeSheet.rowCount}
              aria-colcount={activeSheet.columnCount}
              data-testid="spreadsheet-viewport"
              className={cn(
                'relative z-10 h-full w-full overflow-auto outline-none',
                panState ? 'cursor-grabbing' : isSpacePressed ? 'cursor-grab' : undefined,
                layout === 'dialog' && 'max-h-[70vh]',
              )}
              tabIndex={0}
              onPointerDown={handleOverlayPointerDown}
              onPointerMove={handleOverlayPointerMove}
              onPointerUp={handleOverlayPointerUp}
              onPointerCancel={() => {
                setIsDragging(false);
                setActivePointerId(null);
                setPanState(null);
              }}
              onContextMenu={handleOverlayContextMenu}
              onKeyDown={(event) => void handleKeyDown(event)}
            >
              <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
                <div
                  data-testid="spreadsheet-grid"
                  className={cn(
                    'pointer-events-none absolute inset-0',
                    panState ? 'cursor-grabbing' : isSpacePressed ? 'cursor-grab' : undefined,
                  )}
                />

                {visibleResizeHandles.map((handle) => (
                  <button
                    key={handle.columnIndex}
                    type="button"
                    aria-label={`Resize column ${toColumnLabel(handle.columnIndex)}`}
                    className="absolute top-0 z-10 h-[34px] w-2 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-blue-500/20"
                    style={{ left: handle.left }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setColumnResize({
                        columnIndex: handle.columnIndex,
                        pointerX: event.clientX,
                        startWidth: columnWidths[handle.columnIndex] ?? MIN_COLUMN_WIDTH,
                      });
                    }}
                  />
                ))}
              </div>
            </div>

            {contextMenu && (
              <div
                className="absolute z-20 min-w-28 rounded-md border border-border/70 bg-white p-1 shadow-lg"
                style={{ left: contextMenu.left, top: contextMenu.top }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs text-[#221b12] hover:bg-[#f0ece2]"
                  onClick={() => {
                    setContextMenu(null);
                    void copySelection();
                  }}
                >
                  Copy
                </button>
              </div>
            )}
          </div>

          {activeSheet.wasTrimmed && (
            <div className={cn('border-t border-border/70 px-3 py-2 text-xs', PREVIEW_MUTED_TEXT_CLASS)}>
              Showing the first {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns of this sheet.
            </div>
          )}

          {workbook.sheets.length > 1 && (
            <div className={cn('border-t border-border/70 px-2 py-1', PREVIEW_SUBTLE_PANEL_CLASS)}>
              <div className="flex gap-1 overflow-x-auto">
                {workbook.sheets.map((sheet, index) => (
                  <button
                    key={sheet.name}
                    type="button"
                    className={cn(
                      'max-w-[180px] shrink-0 truncate rounded-t-md border px-3 py-1.5 text-xs font-medium transition-colors',
                      index === activeSheetIndex
                        ? 'border-border/70 border-b-[#fbfaf7] bg-[#fbfaf7] text-[#221b12]'
                        : 'border-transparent bg-transparent text-[#6b5f49] hover:bg-white/60 hover:text-[#221b12]',
                    )}
                    onClick={() => {
                      setActiveSheetIndex(index);
                      setCopied(false);
                      setContextMenu(null);
                    }}
                    title={sheet.name}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <SpreadsheetChartsSurface charts={workbook.charts} workbookKind={workbook.kind} />
      )}
    </div>
  );

  return surface;
}

export function SpreadsheetPreview({ content, filename, contentType, layout }: SpreadsheetPreviewProps) {
  const workbook = useMemo(
    () => parseSpreadsheetWorkbook(content, filename, contentType),
    [content, filename, contentType],
  );

  if (!workbook) {
    return (
      <pre
        className={cn(
          `w-full min-w-0 overflow-auto p-4 text-xs ${PREVIEW_TEXT_CLASS}`,
          layout === 'dialog' && 'max-h-[60vh]',
        )}
      >
        {typeof content === 'string' ? content || 'No preview content available.' : 'Unable to parse this spreadsheet.'}
      </pre>
    );
  }

  return <SpreadsheetCanvasSurface workbook={workbook} filename={filename} layout={layout} />;
}
