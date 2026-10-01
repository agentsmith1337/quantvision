"use client";

import { useCallback, useState } from "react";

/** Callback ref + the element's current content size, tracked with ResizeObserver. */
export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = useCallback((el: T | null) => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === Math.floor(width) && s.height === Math.floor(height) ? s : { width: Math.floor(width), height: Math.floor(height) }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
