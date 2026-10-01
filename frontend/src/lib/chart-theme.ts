// Canvas colours for the chart, one palette per app theme. Keep in step with the
// CSS tokens in app/globals.css (canvas drawing can't read CSS variables directly).
export type ChartPalette = {
  bg: string;
  fg: string;
  muted: string;
  grid: string;
  border: string;
  accent: string;
  up: string;
  down: string;
  overlays: string[]; // indicator line colours
};

const PALETTES: Record<string, ChartPalette> = {
  day: {
    bg: "#ffffff", fg: "#111827", muted: "#5b6474", grid: "#eef1f5", border: "#dde2ea",
    accent: "#1d6ff2", up: "#0f9d58", down: "#d93025",
    overlays: ["#f59e0b", "#8b5cf6", "#0ea5e9", "#ec4899"],
  },
  evening: {
    bg: "#332c27", fg: "#eadfce", muted: "#b3a690", grid: "#3d3530", border: "#4a413a",
    accent: "#e0a458", up: "#8fbf7f", down: "#e07a5f",
    overlays: ["#f2cc8f", "#c9a0dc", "#81b29a", "#f4a261"],
  },
  dark: {
    bg: "#13161b", fg: "#e6e8eb", muted: "#8b93a1", grid: "#1b1f26", border: "#262b33",
    accent: "#4c8dff", up: "#26a69a", down: "#ef5350",
    overlays: ["#f6c344", "#b388ff", "#4dd0e1", "#ff8a65"],
  },
};

export function chartPalette(theme: string | undefined): ChartPalette {
  return PALETTES[theme ?? "dark"] ?? PALETTES.dark;
}

/** Hex colour with an alpha channel, e.g. withAlpha("#26a69a", 0.4). */
export function withAlpha(hex: string, alpha: number): string {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, "0");
}
