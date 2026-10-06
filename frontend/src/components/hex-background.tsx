"use client";

import { useEffect, useRef } from "react";

// A dark-green hexagonal lattice behind every page, the same in every theme. It's only visible
// near the cursor (fading out over a 100em radius), and the hexagon under the cursor turns navy:
// 200 ms ease-out on the way in, 400 ms ease-in back to a transparent fill and green edges.

const DIAMETER_EM = 4; // corner to corner
const RADIUS_EM = 30; // how far from the cursor the lattice is lit
const FOCUS_MS = 100;
const BLUR_MS = 150;
const GREEN: [number, number, number] = [16, 92, 56];
const NAVY: [number, number, number] = [16, 100, 56];
const EDGE_ALPHA = 0.3; // at the cursor; fades to 0 at RADIUS_EM
const FILL_ALPHA = 0.2; // of the focused hexagon
const LINE_WIDTH = 1.0;
const SQRT3 = Math.sqrt(3);

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t ** 3;

type Anim = { from: number; to: number; start: number; duration: number; ease: (t: number) => number };

/** Flat-topped hexagons in axial coordinates (q, r); `size` is the corner radius in px. */
function hexAt(x: number, y: number, size: number): [number, number] {
  const q = ((2 / 3) * x) / size;
  const r = ((-1 / 3) * x + (SQRT3 / 3) * y) / size;
  // Round in cube coordinates so the nearest hexagon wins.
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

const centre = (q: number, r: number, size: number): [number, number] => [size * 1.5 * q, size * SQRT3 * (r + q / 2)];

export function HexBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let em = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    let size = (DIAMETER_EM * em) / 2;
    let radius = RADIUS_EM * em;
    let width = 0;
    let height = 0;
    let pointer: { x: number; y: number } | null = null;
    let focused: string | null = null;
    let frame = 0;
    const anims = new Map<string, Anim>(); // navy amount per hexagon, 0..1

    const value = (key: string, now: number) => {
      const a = anims.get(key);
      if (!a) return 0;
      const t = a.duration ? Math.min(1, (now - a.start) / a.duration) : 1;
      return a.from + (a.to - a.from) * a.ease(t);
    };

    const animate = (key: string, to: number, now: number) => {
      const from = value(key, now);
      const instant = reduceMotion.matches;
      anims.set(key, to
        ? { from, to, start: now, duration: instant ? 0 : FOCUS_MS, ease: easeOut }
        : { from, to, start: now, duration: instant ? 0 : BLUR_MS, ease: easeIn });
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      em = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      size = (DIAMETER_EM * em) / 2;
      radius = RADIUS_EM * em;
      schedule();
    };

    const hexPath = (cx: number, cy: number) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const px = cx + size * Math.cos(angle);
        const py = cy + size * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    const draw = (now: number) => {
      frame = 0;
      ctx.clearRect(0, 0, width, height);
      let busy = false;
      if (pointer) {
        const { x, y } = pointer;
        // Every hexagon whose centre could be lit: within the radius and on screen.
        const qMin = Math.floor((Math.max(0, x - radius) - size) / (size * 1.5));
        const qMax = Math.ceil((Math.min(width, x + radius) + size) / (size * 1.5));
        ctx.lineWidth = LINE_WIDTH;
        for (let q = qMin; q <= qMax; q++) {
          const rMin = Math.floor((Math.max(0, y - radius) - size) / (size * SQRT3) - q / 2);
          const rMax = Math.ceil((Math.min(height, y + radius) + size) / (size * SQRT3) - q / 2);
          for (let r = rMin; r <= rMax; r++) {
            const [cx, cy] = centre(q, r, size);
            const d = Math.hypot(cx - x, cy - y);
            if (d > radius + size) continue;
            const light = Math.max(0, 1 - d / radius) ** 1.6;
            const key = `${q},${r}`;
            const v = value(key, now); // 0 green/transparent .. 1 navy
            if (light <= 0.001 && v <= 0.001) continue;
            const lit = Math.max(light, v);
            const col = GREEN.map((g, i) => Math.round(g + (NAVY[i] - g) * v));
            hexPath(cx, cy);
            if (v > 0.001) {
              ctx.fillStyle = `rgba(${NAVY[0]},${NAVY[1]},${NAVY[2]},${FILL_ALPHA * v})`;
              ctx.fill();
            }
            ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${EDGE_ALPHA * lit})`;
            ctx.stroke();
          }
        }
      }
      for (const [key, a] of anims) {
        const done = !a.duration || now - a.start >= a.duration;
        if (done && a.to === 0) anims.delete(key);
        else if (!done) busy = true;
      }
      if (busy) schedule();
    };

    function schedule() {
      if (!frame) frame = requestAnimationFrame(draw);
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      pointer = { x: e.clientX, y: e.clientY };
      const [q, r] = hexAt(e.clientX, e.clientY, size);
      const key = `${q},${r}`;
      if (key !== focused) {
        const now = performance.now();
        if (focused) animate(focused, 0, now);
        animate(key, 1, now);
        focused = key;
      }
      schedule();
    };

    const onLeave = () => {
      pointer = null;
      if (focused) animate(focused, 0, performance.now());
      focused = null;
      schedule();
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  // Fixed behind everything (z -1 paints above the page background, below all content).
  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 -z-10 h-full w-full" />;
}
