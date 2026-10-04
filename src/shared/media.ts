// Putting a Media library item into a video, as OpenVideo's library does: one
// click adds it. OpenVideo appends to a magnetic main track; here every clip
// has its own start, so it lands at the playhead instead.
//
// The markup follows the house convention (agent.md, screen-demo layouts): a
// video fills the frame and plays muted with its sound on a separate
// <audio>, since HyperFrames renders a video's picture but not its sound.
// `data-track-index` is only the timeline lane (the render never reads it);
// what is on top is DOM order, so the caller appends the new clip last.

export type MediaKind = "image" | "video" | "audio";

/** A still has no length of its own; OpenVideo gives one 3 s too. */
export const IMAGE_SECONDS = 3;
/** For a video or sound whose length could not be measured. */
export const FALLBACK_SECONDS = 5;

export function mediaKind(contentType: string): MediaKind | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return null;
}

export interface Placement {
  start: number;
  duration: number;
  /** The visual's lane (or the sound's, for audio). A video's sound goes one lane up. */
  track: number;
  /** The root's new stated length, when the clip would end past it. */
  length?: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Where a new clip goes: from the playhead (on a frame), for the media's own
 * length, on new lanes above every existing one so it never lands on top of a
 * clip in the timeline. A stated length that would cut it off grows with it,
 * as it does when a clip is moved (applyClipPatch); it never shrinks.
 */
export function placeMedia(opts: {
  kind: MediaKind;
  /** The media's measured length in seconds; null or 0 when unknown. */
  seconds: number | null | undefined;
  playhead: number;
  fps: number;
  /** Lanes in use now (parseClips' `tracks`). */
  tracks: number;
  /** The root's stated data-duration, or null when it states none. */
  length: number | null;
}): Placement {
  const start = r2(Math.round(Math.max(0, opts.playhead) * opts.fps) / opts.fps);
  const duration =
    opts.kind === "image" ? IMAGE_SECONDS : opts.seconds && opts.seconds > 0 ? r2(opts.seconds) : FALLBACK_SECONDS;
  const end = r2(start + duration);
  return {
    start,
    duration,
    track: opts.tracks,
    ...(opts.length != null && opts.length > 0 && end > opts.length ? { length: end } : {}),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The clip's markup. `id` must be unique in the composition (tweens and the
 * timeline find clips by it). A video comes with its sound one lane up.
 */
export function mediaHtml(kind: MediaKind, src: string, id: string, p: Placement): string {
  const at = `data-start="${p.start}" data-duration="${p.duration}"`;
  const s = esc(src);
  if (kind === "audio") {
    return `<audio id="${id}" src="${s}" class="clip" ${at} data-track-index="${p.track}" data-volume="1"></audio>`;
  }
  const fill = "position:absolute;inset:0;width:100%;height:100%";
  if (kind === "image") {
    // A still is usually a logo or a photo, not a backdrop: centred at its own
    // size, at most 60% of the frame. Centred by inset + auto margins, not a
    // transform, which the first GSAP tween on it would overwrite.
    const centred = "position:absolute;inset:0;margin:auto;max-width:60%;max-height:60%";
    return `<img id="${id}" src="${s}" class="clip" ${at} data-track-index="${p.track}" alt="" style="${centred}">`;
  }
  return (
    `<video id="${id}" src="${s}" class="clip" ${at} data-track-index="${p.track}" muted playsinline style="${fill};object-fit:cover"></video>\n` +
    `<audio id="${id}-audio" src="${s}" class="clip" ${at} data-track-index="${p.track + 1}" data-volume="1"></audio>`
  );
}

/** A clip id from the asset key that no element in `taken` uses yet. */
export function mediaId(key: string, taken: Set<string>): string {
  const base = "media-" + (key.replace(/\.[^.]*$/, "").replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "clip");
  let id = base;
  for (let n = 2; taken.has(id) || taken.has(`${id}-audio`); n++) id = `${base}-${n}`;
  return id;
}
