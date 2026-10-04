// The timeline: lanes of items on a time ruler, with a playhead.
//
// It knows nothing about compositions. An item is an id, a lane, a start and
// a duration; every edit comes back through onChange, so the caller decides
// what a move or a trim means for its own document. That keeps it liftable
// into a shared package (OpenVideo has the same needs).
//
// Edits are reported twice: "live" on every pointer move while dragging, so
// the caller can redraw, and "commit" once on release, so it saves and
// records one undo step per gesture.

import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Pause, Play, Plus } from "lucide-react";
import { btnIcon, card } from "./ui";
import { dragEdit, snapPointsFor, type DragMode } from "./timeline-edit";

export interface TimelineItem {
  id: string;
  /** 0 is the bottom lane; higher lanes draw above it. */
  lane: number;
  start: number;
  duration: number;
  label: string;
  /** Tint fill + text colour for the item. */
  fillClass: string;
  /** The solid bar at the item's left edge. */
  barClass: string;
  icon?: React.ReactNode;
}

/** Ruler labels in plain seconds ("0.5s", "12s", "1:05"): a frame timecode such
 *  as 00:00.15 reads as 0.15 s when it means frame 15. */
function rulerLabel(t: number): string {
  if (t < 60) return `${Math.round(t * 100) / 100}s`;
  const m = Math.floor(t / 60);
  const sec = Math.round(t - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export type TimelineEdit = Partial<Pick<TimelineItem, "start" | "duration" | "lane">>;

const HEAD_W = 112; // lane header column, px
const ROW_H = 40;
const RULER_H = 28;
const EDGE = 7; // px of an item that grabs a trim instead of a move
const SNAP_PX = 6;
const DRAG_START_PX = 3;

export function Timeline({
  items,
  lanes,
  duration,
  time,
  playing,
  fps,
  selected,
  onSelect,
  onSeek,
  onTogglePlay,
  onChange,
  formatTime,
}: {
  items: TimelineItem[];
  lanes: number;
  duration: number;
  time: number;
  playing: boolean;
  fps: number;
  selected: string | null;
  /** A clip was pressed, or null: the empty timeline was, which lets go of the selection. */
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onTogglePlay: () => void;
  onChange: (id: string, edit: TimelineEdit, phase: "live" | "commit") => void;
  formatTime: (t: number) => string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dur = Math.max(duration, 0.5);
  // null = fit the whole video in view; a number = px per second.
  const [zoomPx, setZoomPx] = useState<number | null>(null);
  const fit = Math.max(8, (viewW - HEAD_W - 16) / dur);
  const zoom = zoomPx ?? fit;
  const trackW = Math.max(dur * zoom, viewW - HEAD_W);
  const zoomBy = (f: number) => setZoomPx(Math.min(2000, Math.max(fit / 2, zoom * f)));

  // One empty lane always waits on top, so a clip can be dropped on a new
  // track. It is always there rather than appearing mid-drag, which would
  // shift every lane under the pointer.
  const [dragging, setDragging] = useState(false);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const laneCount = Math.max(1, lanes) + 1;
  const rows = Array.from({ length: laneCount }, (_, i) => laneCount - 1 - i); // top lane first

  const round = (t: number) => Math.round(t * 1000) / 1000;

  // Minor ticks at least 16 px apart; a label every major step, at least 80 px apart.
  const ticks = useMemo(() => {
    const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const minor = steps.find((s) => s * zoom >= 16) ?? 60;
    const major = steps.find((s) => s >= minor && s * zoom >= 80 && Math.abs(s / minor - Math.round(s / minor)) < 1e-6) ?? 60;
    const out: { t: number; major: boolean }[] = [];
    const n = Math.floor(trackW / zoom / minor + 1e-6);
    for (let i = 0; i <= n; i++) {
      const t = Math.round(i * minor * 1000) / 1000;
      out.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });
    }
    return out;
  }, [zoom, trackW]);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEAD_W + el.scrollLeft) / zoom);
  };
  const laneAt = (clientY: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const row = Math.floor((clientY - rect.top - RULER_H + el.scrollTop) / ROW_H);
    const clamped = Math.max(0, Math.min(laneCount - 1, row));
    return laneCount - 1 - clamped;
  };

  function scrub(e: React.PointerEvent) {
    onSeek(Math.min(timeAt(e.clientX), dur));
    const move = (ev: PointerEvent) => onSeek(Math.min(timeAt(ev.clientX), dur));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function grab(item: TimelineItem, e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(item.id);
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - box.left;
    const mode: DragMode =
      box.width > EDGE * 3 && x <= EDGE ? "left" : box.width > EDGE * 3 && x >= box.width - EDGE ? "right" : "move";
    const startX = e.clientX;
    const startY = e.clientY;
    const ctx = { zoom, fps, snapPx: SNAP_PX, snapPoints: snapPointsFor(item, items, time, dur) };
    let moved = false;
    let last: TimelineEdit | null = null;

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
      if (!moved) {
        moved = true;
        setDragging(true);
      }
      const r = dragEdit(mode, item, (ev.clientX - startX) / zoom, ctx);
      const edit: TimelineEdit = {};
      if (r.start !== undefined) edit.start = r.start;
      if (r.duration !== undefined) edit.duration = r.duration;
      if (mode === "move") {
        // Change lane only where the clip fits: overlapping clips in one lane
        // would hide each other here, though HyperFrames itself allows it.
        const lane = laneAt(ev.clientY);
        const start = edit.start ?? item.start;
        const end = start + item.duration;
        const clash = items.some((o) => o.id !== item.id && o.lane === lane && o.start < end - 1e-6 && o.start + o.duration > start + 1e-6);
        edit.lane = lane !== item.lane && clash ? item.lane : lane;
      }
      setSnapAt(r.snappedTo);
      last = edit;
      onChange(item.id, edit, "live");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      setSnapAt(null);
      if (moved && last) onChange(item.id, last, "commit");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className={`${card} text-foreground overflow-hidden select-none`}>
      {/* transport + zoom */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border">
        <button onClick={onTogglePlay} className={btnIcon} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <span className="text-data tabular-nums">
          {formatTime(time)} <span className="text-faint">/ {formatTime(dur)}</span>
        </span>
        <div className="flex-1" />
        <button onClick={() => zoomBy(1 / 1.5)} className={btnIcon} aria-label="Zoom out" title="Zoom out">
          <Minus className="w-4 h-4" />
        </button>
        <button onClick={() => zoomBy(1.5)} className={btnIcon} aria-label="Zoom in" title="Zoom in">
          <Plus className="w-4 h-4" />
        </button>
        <button onClick={() => setZoomPx(null)} disabled={zoomPx === null} className={btnIcon} aria-label="Fit the whole video" title="Fit">
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>

      <div ref={scrollRef} className="relative overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width: HEAD_W + trackW }}>
          {/* ruler */}
          <div className="flex sticky top-0 z-20 bg-surface" style={{ height: RULER_H }}>
            <div style={{ width: HEAD_W }} className="shrink-0 sticky left-0 z-10 bg-surface border-r border-b border-border" />
            <div className="relative flex-1 overflow-hidden border-b border-border cursor-ew-resize" onPointerDown={scrub}>
              {ticks.map(({ t, major }) =>
                major ? (
                  <div key={t} className="absolute top-0 h-full border-l border-border" style={{ left: t * zoom }}>
                    <span className="absolute left-1 top-1.5 text-fine text-faint tabular-nums whitespace-nowrap">{rulerLabel(t)}</span>
                  </div>
                ) : (
                  <div key={t} className="absolute bottom-0 h-1.5 border-l border-border" style={{ left: t * zoom }} />
                ),
              )}
              {/* past the end of the video */}
              <div className="absolute top-0 bottom-0 right-0 bg-surface-sunken/60" style={{ left: dur * zoom }} />
            </div>
          </div>

          {/* lanes */}
          {rows.map((lane) => (
            <div key={lane} className="flex" style={{ height: ROW_H }}>
              <div
                style={{ width: HEAD_W }}
                className="shrink-0 sticky left-0 z-10 bg-surface border-r border-b border-border flex items-center px-3 text-fine text-muted"
                onPointerDown={() => onSelect(null)}
              >
                {lane < lanes ? `Track ${lane + 1}` : <span className={dragging ? "" : "text-faint"}>New track</span>}
              </div>
              {/* A press on the empty lane lets go of the selection and moves the
                  playhead there. Clips stop their own presses (grab). */}
              <div
                className="relative flex-1 border-b border-border bg-background"
                onPointerDown={(e) => {
                  onSelect(null);
                  scrub(e);
                }}
              >
                {items
                  .filter((it) => it.lane === lane)
                  .map((it) => (
                    <div
                      key={it.id}
                      onPointerDown={(e) => grab(it, e)}
                      className={`group absolute top-1 bottom-1 rounded-sm flex items-center gap-1.5 pl-1.5 pr-2 text-fine overflow-hidden cursor-grab active:cursor-grabbing ${it.fillClass} ${
                        it.id === selected ? "ring-2 ring-offset-1 ring-ring ring-offset-surface" : ""
                      }`}
                      style={{ left: it.start * zoom, width: Math.max(6, it.duration * zoom) }}
                      title={`${it.label} · ${round(it.start)}s to ${round(it.start + it.duration)}s`}
                    >
                      <span className={`w-0.5 self-stretch my-0.5 rounded-full shrink-0 ${it.barClass}`} />
                      {it.icon}
                      <span className="truncate">{it.label}</span>
                      {/* trim handles: visible on hover, active on the edges */}
                      <span className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-foreground/15" />
                      <span className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-foreground/15" />
                    </div>
                  ))}
              </div>
            </div>
          ))}

          {/* snap guide */}
          {snapAt !== null && (
            <div className="absolute top-0 bottom-0 w-px bg-ring pointer-events-none z-20" style={{ left: HEAD_W + snapAt * zoom }} />
          )}
          {/* playhead */}
          <div className="absolute top-0 bottom-0 w-px bg-foreground pointer-events-none z-30" style={{ left: HEAD_W + time * zoom }}>
            <div className="absolute -top-0.5 -translate-x-1/2 w-3 h-3 rounded-sm bg-foreground" />
          </div>
        </div>
      </div>

      {items.length === 0 && (
        <div className="px-3 py-3 text-fine text-muted">
          No timed clips yet. Add elements with <code>class="clip"</code> + <code>data-start</code> /{" "}
          <code>data-duration</code> / <code>data-track-index</code> in the Compose tab.
        </div>
      )}
    </div>
  );
}
