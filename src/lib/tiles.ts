import { useLayoutEffect, useState } from "react";

// Largest 16:9 tile size that fits every call card in the grid at once. Below
// the minimum the grid scrolls instead (and every card stays reachable).
export const MIN_TILE_WIDTH = 200;

export const TILE_GAP = 8;

export function bestTileWidth(width: number, height: number, count: number) {
  let best = 0;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const byWidth = (width - TILE_GAP * (columns - 1)) / columns;
    const byHeight = ((height - TILE_GAP * (rows - 1)) / rows) * 16 / 9;
    best = Math.max(best, Math.min(byWidth, byHeight));
  }
  return Math.floor(Math.min(Math.max(MIN_TILE_WIDTH, best), width));
}

export function useFittedTileWidth(element: HTMLDivElement | null, count: number, enabled: boolean) {
  const [tileWidth, setTileWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !element || count < 1) {
      setTileWidth(null);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (width > 0 && height > 0) setTileWidth(bestTileWidth(width, height, count));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, count, enabled]);
  return tileWidth;
}
