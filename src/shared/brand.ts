// The app's brand: the colours, fonts and logo every video uses, kept once so
// a video stops looking like everyone else's. The agent reads it before it
// writes a composition (GET /api/brand), a new video starts in it
// (client/starter.ts), and the lint flags a colour that is not in it.
//
// It follows HyperFrames' own split for a brand spec (docs/prompting/
// design-systems.mdx, frame.md): colours and type are strict, layout and
// motion are free. So the check below is about colour only, and only about
// hues: greys, black and white are always allowed (shadows, scrims, frames
// around a screenshot), and so is any shade or opacity of a brand colour.
// That is what HyperFrames' own brand mapping makes (skills/*/scripts/
// build-frame.mjs: a colour takes the brand's hue and saturation and keeps
// its own lightness), so a lighter accent for a card is on brand.
//
// Pure functions, no DOM, so they run in the Worker, the browser and the tests.

export interface Brand {
  background: string | null;
  text: string | null;
  accent: string | null;
  secondary: string | null;
  heading_font: string | null;
  body_font: string | null;
  /** A media-library asset. Its `key` is what a composition references. */
  logo_asset_id: string | null;
  /** Do's and don'ts in the user's words, for the agent. */
  notes: string;
}

export const COLOR_ROLES = ["background", "text", "accent", "secondary"] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const EMPTY_BRAND: Brand = {
  background: null,
  text: null,
  accent: null,
  secondary: null,
  heading_font: null,
  body_font: null,
  logo_asset_id: null,
  notes: "",
};

/** `#rrggbb`, lower case. */
export const HEX = /^#[0-9a-f]{6}$/;
/**
 * A colour as people paste it from brand guidelines ("E4572E", "#abc",
 * " #E4572E ") written as `#rrggbb`. Anything else comes back trimmed, for
 * the caller to refuse.
 */
export function normalHex(v: string): string {
  const h = v.trim().toLowerCase().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(h)) return "#" + h;
  if (/^[0-9a-f]{3}$/.test(h)) return "#" + [...h].map((c) => c + c).join("");
  return v.trim().toLowerCase();
}

/** A Google Fonts family name: letters, digits, spaces, hyphens. */
export const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/;

/**
 * Fonts the renderer ships with, so they render without fetching anything
 * (HyperFrames' CANONICAL_FONTS). Any other Google Fonts family works too:
 * the renderer fetches it by name.
 */
export const BUNDLED_FONTS = [
  "Inter", "Montserrat", "Outfit", "Nunito", "Oswald", "League Gothic", "Archivo Black",
  "Space Mono", "IBM Plex Mono", "JetBrains Mono", "EB Garamond", "Playfair Display",
  "Source Code Pro", "Noto Sans JP", "Roboto", "Open Sans", "Lato", "Poppins",
] as const;

export function hasBrand(b: Brand | null | undefined): b is Brand {
  return !!b && (COLOR_ROLES.some((r) => b[r]) || !!b.heading_font || !!b.body_font || !!b.logo_asset_id || !!b.notes.trim());
}

export function brandColors(b: Brand): { role: ColorRole; hex: string }[] {
  return COLOR_ROLES.flatMap((role) => (b[role] ? [{ role, hex: b[role]! }] : []));
}

// ── colours ──────────────────────────────────────────────────────────

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB | null {
  let h = hex.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  else if (h.length === 8) h = h.slice(0, 6);
  else if (h.length !== 6) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

function rgbFunctionToRgb(s: string): RGB | null {
  const m = s.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/i);
  if (!m) return null;
  const ch = (v: string) => Math.round(v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v));
  const rgb = [ch(m[1]), ch(m[2]), ch(m[3])] as RGB;
  return rgb.every((v) => v >= 0 && v <= 255) ? rgb : null;
}

/** hsl()/hsla(), in degrees (or turn/rad) and percentages. */
function hslFunctionToRgb(s: string): RGB | null {
  const m = s.match(/^hsla?\(\s*(-?[\d.]+)(deg|turn|rad)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/i);
  if (!m) return null;
  const unit = (m[2] || "deg").toLowerCase();
  const turns = unit === "turn" ? +m[1] : unit === "rad" ? +m[1] / (2 * Math.PI) : +m[1] / 360;
  const h = ((turns % 1) + 1) % 1;
  const sat = Math.min(1, +m[3] / 100);
  const l = Math.min(1, +m[4] / 100);
  const k = (n: number) => (n + h * 12) % 12;
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as RGB;
}

function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * No hue to speak of: a grey, a near-black or near-white, a cream. Measured
 * as chroma (max - min channel), not HSL saturation, which calls a barely
 * tinted off-white fully saturated.
 */
function isNeutral([r, g, b]: RGB): boolean {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255 < 0.08;
}

/** The hue in degrees, 0-360. */
function hueOf([r, g, b]: RGB): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** How far apart two hues may be and still be one colour, lighter or darker. */
const HUE_SLACK = 15;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The CSS a composition paints with: inline styles, the declaration blocks of
 * its <style> sheets (not their selectors, so `#face { … }` is not a colour),
 * and SVG paint attributes. Each piece keeps its offset in the HTML, for a
 * line number.
 */
function cssPieces(html: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (const m of html.matchAll(/\s(?:style|fill|stroke|stop-color|color)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    out.push({ text: m[2], at: m.index! + m[0].indexOf(m[2]) });
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const body = m[1];
    const base = m.index! + m[0].indexOf(body);
    for (const d of body.matchAll(/\{([^{}]*)\}/g)) out.push({ text: d[1], at: base + d.index! + 1 });
  }
  return out;
}

/** String literals in the composition's scripts: a tween's `color: "#ff5a1f"`. */
function scriptPieces(html: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const base = m.index! + m[0].indexOf(m[1]);
    for (const s of m[1].matchAll(/(["'`])((?:#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)|(?:rgb|hsl)a?\([^)"'`]*\))\1/g)) {
      out.push({ text: s[2], at: base + s.index! + 1 });
    }
  }
  return out;
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

export interface ColorUse {
  /** As written. */
  raw: string;
  hex: string;
  /** Offset of its first use in the HTML. */
  at: number;
}

/** Every distinct colour a composition paints with, in order of first use. */
export function colorsIn(html: string): ColorUse[] {
  const seen = new Map<string, ColorUse>();
  for (const piece of [...cssPieces(html), ...scriptPieces(html)]) {
    for (const m of piece.text.matchAll(COLOR_TOKEN)) {
      const rgb = m[0].startsWith("#")
        ? hexToRgb(m[0])
        : /^hsl/i.test(m[0])
          ? hslFunctionToRgb(m[0])
          : rgbFunctionToRgb(m[0]);
      if (!rgb) continue;
      // A url(#gradient) or href="#id" is not a colour; hexToRgb already
      // refused anything with a non-hex letter, and a url() fragment is
      // never in a paint position.
      if (m[0].startsWith("#") && /url\(\s*$/i.test(piece.text.slice(0, m.index!))) continue;
      const hex = toHex(rgb);
      const at = piece.at + m.index!;
      const prev = seen.get(hex);
      if (!prev || at < prev.at) seen.set(hex, { raw: m[0], hex, at });
    }
  }
  return [...seen.values()].sort((a, b) => a.at - b.at);
}

export interface OffBrandColor extends ColorUse {
  line: number;
}

/**
 * Colours with a hue that is in none of the brand's colours. Empty when the
 * brand names no colour: then there is nothing to be off. A brand of only
 * neutrals (black, white, greys) makes every hue off.
 */
export function offBrandColors(html: string, brand: Brand | null | undefined): OffBrandColor[] {
  if (!brand) return [];
  const palette = brandColors(brand).map((c) => hexToRgb(c.hex)!);
  if (!palette.length) return [];
  const hues = palette.filter((p) => !isNeutral(p)).map(hueOf);
  return colorsIn(html)
    .filter((c) => {
      const rgb = hexToRgb(c.hex)!;
      if (isNeutral(rgb)) return false;
      const h = hueOf(rgb);
      return !hues.some((b) => hueDistance(b, h) <= HUE_SLACK);
    })
    .map((c) => ({ ...c, line: html.slice(0, c.at).split("\n").length }));
}

/** Black or white, whichever reads on `bg` (WCAG relative luminance). */
export function readableOn(bg: string): "#000000" | "#ffffff" {
  const rgb = hexToRgb(bg);
  if (!rgb) return "#ffffff";
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // The luminance where black and white have the same contrast ratio.
  return lum > 0.179 ? "#000000" : "#ffffff";
}

/** `#rrggbb` at an opacity, as rgba(): still the brand colour to the lint. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex) ?? [255, 255, 255];
  return `rgba(${rgb.join(",")},${alpha})`;
}

/** The brand's colours as a sentence, for a finding's fix. */
export function paletteText(brand: Brand): string {
  return brandColors(brand)
    .map((c) => `${c.role} ${c.hex}`)
    .join(", ");
}

// ── fonts ────────────────────────────────────────────────────────────

const GENERIC = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif",
  "ui-serif", "ui-monospace", "emoji", "math", "fangsong", "-apple-system", "blinkmacsystemfont",
  "inherit", "initial", "unset", "revert",
]);

/**
 * The font families a composition names, first use first: what the renderer
 * embeds by name and the preview has to load to look the same.
 */
export function fontFamiliesIn(html: string): string[] {
  const out = new Map<string, string>();
  for (const piece of cssPieces(html)) {
    for (const m of piece.text.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^["']|["']$/g, "").trim();
        if (!name || GENERIC.has(name.toLowerCase()) || name.startsWith("var(") || !FONT_NAME.test(name)) continue;
        if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
      }
    }
  }
  return [...out.values()];
}

/**
 * A Google Fonts stylesheet for one family, with the weights the renderer asks
 * for. One per family: css2 refuses a whole request when one family in it is
 * unknown, and tolerates weights a family does not have.
 */
export function googleFontsHref(family: string): string {
  const weights = "ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700";
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:${weights}&display=block`;
}
