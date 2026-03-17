import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './useIsMobile';

/**
 * Helper to mock window.matchMedia with controllable matches state.
 * Returns an object with a `trigger` method to simulate media query changes.
 */
function mockMatchMedia(initialMatches: boolean) {
  let changeHandler: ((e: MediaQueryListEvent) => void) | null = null;

  const mql = {
    matches: initialMatches,
    media: '(max-width: 430px)',
    addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
      if (event === 'change') changeHandler = handler;
    }),
    removeEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
      if (event === 'change' && changeHandler === handler) changeHandler = null;
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  };

  const matchMediaMock = vi.fn().mockReturnValue(mql);
  Object.defineProperty(window, 'matchMedia', {
    value: matchMediaMock,
    writable: true,
    configurable: true,
  });

  return {
    mql,
    matchMediaMock,
    /** Simulate the media query changing (e.g. viewport resize). */
    trigger(matches: boolean) {
      mql.matches = matches;
      if (changeHandler) {
        changeHandler({ matches } as MediaQueryListEvent);
      }
    },
  };
}

describe('useIsMobile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when viewport is at or below 430px', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('returns false when viewport is above 430px', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('queries the correct media string', () => {
    const { matchMediaMock } = mockMatchMedia(false);
    renderHook(() => useIsMobile());
    expect(matchMediaMock).toHaveBeenCalledWith('(max-width: 430px)');
  });

  it('updates when the media query changes from desktop to mobile', () => {
    const mock = mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      mock.trigger(true);
    });

    expect(result.current).toBe(true);
  });

  it('updates when the media query changes from mobile to desktop', () => {
    const mock = mockMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);

    act(() => {
      mock.trigger(false);
    });

    expect(result.current).toBe(false);
  });

  it('registers and cleans up the change listener', () => {
    const mock = mockMatchMedia(false);
    const { unmount } = renderHook(() => useIsMobile());

    expect(mock.mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    unmount();

    expect(mock.mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
