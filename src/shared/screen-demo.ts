// A product demo in the style of a polished screen recording, built from one
// still per state of a real app: a cursor glides to what gets clicked, the
// click ripples, the page changes, and the camera zooms to what matters.
//
// Stills, not an <iframe> of the live app: the renderer can neither click
// inside an iframe nor rewind it, each render worker loads it afresh, and most
// apps refuse to be framed. Stills render the same every time, from any page
// that can be opened in a browser.
//
// The composition this returns carries a small script (the "kit") that reads
// each step's timing and boxes from its attributes when the page loads. So
// moving or trimming a step on the timeline moves its camera and cursor too,
// and the HTML stays an ordinary composition the user and the agent can edit.

/** A box on the captured page, in CSS pixels of the capture viewport. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenDemoStep {
  /** The still, as `assets/<key>` (or any URL the renderer can load). */
  src: string;
  /** How long this state is on screen. */
  seconds: number;
  /** What to zoom to while this state is shown. */
  focus?: Box;
  /** What gets clicked to reach the next state. The last step has none. */
  click?: Box;
}

export interface ScreenDemoOptions {
  id: string;
  steps: ScreenDemoStep[];
  /** The capture viewport in CSS pixels (the stills may be 2x that). */
  page?: { width: number; height: number };
  /** The video's size. */
  frame?: { width: number; height: number };
  /** CSS background behind the window. */
  background?: string;
  /** The click ripple's colour, as `r,g,b`. */
  accent?: string;
}

/** The shortest step with a click the kit can play: zoom in, then travel and click. */
export const MIN_CLICK_STEP = 2;

const round = (n: number) => Math.round(n * 1000) / 1000;
const boxAttr = (b: Box) => [b.x, b.y, b.w, b.h].map(Math.round).join(",");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The steps' problems, as sentences; empty when the steps can be built. */
export function screenDemoProblems(opts: ScreenDemoOptions): string[] {
  const out: string[] = [];
  const { width: pw, height: ph } = opts.page ?? { width: 1600, height: 900 };
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(opts.id)) out.push("id: letters, digits and dashes only");
  if (opts.steps.length === 0) out.push("steps: at least one");
  if (opts.accent !== undefined && !/^\d{1,3},\d{1,3},\d{1,3}$/.test(opts.accent)) out.push("accent: r,g,b");
  opts.steps.forEach((s, i) => {
    const n = `steps[${i}]`;
    if (!s.src || /["<>]/.test(s.src)) out.push(`${n}.src: an assets/<key> path`);
    if (!(s.seconds > 0)) out.push(`${n}.seconds: above 0`);
    if (s.click && s.seconds < MIN_CLICK_STEP) out.push(`${n}.seconds: at least ${MIN_CLICK_STEP} for a step with a click`);
    for (const k of ["focus", "click"] as const) {
      const b = s[k];
      if (!b) continue;
      const ok = [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0 &&
        b.x + b.w > 0 && b.y + b.h > 0 && b.x < pw && b.y < ph;
      if (!ok) out.push(`${n}.${k}: a box {x,y,w,h} on the ${pw}x${ph} page`);
    }
  });
  return out;
}

export function screenDemoHtml(opts: ScreenDemoOptions): string {
  const { width: pw, height: ph } = opts.page ?? { width: 1600, height: 900 };
  const { width: fw, height: fh } = opts.frame ?? { width: 1920, height: 1080 };
  // The window is the page at 1:1, centred, scaled down only if the frame is
  // smaller than the page plus a margin.
  const fitScale = Math.min(1, (fw * 0.9) / pw, (fh * 0.9) / ph);
  const ww = Math.round(pw * fitScale), wh = Math.round(ph * fitScale);
  const wx = Math.round((fw - ww) / 2), wy = Math.round((fh - wh) / 2);
  const accent = opts.accent ?? "224,82,104";
  const bg = opts.background ?? "linear-gradient(135deg,#f6d5dc,#dfe3f7)";

  let t = 0;
  const imgs = opts.steps.map((s, i) => {
    const attrs = [
      `id="step${i + 1}"`,
      `src="${esc(s.src)}"`,
      `class="clip demo-step"`,
      `data-start="${round(t)}"`,
      `data-duration="${round(s.seconds)}"`,
      `data-track-index="0"`,
      s.focus ? `data-focus="${boxAttr(s.focus)}"` : "",
      s.click ? `data-click="${boxAttr(s.click)}"` : "",
    ].filter(Boolean).join(" ");
    t += s.seconds;
    return `      <img ${attrs}\n           style="position:absolute;left:0;top:0;width:${pw}px;height:${ph}px" />`;
  });

  return `<div id="root" data-composition-id="${opts.id}" data-start="0" data-duration="${round(t)}" data-width="${fw}" data-height="${fh}"
     style="width:${fw}px;height:${fh}px;position:relative;overflow:hidden;background:${esc(bg)}">
  <div id="cam" style="position:absolute;left:0;top:0;width:${fw}px;height:${fh}px;transform-origin:0 0">
    <div id="frame" style="position:absolute;left:${wx}px;top:${wy}px;width:${ww}px;height:${wh}px;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 30px 80px rgba(20,20,60,.25),0 0 0 1px rgba(0,0,0,.06)">
    <div id="win" data-page-width="${pw}" data-page-height="${ph}" data-page-scale="${round(fitScale)}"
         style="position:absolute;left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 0;transform:scale(${round(fitScale)})">
${imgs.join("\n")}
      <div id="ripple" style="position:absolute;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(${accent},.35);border:2px solid rgba(${accent},.8);opacity:0"></div>
      <svg id="cursor" width="30" height="30" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">
        <path d="M3 2l15 9.5-6.6 1.3L8 19.6z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
    </div>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
${KIT}
  </script>
</div>`;
}

// The kit. Plain ES5 in a string: it runs in the preview and the renderer,
// not in this Worker. Boxes are page pixels; the window may be scaled (k).
const KIT = `    // Screen-demo kit: builds the camera, cursor and click from each
    // .demo-step's timing and its data-focus / data-click boxes ("x,y,w,h" in
    // page pixels). Change the look around it; leave this as it is.
    (function () {
      var win = document.getElementById("win"), frame = document.getElementById("frame");
      var root = win.closest("[data-composition-id]");
      var FW = +root.dataset.width, FH = +root.dataset.height;
      var k = +win.dataset.pageScale || 1, PW = +win.dataset.pageWidth * k, PH = +win.dataset.pageHeight * k;
      var WX = frame.offsetLeft, WY = frame.offsetTop;
      var box = function (s) { if (!s) return null; var v = s.split(",").map(Number); return { x: v[0] * k, y: v[1] * k, w: v[2] * k, h: v[3] * k }; };
      var steps = [].slice.call(root.querySelectorAll(".demo-step")).map(function (el) {
        return { start: +el.dataset.start, end: +el.dataset.start + +el.dataset.duration, focus: box(el.dataset.focus), click: box(el.dataset.click) };
      }).sort(function (a, b) { return a.start - b.start; });
      // Zoom s centred on a window point, clamped so a zoomed-in window never
      // pulls away from the frame's edge.
      function cam(s, px, py) {
        var x = FW / 2 - s * (WX + px), y = FH / 2 - s * (WY + py);
        if (s * PW >= FW) x = Math.min(-s * WX, Math.max(FW - s * (WX + PW), x)); else x = (FW - s * PW) / 2 - s * WX;
        if (s * PH >= FH) y = Math.min(-s * WY, Math.max(FH - s * (WY + PH), y)); else y = (FH - s * PH) / 2 - s * WY;
        return { scale: s, x: x, y: y };
      }
      var fit = function (b) { return Math.min(2.2, Math.max(1.25, Math.min(0.7 * FW / b.w, 0.7 * FH / b.h))); };
      var tl = gsap.timeline({ paused: true });
      gsap.set("#cam", cam(1, PW / 2, PH / 2));
      gsap.set("#cursor", { x: PW * 0.62 / k, y: (PH + 40) / k });
      steps.forEach(function (st) {
        var t = st.start, f = st.focus;
        if (f) tl.to("#cam", Object.assign({ duration: 1.1, ease: "expo.inOut" }, cam(fit(f), f.x + f.w / 2, f.y + f.h / 2)), t + 0.3);
        else tl.to("#cam", Object.assign({ duration: 0.9, ease: "power3.inOut" }, cam(1, PW / 2, PH / 2)), t + 0.25);
        if (st.click) {
          var c = st.click, cx = c.x + c.w / 2, cy = c.y + c.h / 2, press = st.end - 0.3;
          var travel = Math.min(1.1, Math.max(0.5, press - t - 1.6));
          tl.to("#cam", Object.assign({ duration: travel + 0.2, ease: "sine.inOut" }, cam(1.35, cx, cy)), press - travel - 0.2);
          // The cursor and ripple live in the window, in page pixels.
          tl.to("#cursor", { x: cx / k, y: cy / k, duration: travel, ease: "power2.inOut" }, press - travel);
          tl.to("#cursor", { scale: 0.82, duration: 0.09, ease: "power1.in", yoyo: true, repeat: 1 }, press);
          tl.fromTo("#ripple", { x: cx / k, y: cy / k, scale: 0.2, opacity: 1 }, { scale: 1.5, opacity: 0, duration: 0.5, ease: "circ.out" }, press + 0.05);
        }
      });
      window.__timelines = window.__timelines || {};
      window.__timelines[root.dataset.compositionId] = tl;
    })();`;
