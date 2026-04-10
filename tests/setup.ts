import '@testing-library/jest-dom';
import * as React from 'react';
import { vi } from 'vitest';

vi.mock('react-resizable-panels', () => ({
  Group: ({
    children,
    className,
    orientation,
    defaultLayout: _defaultLayout,
    onLayoutChange: _onLayoutChange,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical' }) =>
    React.createElement(
      'div',
      {
        ...props,
        className,
        'data-panel-group': orientation ?? 'horizontal',
      },
      children,
    ),
  Panel: ({
    children,
    className,
    defaultSize: _defaultSize,
    minSize: _minSize,
    maxSize: _maxSize,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    defaultSize?: number | string;
    minSize?: number | string;
    maxSize?: number | string;
  }) =>
    React.createElement('div', { ...props, className, 'data-panel': true }, children),
  Separator: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement('div', { ...props, className, 'data-panel-separator': true }, children),
}));

// Mock window.matchMedia for responsive components
if ('window' in globalThis) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

if ('HTMLCanvasElement' in globalThis) {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    writable: true,
    value: vi.fn(() => ({
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      rect: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
      strokeRect: vi.fn(),
      fillStyle: '',
      font: '',
      lineWidth: 1,
      strokeStyle: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    })),
  });
}

if ('HTMLElement' in globalThis) {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    writable: true,
    value: vi.fn(),
  });

  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    writable: true,
    value: vi.fn(),
  });
}

if ('navigator' in globalThis && !navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    writable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}
