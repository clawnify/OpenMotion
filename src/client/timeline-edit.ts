// What a drag on the timeline does to an item: pure arithmetic, no DOM, so it
// can be tested on its own (test/timeline-edit.test.ts).

export type DragMode = "move" | "left" | "right";

export interface Span {
  id: string;
  start: number;
  duration: number;
}

export interface DragContext {
  /** Pixels per second. */
  zoom: number;
  fps: number;
  /** Times an edge snaps to when it comes within `snapPx`: playhead, 0, end, other edges. */
  snapPoints: number[];
  snapPx: number;
}

export interface DragResult {
  start?: number;
  duration?: number;
  /** The snap point the edge landed on, for drawing a guide. */
  snappedTo: number | null;
}

const round = (t: number) => Math.round(t * 1000) / 1000;

/** The snap point nearest `t` within the context's pixel radius, or null. */
export function nearestSnap(t: number, ctx: DragContext): number | null {
  let best: number | null = null;
  for (const p of ctx.snapPoints) {
    if (Math.abs(p - t) * ctx.zoom <= ctx.snapPx && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  }
  return best;
}

/** Snap points for dragging `item`: 0, the playhead, the end, and every other item's edges. */
export function snapPointsFor(item: Span, all: Span[], playhead: number, end: number): number[] {
  const points = [0, playhead, end];
  for (const it of all) if (it.id !== item.id) points.push(it.start, it.start + it.duration);
  return points;
}

/**
 * The item's new start/duration after the pointer moved `ds` seconds.
 * Times land on whole frames. A move keeps the duration; a left trim keeps the
 * end; a right trim keeps the start; nothing gets shorter than two frames
 * (or 0.1 s) or starts before 0.
 */
export function dragEdit(mode: DragMode, item: Span, ds: number, ctx: DragContext): DragResult {
  const frame = 1 / Math.max(1, ctx.fps);
  const q = (t: number) => Math.round(t / frame) * frame;
  const minDur = Math.max(frame * 2, 0.1);

  if (mode === "move") {
    let start = Math.max(0, item.start + ds);
    let snappedTo: number | null = null;
    // Snap whichever edge lands closer to a snap point.
    const s1 = nearestSnap(start, ctx);
    const s2 = nearestSnap(start + item.duration, ctx);
    if (s1 !== null && (s2 === null || Math.abs(s1 - start) <= Math.abs(s2 - start - item.duration))) {
      start = s1;
      snappedTo = s1;
    } else if (s2 !== null) {
      start = Math.max(0, s2 - item.duration);
      snappedTo = s2;
    }
    return { start: round(q(start)), snappedTo };
  }

  if (mode === "left") {
    const end = item.start + item.duration;
    let start = Math.min(Math.max(0, item.start + ds), end - minDur);
    let snappedTo: number | null = null;
    const s = nearestSnap(start, ctx);
    if (s !== null && s <= end - minDur) {
      start = s;
      snappedTo = s;
    }
    start = round(q(start));
    return { start, duration: round(end - start), snappedTo };
  }

  let end = Math.max(item.start + minDur, item.start + item.duration + ds);
  let snappedTo: number | null = null;
  const s = nearestSnap(end, ctx);
  if (s !== null && s >= item.start + minDur) {
    end = s;
    snappedTo = s;
  }
  return { duration: round(q(end - item.start)), snappedTo };
}
