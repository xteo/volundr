import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 430;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

/**
 * Returns true when the viewport width is at or below the mobile breakpoint (430px).
 * Uses matchMedia for reliable, CSS-consistent detection.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
