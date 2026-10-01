// How long a composition is. One rule, read by the preview, the timeline, the
// render and the media library, so the video you scrub is the video you get.
//
// HyperFrames decides the render length like this: the root's `data-duration`
// if it has one, otherwise the length of the registered GSAP timelines. Clips
// do not count. A composition whose clips run to 5 s but whose entrances finish
// at 1.7 s therefore renders as a 1.7 s MP4, while every clip on the timeline
// says 5 s.
//
// The app's rule matches HyperFrames wherever the root states a length, and
// where it does not, the length is where the last clip ends: that is what the
// timeline shows, and past it nothing timed is on screen. The render route
// writes that length onto the root before rendering (`withLength`), so the two
// rules never disagree. Only a composition with neither a root length nor any
// clips falls through to the timelines, in the preview and the renderer alike.
//
// Plain string parsing, no DOM: this runs in the Worker as well as the browser.

const TAG = /<[a-z][^>]*>/gi;

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? "") : null;
}

function rootTag(html: string): string | null {
  return html.match(/<[a-z][^>]*\sdata-composition-id\s*=[^>]*>/i)?.[0] ?? null;
}

function seconds(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The root's own `data-duration`, when it states a usable one. */
export function rootLength(html: string): number | null {
  const root = rootTag(html);
  return root ? seconds(attr(root, "data-duration")) : null;
}

/** Where the last clip ends, in seconds; 0 with no clips. */
export function clipsEnd(html: string): number {
  let end = 0;
  // An inline nested composition sits in a <template>; its clips are timed
  // from the sub-composition's own start, and the page never renders them
  // where they are written. Its host element is the clip that counts.
  const page = html.replace(/<template[\s>][\s\S]*?<\/template>/gi, "");
  for (const [tag] of page.matchAll(TAG)) {
    if (!/(^|\s)clip(\s|$)/.test(attr(tag, "class") ?? "")) continue;
    // A start like "intro - 0.5" refers to another clip; this reads only
    // numeric starts, so such a clip counts from 0.
    const start = Number(attr(tag, "data-start")) || 0;
    const dur = seconds(attr(tag, "data-duration")) ?? 0;
    end = Math.max(end, start + dur);
  }
  return round(end);
}

/** Render length in seconds, or null when only the timelines can say. */
export function compositionLength(html: string): number | null {
  const own = rootLength(html);
  if (own != null) return own;
  const end = clipsEnd(html);
  return end > 0 ? end : null;
}

/** The HTML with its length written on the root, as HyperFrames reads it. */
export function withLength(html: string): string {
  if (rootLength(html) != null) return html;
  const root = rootTag(html);
  const end = clipsEnd(html);
  if (!root || end <= 0) return html;
  // Drop an unusable data-duration (empty, zero, text) before writing ours.
  const cleaned = root.replace(/\sdata-duration\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
  const stamped = cleaned.replace(/\s*\/?>$/, (close) => ` data-duration="${end}"${close.trimStart()}`);
  return html.replace(root, () => stamped);
}
