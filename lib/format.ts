export const pct = (v: number, sign = true) =>
  `${sign && v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

export function usd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

export function price(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.0001) return v.toFixed(5);
  return v.toExponential(2);
}
