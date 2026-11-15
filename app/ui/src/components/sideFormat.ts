// The item sidebars' number formats (components/sidePills.tsx): Steam's counts and a size, one look on both tabs.
export const fmtCount = (n: number | null | undefined) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtSize = (b: number | null | undefined) => {
  if (b == null) return null;
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
};
