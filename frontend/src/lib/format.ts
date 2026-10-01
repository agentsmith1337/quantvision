const price = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatPrice(value: number | null | undefined): string {
  return value == null ? "—" : price.format(value);
}

export function formatChange(change?: number, pct?: number): string {
  if (change == null || pct == null) return "—";
  const sign = change > 0 ? "+" : "";
  return `${sign}${price.format(change)} (${sign}${pct.toFixed(2)}%)`;
}

export function changeColor(change?: number): string {
  if (!change) return "text-muted";
  return change > 0 ? "text-up" : "text-down";
}
