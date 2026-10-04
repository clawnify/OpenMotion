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

export function starterHtml(width: number, height: number): string {
  return `<div id="root" data-composition-id="untitled" data-start="0" data-duration="5" data-width="${width}" data-height="${height}"
     style="width:${width}px;height:${height}px;background:#0b1020;position:relative;overflow:hidden;font-family:Inter,system-ui,sans-serif">
  <div id="kicker" class="clip" data-start="0" data-duration="5" data-track-index="2"
       style="position:absolute;top:calc(50% - 173px);left:50%;color:#7c8cff;font-size:28px;font-weight:700;letter-spacing:4px;text-transform:uppercase;white-space:nowrap">
    Product Launch
  </div>
  <div id="title" class="clip" data-start="0.3" data-duration="4.7" data-track-index="1"
       style="position:absolute;top:calc(50% - 22px);left:50%;color:#fff;font-size:96px;font-weight:800;letter-spacing:-2px;text-align:center;white-space:nowrap">
    Your Title Here
  </div>
  <div id="sub" class="clip" data-start="0.9" data-duration="4.1" data-track-index="0"
       style="position:absolute;top:calc(50% + 108px);left:50%;color:#9aa6d6;font-size:34px;font-weight:500;text-align:center;white-space:nowrap">
    A subtitle that fades in
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    // Centre with GSAP, not a CSS transform: a tween that moves y rewrites
    // the whole transform and would throw a CSS translate(-50%,-50%) away.
    gsap.set(["#kicker", "#title", "#sub"], { xPercent: -50, yPercent: -50 });
    const tl = gsap.timeline({ paused: true });
    tl.from("#kicker", { opacity: 0, y: -20, duration: 0.6 }, 0)
      .from("#title", { opacity: 0, y: 50, duration: 1 }, 0.3)
      .from("#sub", { opacity: 0, y: 30, duration: 0.8 }, 0.9);
    window.__timelines = window.__timelines || {};
    window.__timelines["untitled"] = tl;
  </script>
</div>`;
}
