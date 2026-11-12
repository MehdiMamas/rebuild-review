// --widths narrow,wide: the two screen widths the overflow and accessibility checks use.
export const DEFAULT_WIDTHS = [390, 1440];

export function parseWidths(text) {
  if (text === undefined) return [...DEFAULT_WIDTHS];
  const parts = String(text).split(',').map((p) => p.trim());
  if (parts.length !== 2 || !parts.every((p) => /^[1-9]\d*$/.test(p))) {
    throw new Error(`--widths needs two positive whole numbers, narrow first, like 390,1440 (got "${text}")`);
  }
  const w = parts.map(Number);
  if (w[0] >= w[1]) throw new Error(`--widths needs the narrow width first and smaller than the wide one (got "${text}")`);
  return w;
}
