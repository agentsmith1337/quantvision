// Persistence for chart drawings.
//
// The chart positions drawings by bar index, which shifts whenever history is
// reloaded. They're stored by timestamp instead and mapped back onto the
// current bars. Prices (y values) are stored as-is.

import type { Bar, DrawingKind, Drawings, XY } from "./financial-chart";

type WithSeq<T> = T & { seq: number };
export type StoredDrawings = { [K in DrawingKind]: WithSeq<Drawings[K][number]>[] };

export const EMPTY_DRAWINGS: StoredDrawings = { trends: [], fibs: [], channels: [], stddevs: [], fans: [], texts: [], levels: [] };

export function loadDrawings(key: string): StoredDrawings {
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(key);
    if (raw) return { ...EMPTY_DRAWINGS, ...JSON.parse(raw) };
  } catch {}
  return EMPTY_DRAWINGS;
}

export function saveDrawings(key: string, drawings: StoredDrawings): void {
  try {
    localStorage.setItem(key, JSON.stringify(drawings));
  } catch {}
}

export function drawingCount(d: StoredDrawings): number {
  return Object.values(d).reduce((n, list) => n + list.length, 0);
}

let seqCounter = Date.now();
const nextSeq = () => seqCounter++;

function indexToTime(x: number, bars: Bar[], step: number): number {
  const i = Math.min(Math.max(Math.round(x), 0), bars.length - 1);
  return bars[i].date.getTime() + (x - i) * step * 1000;
}

function timeToIndex(t: number, bars: Bar[], step: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].date.getTime() <= t) lo = mid;
    else hi = mid - 1;
  }
  const offset = (t - bars[lo].date.getTime()) / (step * 1000);
  // Inside the series, snap within the bar; beyond either end, extrapolate.
  return lo === bars.length - 1 || offset < 0 ? lo + offset : lo + Math.min(offset, 0.999);
}

type Mapper = (x: number) => number;
const mapXY = (p: XY, f: Mapper): XY => [f(p[0]), p[1]];

// Apply `f` to every x coordinate of a drawing of the given kind.
function mapX<K extends DrawingKind>(kind: K, d: Drawings[K][number], f: Mapper): Drawings[K][number] {
  switch (kind) {
    case "trends":
    case "stddevs": {
      const t = d as Drawings["trends"][number];
      return { ...t, start: mapXY(t.start, f), end: mapXY(t.end, f) } as Drawings[K][number];
    }
    case "fibs": {
      const t = d as Drawings["fibs"][number];
      return { ...t, x1: f(t.x1), x2: f(t.x2) } as Drawings[K][number];
    }
    case "channels":
    case "fans": {
      const t = d as Drawings["channels"][number];
      return { ...t, startXY: mapXY(t.startXY, f), endXY: mapXY(t.endXY, f) } as Drawings[K][number];
    }
    case "texts": {
      const t = d as Drawings["texts"][number];
      return { ...t, position: mapXY(t.position, f) } as Drawings[K][number];
    }
    default:
      return d; // levels have no x
  }
}

/** Stored (time-based) drawings -> chart (index-based) drawings for the current bars. */
export function toIndexed(stored: StoredDrawings, bars: Bar[], step: number): Drawings {
  const f = (t: number) => timeToIndex(t, bars, step);
  const out = {} as Drawings;
  for (const kind of Object.keys(EMPTY_DRAWINGS) as DrawingKind[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)[kind] = bars.length ? stored[kind].map((d) => mapX(kind, d, f)) : [];
  }
  return out;
}

/** Chart (index-based) drawings of one kind -> stored form, keeping each item's sequence number. */
export function toStored<K extends DrawingKind>(kind: K, items: Drawings[K], bars: Bar[], step: number): StoredDrawings[K] {
  const f = (x: number) => indexToTime(x, bars, step);
  return items.map((d) => {
    // Drop library display state (selection, appearance) before saving.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    const { selected, appearance, ...rest } = d as any;
    const mapped = mapX(kind, rest, f) as WithSeq<Drawings[K][number]>;
    return { ...mapped, seq: rest.seq ?? nextSeq() };
  }) as StoredDrawings[K];
}

export function withAdded<K extends DrawingKind>(stored: StoredDrawings, kind: K, item: Drawings[K][number]): StoredDrawings {
  return { ...stored, [kind]: [...stored[kind], { ...item, seq: nextSeq() }] };
}

/** Remove the most recently created drawing, whatever its kind. */
export function undoLast(stored: StoredDrawings): StoredDrawings {
  let latest: { kind: DrawingKind; seq: number } | null = null;
  for (const kind of Object.keys(stored) as DrawingKind[]) {
    for (const d of stored[kind]) {
      if (!latest || d.seq > latest.seq) latest = { kind, seq: d.seq };
    }
  }
  if (!latest) return stored;
  const { kind, seq } = latest;
  return { ...stored, [kind]: stored[kind].filter((d) => d.seq !== seq) };
}
