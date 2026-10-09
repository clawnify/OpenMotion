// Starter composition for a new video.
//
// This is VIDEO DOCUMENT content, not app chrome: the colours and sizes
// below are pixels inside the user's composition, so they are literal by
// definition and the app's design tokens do not apply to them. It lives in
// its own module for exactly that reason (see .design-lint-ignore).
//
// Three clips on three separate tracks with a staggered GSAP timeline, so
// the timeline view shows real track registration. Each clip sits at a fixed
// offset from the frame's centre rather than a percentage of its height, so
// the same title card reads the same way in every shape, and is centred on
// that point by GSAP (xPercent/yPercent). The root states the
// length (data-duration): the entrances finish at 1.7 s, and without it
// HyperFrames would render only that much. Kept as a string rather than a DB
// seed so it goes in via the normal parameterized insert.
//
// With a brand (shared/brand.ts) the card starts in it: its background, text
// and accent colours, its heading and body fonts, and its logo above the
// kicker. A colour the brand leaves out falls back to one of its own colours
// or to black or white, never to the default palette, so a branded starter
// lints clean against its brand.

import { brandColors, readableOn, withAlpha, type Brand } from "../shared/brand.ts";

const DEFAULT_LOOK = { bg: "#0b1020", title: "#fff", kicker: "#7c8cff", sub: "#9aa6d6" };

function look(brand: Brand | null | undefined) {
  if (!brand || !brandColors(brand).length) return DEFAULT_LOOK;
  const bg = brand.background ?? "#0a0a0a";
  const title = brand.text ?? readableOn(bg);
  return { bg, title, kicker: brand.accent ?? brand.secondary ?? title, sub: brand.secondary ?? withAlpha(title, 0.7) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function starterHtml(
  width: number,
  height: number,
  brand?: Brand | null,
  /** The brand logo's asset key, when it has one. */
  logoKey?: string | null,
): string {
  const c = look(brand);
  const heading = brand?.heading_font ? `'${brand.heading_font}',` : "";
  const body = brand?.body_font ? `'${brand.body_font}',` : "Inter,";
  const ids = logoKey ? `"#logo", "#kicker", "#title", "#sub"` : `"#kicker", "#title", "#sub"`;
  const logo = logoKey
    ? `
  <img id="logo" class="clip" data-start="0" data-duration="5" data-track-index="3" src="assets/${esc(logoKey)}" alt=""
       style="position:absolute;top:calc(50% - 290px);left:50%;height:96px;width:auto;max-width:40%;object-fit:contain">`
    : "";
  const logoIn = logoKey ? `
    tl.from("#logo", { opacity: 0, scale: 0.9, duration: 0.6 }, 0);` : "";
  const kickerAt = logoKey ? 0.2 : 0;
  return `<div id="root" data-composition-id="untitled" data-start="0" data-duration="5" data-width="${width}" data-height="${height}"
     style="width:${width}px;height:${height}px;background:${c.bg};position:relative;overflow:hidden;font-family:${body}system-ui,sans-serif">${logo}
  <div id="kicker" class="clip" data-start="0" data-duration="5" data-track-index="2"
       style="position:absolute;top:calc(50% - 173px);left:50%;color:${c.kicker};font-size:28px;font-weight:700;letter-spacing:4px;text-transform:uppercase;white-space:nowrap${heading ? `;font-family:${heading}system-ui,sans-serif` : ""}">
    Product Launch
  </div>
  <div id="title" class="clip" data-start="0.3" data-duration="4.7" data-track-index="1"
       style="position:absolute;top:calc(50% - 22px);left:50%;color:${c.title};font-size:96px;font-weight:800;letter-spacing:-2px;text-align:center;white-space:nowrap${heading ? `;font-family:${heading}system-ui,sans-serif` : ""}">
    Your Title Here
  </div>
  <div id="sub" class="clip" data-start="0.9" data-duration="4.1" data-track-index="0"
       style="position:absolute;top:calc(50% + 108px);left:50%;color:${c.sub};font-size:34px;font-weight:500;text-align:center;white-space:nowrap">
    A subtitle that fades in
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    // Centre with GSAP, not a CSS transform: a tween that moves y rewrites
    // the whole transform and would throw a CSS translate(-50%,-50%) away.
    gsap.set([${ids}], { xPercent: -50, yPercent: -50 });
    const tl = gsap.timeline({ paused: true });${logoIn}
    tl.from("#kicker", { opacity: 0, y: -20, duration: 0.6 }, ${kickerAt})
      .from("#title", { opacity: 0, y: 50, duration: 1 }, 0.3)
      .from("#sub", { opacity: 0, y: 30, duration: 0.8 }, 0.9);
    window.__timelines = window.__timelines || {};
    window.__timelines["untitled"] = tl;
  </script>
</div>`;
}
