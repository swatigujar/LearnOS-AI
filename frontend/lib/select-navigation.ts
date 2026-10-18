export function nextSelectIndex(current: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End", length: number) {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const direction = key === "ArrowDown" ? 1 : -1;
  return (current + direction + length) % length;
}

export function placeSelectMenu(
  rect: { left: number; width: number; top: number; bottom: number },
  viewport: { width: number; height: number },
) {
  const gap = 6;
  const maxHeight = 240;
  const below = viewport.height - rect.bottom - gap;
  const above = rect.top - gap;
  const opensAbove = below < Math.min(maxHeight, 176) && above > below;
  return {
    left: Math.max(8, Math.min(rect.left, viewport.width - rect.width - 8)),
    width: Math.min(rect.width, viewport.width - 16),
    maxHeight: Math.max(96, Math.min(maxHeight, opensAbove ? above : below)),
    ...(opensAbove ? { bottom: viewport.height - rect.top + gap } : { top: rect.bottom + gap }),
  };
}
