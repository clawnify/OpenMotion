// The video's format: its ratio and pixel size, chosen when a video is made
// and changeable later from the editor. The same five shapes as OpenVideo
// (src/shared/format.ts there), at the sizes the platforms ask for.
//
// A composition's format is its root's data-width / data-height (what the
// renderer reads). Changing it changes the canvas only: a composition is free
// HTML, so positions cannot be moved mechanically without breaking someone's
// layout. A product demo lays itself out from the canvas when it plays, so it
// fits any format exactly; anything else is re-laid out by the AI when asked.

export interface Format {
  id: string;
  name: string;
  ratio: string;
  /** Where the shape is used, for the picker. */
  hint: string;
  width: number;
  height: number;
}

export const FORMATS: readonly Format[] = [
  { id: "landscape", name: "Landscape", ratio: "16:9", hint: "YouTube, websites, demos", width: 1920, height: 1080 },
  { id: "vertical", name: "Vertical", ratio: "9:16", hint: "Reels, Shorts, TikTok", width: 1080, height: 1920 },
  { id: "square", name: "Square", ratio: "1:1", hint: "Feed posts", width: 1080, height: 1080 },
  { id: "portrait", name: "Portrait", ratio: "4:5", hint: "Instagram feed", width: 1080, height: 1350 },
  { id: "classic", name: "Classic", ratio: "4:3", hint: "Presentations", width: 1440, height: 1080 },
];

/** The format a canvas has, if it is one of the five (same shape, any size). */
export function formatOf(width: number, height: number): Format | undefined {
  return FORMATS.find((f) => Math.abs((f.width * height) / (f.height * width) - 1) < 0.01);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** How a canvas's shape reads: "16:9", or "2.39:1" for one with no short ratio. */
export function ratioLabel(width: number, height: number): string {
  const d = gcd(width, height);
  const w = Math.round(width / d), h = Math.round(height / d);
  if (w <= 32 && h <= 32) return `${w}:${h}`;
  return width >= height ? `${(width / height).toFixed(2)}:1` : `1:${(height / width).toFixed(2)}`;
}

const ROOT_TAG = /<[a-z][^>]*\sdata-composition-id\s*=[^>]*>/i;

/** The canvas a composition renders at: its root's data-width / data-height. */
export function frameOf(html: string): { width: number; height: number } | null {
  const tag = ROOT_TAG.exec(html)?.[0];
  if (!tag) return null;
  const width = Number(/\sdata-width\s*=\s*"(\d+)"/.exec(tag)?.[1]);
  const height = Number(/\sdata-height\s*=\s*"(\d+)"/.exec(tag)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The composition at another canvas size: the root's data-width / data-height
 * and the width / height in its own style, and nothing else.
 */
export function withFrame(html: string, width: number, height: number): string {
  const m = ROOT_TAG.exec(html);
  if (!m) return html;
  const tag = m[0]
    .replace(/(\sdata-width\s*=\s*")\d+(")/, `$1${width}$2`)
    .replace(/(\sdata-height\s*=\s*")\d+(")/, `$1${height}$2`)
    .replace(/(\sstyle\s*=\s*"[^"]*?)(?<![-\w])width\s*:\s*\d+(?:\.\d+)?px/, `$1width:${width}px`)
    .replace(/(\sstyle\s*=\s*"[^"]*?)(?<![-\w])height\s*:\s*\d+(?:\.\d+)?px/, `$1height:${height}px`);
  return html.slice(0, m.index) + tag + html.slice(m.index + m[0].length);
}
