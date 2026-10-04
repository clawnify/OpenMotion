// A product demo in the style of a polished screen recording, built from one
// still per state of a real app: a cursor glides to a control and clicks it,
// drags an item, draws a connection or types, the page changes, and the camera
// zooms to what matters.
//
// Stills, not an <iframe> of the live app: the renderer can neither click
// inside an iframe nor rewind it, each render worker loads it afresh, and most
// apps refuse to be framed. Stills render the same every time, from any page
// that can be opened in a browser. Typing is real too: stills taken while the
// text went in, played over the step as it is typed. So is what the app does
// when clicked (a menu opening, a modal fading in): the capture records it as
// a short video, played from the moment the cursor presses.
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

/** From one box to another: a drag, or a connection drawn between two handles. */
export interface Move {
  from: Box;
  to: Box;
}

export interface ScreenDemoStep {
  /** The still, as `assets/<key>` (or any URL the renderer can load). */
  src: string;
  /** How long this state is on screen. */
  seconds: number;
  /** What to zoom to while this state is shown. */
  focus?: Box;
  // What the step does to reach the next state: at most one. The last step
  // usually has none.
  /** Click this. */
  click?: Box;
  /** Drag what is at `from` and drop it on `to` (a ghost follows the cursor). */
  drag?: Move;
  /** Draw a connection from `from` to `to`, e.g. between two node handles. */
  connect?: Move;
  /** Click into `box` and type: `frames` are stills taken while typing, in order. */
  type?: { box: Box; frames: string[] };
  /**
   * With `click`: what the page did after the click, as a video (`src`) that
   * starts the moment the click lands and lasts `seconds`. It plays over this
   * step's still and into the next one, which shows the state it settles on.
   */
  motion?: { src: string; seconds: number };
}

/**
 * Where the demo sits and what goes with it. A layout is a template for a
 * common shape, so nobody hand-edits the HTML for it:
 * - full: the demo fills the video (the default);
 * - split: the demo fills one half (`demo`: "top" or "bottom") and a video
 *   clip, typically a talking head, fills the other;
 * - pip: the demo fills the video and the clip sits in a round bubble in a corner.
 * The clip plays muted with its sound on a separate <audio> (HyperFrames'
 * rule), for `seconds` (its length).
 */
export type DemoLayout =
  | { kind: "full" }
  | { kind: "split"; demo: "top" | "bottom"; clip: string; seconds: number; position?: string }
  | { kind: "pip"; clip: string; seconds: number; corner?: "bottom-right" | "bottom-left" | "top-right" | "top-left"; position?: string };

export interface ScreenDemoOptions {
  id: string;
  steps: ScreenDemoStep[];
  /** The capture viewport in CSS pixels (the stills may be 2x that). */
  page?: { width: number; height: number };
  /** The video's size. */
  frame?: { width: number; height: number };
  /**
   * Show the app as a floating window (rounded corners, a shadow, a margin of
   * background around it). Off by default: the app fills the video edge to edge.
   */
  floating?: boolean;
  /**
   * How the app fills its area when the shapes differ: "contain" (default)
   * shows all of it with bars, "cover" fills the area and crops the overflow.
   */
  fit?: "contain" | "cover";
  /** CSS background around the app: behind the floating window, or in a letterbox. */
  background?: string;
  /** The click ripple and connection colour, as `r,g,b`. */
  accent?: string;
  /** Open with the app tilting in from 3D, and close with it tilting away. */
  tilt?: boolean;
  /** Where the demo sits and what goes with it (default: it fills the video). */
  layout?: DemoLayout;
  /**
   * The capture spec this demo was made from, kept inside the composition so
   * it can be captured again when the app changes (see demoSpecOf).
   */
  spec?: unknown;
}

/** The shortest step each action can play in: get there, then act. */
export const MIN_STEP = { click: 2, drag: 2.2, connect: 2.2, type: 2.5 } as const;
const ACTIONS = ["click", "drag", "connect", "type"] as const;
/** The kit presses a step's click this long before the step ends. */
export const PRESS_BEFORE_END = 0.3;

const round = (n: number) => Math.round(n * 1000) / 1000;
const boxAttr = (b: Box) => [b.x, b.y, b.w, b.h].map(Math.round).join(",");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const badSrc = (s: string) => !s || /["<>]/.test(s);

/** The steps' problems, as sentences; empty when the steps can be built. */
export function screenDemoProblems(opts: ScreenDemoOptions): string[] {
  const out: string[] = [];
  const { width: pw, height: ph } = opts.page ?? { width: 1600, height: 900 };
  const onPage = (b: Box) =>
    [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0 &&
    b.x + b.w > 0 && b.y + b.h > 0 && b.x < pw && b.y < ph;
  const box = (b: Box | undefined, name: string) => {
    if (b && !onPage(b)) out.push(`${name}: a box {x,y,w,h} on the ${pw}x${ph} page`);
  };
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(opts.id)) out.push("id: letters, digits and dashes only");
  if (opts.steps.length === 0) out.push("steps: at least one");
  if (opts.accent !== undefined && !/^\d{1,3},\d{1,3},\d{1,3}$/.test(opts.accent)) out.push("accent: r,g,b");
  const l = opts.layout;
  if (l && l.kind !== "full") {
    if (badSrc(l.clip)) out.push("layout.clip: an assets/<key> path");
    if (!(l.seconds > 0)) out.push("layout.seconds: above 0");
    if (l.position !== undefined && !/^\d{1,3}% \d{1,3}%$/.test(l.position)) out.push("layout.position: like \"50% 40%\"");
  }
  opts.steps.forEach((s, i) => {
    const n = `steps[${i}]`;
    if (badSrc(s.src)) out.push(`${n}.src: an assets/<key> path`);
    if (!(s.seconds > 0)) out.push(`${n}.seconds: above 0`);
    const acts = ACTIONS.filter((a) => s[a]);
    if (acts.length > 1) out.push(`${n}: one of ${ACTIONS.join(", ")} per step, not ${acts.join(" and ")}`);
    for (const a of acts) {
      if (s.seconds < MIN_STEP[a]) out.push(`${n}.seconds: at least ${MIN_STEP[a]} for a step with ${a}`);
    }
    box(s.focus, `${n}.focus`);
    box(s.click, `${n}.click`);
    for (const a of ["drag", "connect"] as const) {
      box(s[a]?.from, `${n}.${a}.from`);
      box(s[a]?.to, `${n}.${a}.to`);
    }
    if (s.type) {
      box(s.type.box, `${n}.type.box`);
      if (!s.type.frames.length) out.push(`${n}.type.frames: at least one`);
      if (s.type.frames.some(badSrc)) out.push(`${n}.type.frames: assets/<key> paths`);
    }
    if (s.motion) {
      if (!s.click) out.push(`${n}.motion: only with a click`);
      if (badSrc(s.motion.src)) out.push(`${n}.motion.src: an assets/<key> path`);
      if (!(s.motion.seconds > 0)) out.push(`${n}.motion.seconds: above 0`);
    }
  });
  return out;
}

/**
 * Step lengths spread over `total` seconds (a clip's length), in proportion,
 * never below what each step's action needs. When even the minimums are
 * longer than `total`, the minimums win and the clip holds its last frame.
 */
export function fitSeconds(lengths: number[], minimums: number[], total: number): number[] {
  const sum = lengths.reduce((a, b) => a + b, 0);
  if (!(total > 0) || sum <= 0) return lengths;
  let out = lengths.map((l) => (l * total) / sum);
  // Lift the steps that fell below their minimum and take the time from the rest.
  for (let pass = 0; pass < lengths.length; pass++) {
    const short = out.map((l, i) => l < minimums[i]);
    if (!short.some(Boolean)) break;
    const fixed = out.reduce((a, l, i) => a + (short[i] ? minimums[i] : 0), 0);
    const freeSum = lengths.reduce((a, l, i) => a + (short[i] ? 0 : l), 0);
    const left = total - fixed;
    if (left <= 0 || freeSum <= 0) return out.map((l, i) => Math.max(l, minimums[i]));
    out = out.map((l, i) => (short[i] ? minimums[i] : (lengths[i] * left) / freeSum));
  }
  return out.map((l) => Math.round(l * 1000) / 1000);
}

/** The shortest a step can be for its action (0 for a step without one). */
export function minimumSeconds(step: { click?: unknown; drag?: unknown; connect?: unknown; type?: unknown }): number {
  return step.type ? MIN_STEP.type : step.drag ? MIN_STEP.drag : step.connect ? MIN_STEP.connect : step.click ? MIN_STEP.click : 0.5;
}

/** How long a step lasts when the spec does not say: long enough for its action. */
export function defaultSeconds(step: { click?: unknown; drag?: unknown; connect?: unknown; type?: unknown }, last: boolean): number {
  if (step.type) return 4.5;
  if (step.drag || step.connect) return 3.4;
  if (step.click) return 3.5;
  return last ? 3 : 2.5;
}

const SPEC_TAG = /<script type="application\/json" id="demo-spec">([\s\S]*?)<\/script>/;

/** The composition with its carried capture spec replaced (or added before the GSAP script). */
export function withDemoSpec(html: string, spec: unknown): string {
  const tag = `<script type="application/json" id="demo-spec">${JSON.stringify(spec).replace(/</g, "\\u003c")}</script>`;
  if (SPEC_TAG.test(html)) return html.replace(SPEC_TAG, () => tag);
  return html.replace(/( *)<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/gsap/, (m, indent) => `${indent}${tag}\n${m}`);
}

/** The capture spec a demo composition carries, or null. */
export function demoSpecOf(html: string): unknown {
  const m = SPEC_TAG.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** When typing starts and ends inside a step: after the cursor has got there and clicked. */
export function typingWindow(start: number, seconds: number): [number, number] {
  return [start + 1.1, start + seconds - 0.4];
}

export function screenDemoHtml(opts: ScreenDemoOptions): string {
  const { width: pw, height: ph } = opts.page ?? { width: 1600, height: 900 };
  const { width: fw, height: fh } = opts.frame ?? { width: 1920, height: 1080 };
  const accent = opts.accent ?? "224,82,104";
  const bg = opts.background ?? (opts.floating ? "linear-gradient(135deg,#f6d5dc,#dfe3f7)" : "#000");
  // Where the window sits is worked out by the kit from the root's size when
  // it plays (see KIT), so changing the video's format refits a demo exactly.
  const windowLook = opts.floating
    ? "border-radius:14px;box-shadow:0 30px 80px rgba(20,20,60,.25),0 0 0 1px rgba(0,0,0,.06);"
    : "";
  const fill = `position:absolute;left:0;top:0;width:${pw}px;height:${ph}px`;

  const steps = stepsHtml(opts.steps, { width: pw, height: ph });
  let t = steps.end;

  const layout = opts.layout ?? { kind: "full" as const };
  const { open, close, clip } = layoutParts(layout, { width: fw, height: fh });
  if (layout.kind !== "full") t = Math.max(t, layout.seconds);

  return `<div id="root" data-composition-id="${opts.id}" data-start="0" data-duration="${round(t)}" data-width="${fw}" data-height="${fh}"
     style="width:${fw}px;height:${fh}px;position:relative;overflow:hidden;background:${esc(bg)}">
${open}  <div id="cam" style="position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0">
    <div id="frame" style="position:absolute;overflow:hidden;background:#fff;${windowLook}">
    <div id="win" data-page-width="${pw}" data-page-height="${ph}" data-accent="${accent}"${opts.floating ? ` data-floating="1"` : ""}${opts.fit === "cover" ? ` data-fit="cover"` : ""}${opts.tilt ? ` data-tilt="1"` : ""}
         style="position:absolute;left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 0">
${steps.html}
      <div id="ripple" style="position:absolute;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(${accent},.35);border:2px solid rgba(${accent},.8);opacity:0"></div>
      <svg id="cursor" width="30" height="30" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">
        <path d="M3 2l15 9.5-6.6 1.3L8 19.6z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
    </div>
    </div>
  </div>
${close}${clip}${opts.spec === undefined ? "" : `  <script type="application/json" id="demo-spec">${JSON.stringify(opts.spec).replace(/</g, "\\u003c")}</script>\n`}  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
${KIT}
  </script>
</div>`;
}

/**
 * A layout's pieces: the area the demo fills (the kit fits the demo to #cam's
 * parent) and the clip that goes with it, video muted with its sound on a
 * separate <audio>. Split halves are percentages, so they follow a later
 * change of format. Marked so applyLayout can find and replace them.
 */
export function layoutParts(layout: DemoLayout, frame: { width: number; height: number }): { open: string; close: string; clip: string } {
  if (layout.kind === "full") return { open: "", close: "", clip: "" };
  const at = `data-start="0" data-duration="${round(layout.seconds)}"`;
  const pos = `object-fit:cover;object-position:${layout.position ?? "50% 45%"}`;
  let open = "", close = "", box: string;
  if (layout.kind === "split") {
    const top = layout.demo === "top";
    open = `  <div id="demo-area" style="position:absolute;left:0;top:${top ? "0" : "50%"};width:100%;height:50%;overflow:hidden">\n`;
    close = `  </div><!-- /demo-area -->\n`;
    box = `left:0;top:${top ? "50%" : "0"};width:100%;height:50%`;
  } else {
    const d = Math.round(Math.min(frame.width, frame.height) * 0.3), m = Math.round(Math.min(frame.width, frame.height) * 0.04);
    const [v, h] = (layout.corner ?? "bottom-right").split("-");
    box = `${h}:${m}px;${v}:${m}px;width:${d}px;height:${d}px;border-radius:50%;border:6px solid #fff;box-shadow:0 12px 40px rgba(0,0,0,.35);z-index:5`;
  }
  const clip =
    `  <!-- layout-clip -->\n` +
    `  <video id="clip" src="${esc(layout.clip)}" class="clip" ${at} data-track-index="2" muted playsinline\n` +
    `         style="position:absolute;${box};${pos}"></video>\n` +
    `  <audio id="clip-audio" src="${esc(layout.clip)}" class="clip" ${at} data-track-index="3" data-volume="1"></audio>\n` +
    `  <!-- /layout-clip -->\n`;
  return { open, close, clip };
}

const STEPS_OPEN = "      <!-- demo-steps -->";
const STEPS_CLOSE = "      <!-- /demo-steps -->";

/**
 * The demo's stills as clips, from `startAt`, between markers a refresh
 * replaces (see replaceDemoSteps). Typing stills are clips over their step.
 * A click's motion video comes after every still, so it plays on top of the
 * next one as well, and starts at the press (the kit presses PRESS_BEFORE_END
 * before the step ends).
 */
export function stepsHtml(
  steps: ScreenDemoStep[],
  page: { width: number; height: number },
  startAt = 0,
): { html: string; end: number } {
  const fill = `position:absolute;left:0;top:0;width:${page.width}px;height:${page.height}px`;
  let t = startAt;
  const imgs: string[] = [];
  const motions: string[] = [];
  steps.forEach((s, i) => {
    const attrs = [
      `id="step${i + 1}"`,
      `src="${esc(s.src)}"`,
      `class="clip demo-step"`,
      `data-start="${round(t)}"`,
      `data-duration="${round(s.seconds)}"`,
      `data-track-index="0"`,
      s.focus ? `data-focus="${boxAttr(s.focus)}"` : "",
      s.click ? `data-click="${boxAttr(s.click)}"` : "",
      s.drag ? `data-drag-from="${boxAttr(s.drag.from)}" data-drag-to="${boxAttr(s.drag.to)}"` : "",
      s.connect ? `data-connect-from="${boxAttr(s.connect.from)}" data-connect-to="${boxAttr(s.connect.to)}"` : "",
      s.type ? `data-type="${boxAttr(s.type.box)}"` : "",
    ].filter(Boolean).join(" ");
    imgs.push(`      <img ${attrs}\n           style="${fill}" />`);
    // Typing: each still taken while typing is its own clip over the step, so
    // the preview and the render both show the one for the moment.
    if (s.type) {
      const [from, to] = typingWindow(t, s.seconds);
      const n = s.type.frames.length, slice = (to - from) / n;
      s.type.frames.forEach((src, j) => {
        const at = from + j * slice;
        const until = j === n - 1 ? t + s.seconds : at + slice;
        imgs.push(
          `      <img id="step${i + 1}-typed${j + 1}" src="${esc(src)}" class="clip demo-typed" data-start="${round(at)}" data-duration="${round(until - at)}" data-track-index="1"\n           style="${fill}" />`,
        );
      });
    }
    if (s.motion && s.click) {
      // At least until the next still: a motion shorter than the wait would
      // let this step's own still (the state before the click) flash back.
      // Past its end a video holds its last frame.
      const at = Math.max(t, t + s.seconds - PRESS_BEFORE_END);
      const seconds = Math.max(s.motion.seconds, t + s.seconds - at);
      motions.push(
        `      <video id="step${i + 1}-motion" src="${esc(s.motion.src)}" class="clip demo-motion" data-start="${round(at)}" data-duration="${round(seconds)}" data-track-index="1" muted playsinline\n           style="${fill}"></video>`,
      );
    }
    t += s.seconds;
  });
  return { html: [STEPS_OPEN, ...imgs, ...motions, STEPS_CLOSE].join("\n"), end: t };
}

/** Where the stills sit in a demo's HTML, with or without markers (demos made before them). */
function stepsSpan(html: string): { from: number; to: number } | null {
  const open = html.indexOf(STEPS_OPEN), close = html.indexOf(STEPS_CLOSE);
  if (open >= 0 && close > open) return { from: open, to: close + STEPS_CLOSE.length };
  const first = /^ *<img id="step1"/m.exec(html);
  const ripple = /^ *<div id="ripple"/m.exec(html);
  if (!first || !ripple || ripple.index < first.index) return null;
  return { from: first.index, to: ripple.index - 1 };
}

/** When each still is on screen now, in order, as the user may have retimed them. */
export function demoStepTimes(html: string): { start: number; seconds: number }[] {
  return [...html.matchAll(/<img id="step\d+"[^>]*class="clip demo-step"[^>]*>/g)].map((m) => ({
    start: Number(/data-start="([\d.]+)"/.exec(m[0])?.[1] ?? 0),
    seconds: Number(/data-duration="([\d.]+)"/.exec(m[0])?.[1] ?? 0),
  }));
}

/**
 * The demo with new stills (a refresh), and nothing else changed: its layout,
 * clips, titles and look stay as they are. With as many steps as before, each
 * keeps the start and length it has now; otherwise the new steps run on from
 * where the first one starts. The video grows if the steps now end later.
 * Null when the HTML holds no demo stills.
 */
export function replaceDemoSteps(
  html: string,
  steps: ScreenDemoStep[],
  page: { width: number; height: number },
  opts: { reflow?: boolean } = {},
): string | null {
  const span = stepsSpan(html);
  if (!span) return null;
  const times = demoStepTimes(html);
  // reflow: lay the steps end to end at their own lengths (a layout fitting them to a clip).
  const same = times.length === steps.length && !opts.reflow;
  let block: string, end: number;
  if (same) {
    // Each step at its own start: render one by one so retimed gaps survive.
    const parts = steps.map((s, i) => stepsHtml([{ ...s, seconds: times[i].seconds }], page, times[i].start));
    const inner = parts.map((p, i) =>
      p.html.split("\n").slice(1, -1).join("\n").replace(/id="step1(-typed\d+|-motion)?"/g, (_m, typed) => `id="step${i + 1}${typed ?? ""}"`),
    );
    block = [STEPS_OPEN, ...inner, STEPS_CLOSE].join("\n");
    end = Math.max(...parts.map((p) => p.end));
  } else {
    const r = stepsHtml(steps, page, times[0]?.start ?? 0);
    block = r.html;
    end = r.end;
  }
  let out = html.slice(0, span.from) + block + html.slice(span.to);
  const root = /(<[^>]*data-composition-id[^>]*data-duration=")([\d.]+)(")/.exec(out);
  if (root && Number(root[2]) < end) out = out.replace(root[0], `${root[1]}${round(end)}${root[3]}`);
  return out;
}

const box4 = (v: string | undefined): Box | undefined => {
  if (!v) return undefined;
  const [x, y, w, h] = v.split(",").map(Number);
  return { x, y, w, h };
};

/** The demo's steps read back from its HTML: stills, timing, boxes and typing stills. */
export function demoStepsOf(html: string): ScreenDemoStep[] {
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return [...html.matchAll(/<img id="step(\d+)"[^>]*class="clip demo-step"[^>]*>/g)].map((m) => {
    const tag = m[0], n = m[1];
    const from = box4(attr(tag, "data-drag-from")), to = box4(attr(tag, "data-drag-to"));
    const cfrom = box4(attr(tag, "data-connect-from")), cto = box4(attr(tag, "data-connect-to"));
    const typeBox = box4(attr(tag, "data-type"));
    const frames = [...html.matchAll(new RegExp(`<img id="step${n}-typed\\d+" src="([^"]*)"`, "g"))].map((f) => f[1]);
    const motion = new RegExp(`<video id="step${n}-motion"[^>]*>`).exec(html)?.[0];
    return {
      src: attr(tag, "src") ?? "",
      seconds: Number(attr(tag, "data-duration") ?? 0),
      focus: box4(attr(tag, "data-focus")),
      click: box4(attr(tag, "data-click")),
      drag: from && to ? { from, to } : undefined,
      connect: cfrom && cto ? { from: cfrom, to: cto } : undefined,
      type: typeBox ? { box: typeBox, frames } : undefined,
      motion: motion ? { src: attr(motion, "src") ?? "", seconds: Number(attr(motion, "data-duration") ?? 0) } : undefined,
    };
  });
}

/** Index just past the </div> that closes the <div at `from`. */
function divEnd(html: string, from: number): number {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * The demo in another layout, once: whatever layout it has (its area and
 * clip) is taken out, the new one put in, and with a clip the steps are
 * spread over the clip's length so both end together. Everything else, titles
 * included, stays. A split fills each half (fit cover). Null when the HTML
 * holds no demo. After this the composition is ordinary HTML again.
 */
export function applyLayout(html: string, layout: DemoLayout): string | null {
  if (!/<div id="cam"/.test(html) || !stepsSpan(html)) return null;
  let out = html
    .replace(/ *<!-- layout-clip -->[\s\S]*?<!-- \/layout-clip -->\n?/, "")
    .replace(/ *<video id="clip"[\s\S]*?<\/video>\n?/, "")
    .replace(/ *<audio id="clip-audio"[^>]*><\/audio>\n?/, "");
  const area = out.indexOf('<div id="demo-area"');
  if (area >= 0) {
    const end = divEnd(out, area);
    const lineStart = out.lastIndexOf("\n", area) + 1;
    const innerFrom = out.indexOf(">", area) + 1;
    const inner = out.slice(innerFrom, end - "</div>".length).replace(/^\n/, "").replace(/ *$/, "");
    const after = out.slice(end).replace(/^<!-- \/demo-area -->/, "").replace(/^\n/, "");
    out = out.slice(0, lineStart) + inner + after;
  }

  const width = Number(/data-width="(\d+)"/.exec(out)?.[1] ?? 1920), height = Number(/data-height="(\d+)"/.exec(out)?.[1] ?? 1080);
  const { open, close, clip } = layoutParts(layout, { width, height });
  const cam = out.indexOf('<div id="cam"');
  const camLine = out.lastIndexOf("\n", cam) + 1;
  const camEnd = divEnd(out, cam);
  const camEndLine = out.indexOf("\n", camEnd) + 1 || out.length;
  out = out.slice(0, camLine) + open + out.slice(camLine, camEndLine) + close + clip + out.slice(camEndLine);

  if (layout.kind !== "full") {
    const page = {
      width: Number(/data-page-width="(\d+)"/.exec(out)?.[1] ?? 1600),
      height: Number(/data-page-height="(\d+)"/.exec(out)?.[1] ?? 900),
    };
    const steps = demoStepsOf(out);
    const fitted = fitSeconds(steps.map((st) => st.seconds), steps.map((st) => minimumSeconds(st)), layout.seconds);
    out = replaceDemoSteps(out, steps.map((st, i) => ({ ...st, seconds: fitted[i] })), page, { reflow: true }) ?? out;
    const times = demoStepTimes(out);
    const last = times[times.length - 1];
    const length = Math.max(layout.seconds, last ? last.start + last.seconds : 0);
    out = out.replace(/(<[^>]*data-composition-id[^>]*data-duration=")[\d.]+(")/, `$1${round(length)}$2`);
    if (layout.kind === "split" && !/<div id="win"[^>]*data-fit=/.test(out)) {
      out = out.replace(/(<div id="win"[^>]*?)(\s*\n\s*style=|\s+style=)/, '$1 data-fit="cover"$2');
    }
  }
  return out;
}

// The kit. Plain ES5 in a string: it runs in the preview and the renderer,
// not in this Worker. Everything is in page pixels; only the camera turns them
// into frame pixels (k is the window's scale in the frame).
//
// The cursor moves like a hand (ported from TaskWindow's extension/tools/
// human.js): Fitts's Law sets how long a move takes for its distance and
// target size, the path bows to one side, speed follows the minimum-jerk bell
// (slow, fast, slow), a far small target is overshot and corrected, and the
// press comes after a short settle and dwell. The randomness is seeded, so
// every render of the same composition moves the same way.
const KIT = `    // Screen-demo kit: builds the camera, cursor and actions from each
    // .demo-step's timing and its boxes ("x,y,w,h" in page pixels): data-focus,
    // and one of data-click, data-drag-from/-to, data-connect-from/-to,
    // data-type. Change the look around it; leave this as it is.
    (function () {
      var win = document.getElementById("win"), frame = document.getElementById("frame");
      var root = win.closest("[data-composition-id]");
      // The demo fills the element #cam sits in: the whole video by default,
      // or any area a layout gives it (the top half above a talking head).
      var area = document.getElementById("cam").parentElement;
      var FW = area.offsetWidth || +root.dataset.width, FH = area.offsetHeight || +root.dataset.height, LEN = +root.dataset.duration;
      var PW = +win.dataset.pageWidth, PH = +win.dataset.pageHeight, accent = win.dataset.accent || "224,82,104";
      // Fit the page to its area: edge to edge (bars if the shapes differ, or
      // cropped with data-fit="cover"), or floating at 1:1 with a margin.
      var k = win.dataset.floating ? Math.min(1, 0.9 * FW / PW, 0.9 * FH / PH)
        : win.dataset.fit === "cover" ? Math.max(FW / PW, FH / PH) : Math.min(FW / PW, FH / PH);
      var WX = Math.round((FW - PW * k) / 2), WY = Math.round((FH - PH * k) / 2);
      frame.style.left = WX + "px"; frame.style.top = WY + "px";
      frame.style.width = Math.round(PW * k) + "px"; frame.style.height = Math.round(PH * k) + "px";
      win.style.transform = "scale(" + k + ")";
      var box = function (s) { if (!s) return null; var v = s.split(",").map(Number); return { x: v[0], y: v[1], w: v[2], h: v[3] }; };
      var mid = function (b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
      var span = function (a, b) { var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x: x, y: y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
      var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
      var steps = [].slice.call(root.querySelectorAll(".demo-step")).map(function (el) {
        var d = el.dataset;
        return { el: el, start: +d.start, end: +d.start + +d.duration, focus: box(d.focus), click: box(d.click), type: box(d.type),
                 dragFrom: box(d.dragFrom), dragTo: box(d.dragTo), linkFrom: box(d.connectFrom), linkTo: box(d.connectTo) };
      }).sort(function (a, b) { return a.start - b.start; });

      // Seeded randomness (mulberry32): a hand's variety, identical every render.
      var seed = 1 + steps.length * 7919;
      var rnd = function () { seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      var rand = function (lo, hi) { return lo + rnd() * (hi - lo); };

      // Zoom s centred on a page point, clamped so a zoomed-in window never
      // pulls away from the frame's edge.
      function cam(s, px, py) {
        var w = PW * k, h = PH * k, x = FW / 2 - s * (WX + px * k), y = FH / 2 - s * (WY + py * k);
        if (s * w >= FW) x = Math.min(-s * WX, Math.max(FW - s * (WX + w), x)); else x = (FW - s * w) / 2 - s * WX;
        if (s * h >= FH) y = Math.min(-s * WY, Math.max(FH - s * (WY + h), y)); else y = (FH - s * h) / 2 - s * WY;
        return { scale: s, x: x, y: y };
      }
      var fit = function (b) { return Math.min(2.2, Math.max(1.25, Math.min(0.7 * FW / (b.w * k), 0.7 * FH / (b.h * k)))); };
      var fitWide = function (b) { return Math.min(2.2, Math.max(1, Math.min(0.75 * FW / (b.w * k), 0.75 * FH / (b.h * k)))); };
      var tl = gsap.timeline({ paused: true });
      var camTo = function (at, dur, ease, s, p) { tl.to("#cam", Object.assign({ duration: dur, ease: ease }, cam(s, p.x, p.y)), at); };

      // ---- The hand. Fitts's Law time, a one-sided bow, minimum-jerk speed,
      // overshoot-and-correct on a far small target. PACE slows a real hand a
      // little so a viewer can follow it.
      var PACE = 1.5, cur = { x: PW * 0.62, y: PH + 40 };
      var fittsIndex = function (d, w) { return Math.log2(2 * Math.max(d, 1) / Math.max(w, 1)); };
      var moveTime = function (d, w) { return PACE * clamp(rand(0.8, 1.25) * (60 + 130 * Math.max(fittsIndex(d, w), 0)), 80, 1400) / 1000; };
      var minJerk = function (t) { return t * t * t * (10 + t * (-15 + 6 * t)); };
      var bez = function (p0, p1, p2, p3, t) { var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t; return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }; };
      // The points of one move from where the cursor is to "to", ending exactly on it.
      function path(to, w, dur) {
        var from = cur, dx = to.x - from.x, dy = to.y - from.y, dist = Math.sqrt(dx * dx + dy * dy);
        var bow = (rnd() < 0.5 ? 1 : -1) * dist * rand(0.04, 0.16), nx = dist ? -dy / dist : 0, ny = dist ? dx / dist : 0;
        var c1 = { x: from.x + dx * 0.3 + nx * bow * rand(0.6, 1), y: from.y + dy * 0.3 + ny * bow * rand(0.6, 1) };
        var c2 = { x: from.x + dx * 0.7 + nx * bow * rand(0.6, 1), y: from.y + dy * 0.7 + ny * bow * rand(0.6, 1) };
        var over = fittsIndex(dist, w) > 3.5 && rnd() < 0.65;
        var aim = over ? { x: to.x + dx * rand(0.02, 0.07), y: to.y + dy * rand(0.02, 0.07) } : to;
        var n = clamp(Math.round(dur / 0.04), 6, 40), main = over ? dur * 0.85 : dur, pts = [];
        for (var i = 1; i <= n; i++) { var p = bez(from, c1, c2, aim, minJerk(i / n)); pts.push({ x: p.x, y: p.y, dt: main / n }); }
        if (over) { var back = 3, s0 = pts[pts.length - 1]; for (var j = 1; j <= back; j++) { var q = minJerk(j / back); pts.push({ x: s0.x + (to.x - s0.x) * q, y: s0.y + (to.y - s0.y) * q, dt: (dur - main) / back }); } }
        pts[pts.length - 1].x = to.x; pts[pts.length - 1].y = to.y;
        cur = { x: to.x, y: to.y };
        return pts;
      }
      // Move the cursor (and anything it carries) along a path from time "at".
      // "carry": elements that follow with an offset, or a function of the point.
      function move(pts, at, carry) {
        tl.to("#cursor", { keyframes: pts.map(function (p) { return { x: p.x, y: p.y, duration: p.dt, ease: "none" }; }) }, at);
        (carry || []).forEach(function (c) { tl.to(c.el, { keyframes: pts.map(function (p) { return Object.assign({ duration: p.dt, ease: "none" }, c.at(p)); }) }, at); });
        return at + pts.reduce(function (a, p) { return a + p.dt; }, 0);
      }
      // Arrive on a target so the press lands at "press": travel, settle, dwell.
      // Returns when the travel starts (the camera may want to lead it).
      function reach(b, press) {
        var to = { x: b.x + b.w / 2 + clamp(rand(-0.15, 0.15) * b.w, -3, 3), y: b.y + b.h / 2 + clamp(rand(-0.15, 0.15) * b.h, -3, 3) };
        var dist = Math.sqrt(Math.pow(to.x - cur.x, 2) + Math.pow(to.y - cur.y, 2));
        var dwell = rand(0.06, 0.18), settle = rand(0.03, 0.06), dur = moveTime(dist, b.w);
        var start = press - dwell - settle - dur;
        var arrive = move(path(to, b.w, dur), start);
        tl.to("#cursor", { x: to.x + rand(-1.2, 1.2), y: to.y + rand(-1.2, 1.2), duration: settle, ease: "none" }, arrive);
        tl.to("#cursor", { x: to.x, y: to.y, duration: 0.02, ease: "none" }, arrive + settle);
        return { start: start, point: to };
      }
      var press = function (at, hold) { tl.to("#cursor", { scale: 0.82, duration: 0.06, ease: "power1.in" }, at); tl.to("#cursor", { scale: 1, duration: 0.08, ease: "power1.out" }, at + (hold || rand(0.055, 0.11))); };
      var ripple = function (p, at) { tl.fromTo("#ripple", { x: p.x, y: p.y, scale: 0.2, opacity: 1 }, { scale: 1.5, opacity: 0, duration: 0.5, ease: "circ.out" }, at); };
      // An element the kit draws over the page (a drag ghost, a connection).
      var layer = function (css) { var el = document.createElement("div"); el.style.cssText = "position:absolute;left:0;top:0;opacity:0;pointer-events:none;" + css; win.insertBefore(el, document.getElementById("ripple")); return el; };

      gsap.set("#cam", cam(1, PW / 2, PH / 2));
      gsap.set("#cursor", { x: cur.x, y: cur.y });
      // data-tilt: open and close in 3D, the window tilting in and away.
      if (win.dataset.tilt) {
        gsap.set(frame, { transformPerspective: 2400, transformOrigin: "50% 50%" });
        tl.from(frame, { rotationX: 28, rotationY: -18, rotationZ: 4, scale: 0.72, y: 60, opacity: 0, duration: 1.1, ease: "expo.out" }, 0);
        if (LEN > 4) tl.to(frame, { rotationX: 30, rotationY: 20, rotationZ: -6, scale: 0.62, y: -40, opacity: 0, duration: 0.7, ease: "power3.in" }, LEN - 0.7);
      }

      steps.forEach(function (st) {
        var t = st.start, end = st.end;
        var pair = st.dragFrom && st.dragTo ? span(st.dragFrom, st.dragTo) : st.linkFrom && st.linkTo ? span(st.linkFrom, st.linkTo) : null;
        var f = st.focus || st.type;
        if (f) camTo(t + 0.3, 1.1, "expo.inOut", fit(f), mid(f));
        else if (pair) camTo(t + 0.2, 1, "power3.inOut", fitWide(pair), mid(pair));
        else camTo(t + 0.25, 0.9, "power3.inOut", 1, { x: PW / 2, y: PH / 2 });
        if (st.click) {
          var at = end - ${PRESS_BEFORE_END}, r = reach(st.click, at);
          camTo(Math.max(t + 1.4, r.start - 0.2), Math.max(0.4, at - Math.max(t + 1.4, r.start - 0.2)), "sine.inOut", 1.35, mid(st.click));
          press(at); ripple(r.point, at + 0.03);
        }
        if (st.type) {
          var rt = reach(st.type, t + 0.95);
          press(t + 0.95); ripple(rt.point, t + 0.98);
        }
        if (st.dragFrom && st.dragTo) {
          var g = reach(st.dragFrom, t + 0.95), grab = t + 0.95, drop = end - 0.35, fd = st.dragFrom;
          // The ghost is the dragged item cut out of this step's own still,
          // held where it was grabbed and carried along the same path.
          var ghost = layer("width:" + fd.w + "px;height:" + fd.h + "px;border-radius:8px;box-shadow:0 12px 30px rgba(0,0,0,.18);" +
            "background:url(" + JSON.stringify(st.el.getAttribute("src")) + ") no-repeat -" + fd.x + "px -" + fd.y + "px/" + PW + "px " + PH + "px");
          var ox = fd.x - g.point.x, oy = fd.y - g.point.y, b = mid(st.dragTo);
          gsap.set(ghost, { x: fd.x, y: fd.y });
          tl.to("#cursor", { scale: 0.85, duration: 0.08, ease: "power1.in" }, grab);
          tl.to(ghost, { opacity: 0.9, duration: 0.15 }, grab);
          var dist = Math.sqrt(Math.pow(b.x - cur.x, 2) + Math.pow(b.y - cur.y, 2));
          move(path(b, st.dragTo.w + 40, Math.max(0.6, Math.min(drop - grab - 0.15, moveTime(dist, 80) * 1.3))), grab + 0.12,
               [{ el: ghost, at: function (p) { return { x: p.x + ox, y: p.y + oy }; } }]);
          tl.to("#cursor", { scale: 1, duration: 0.08 }, drop);
          tl.to(ghost, { opacity: 0, duration: 0.12 }, drop);
        }
        if (st.linkFrom && st.linkTo) {
          var h = reach(st.linkFrom, t + 0.95), hold = t + 0.95, letGo = end - 0.35, s0 = h.point, s1 = mid(st.linkTo);
          // A dashed line from the handle to wherever the cursor is.
          var line = layer("width:1px;height:0;border-top:2px dashed rgb(" + accent + ");transform-origin:0 50%");
          gsap.set(line, { x: s0.x, y: s0.y - 1, scaleX: 0 });
          tl.to("#cursor", { scale: 0.85, duration: 0.08, ease: "power1.in" }, hold);
          tl.to(line, { opacity: 1, duration: 0.1 }, hold);
          var dl = Math.sqrt(Math.pow(s1.x - s0.x, 2) + Math.pow(s1.y - s0.y, 2));
          move(path(s1, st.linkTo.w, Math.max(0.6, Math.min(letGo - hold - 0.15, moveTime(dl, st.linkTo.w) * 1.3))), hold + 0.12,
               [{ el: line, at: function (p) { var ddx = p.x - s0.x, ddy = p.y - s0.y; return { scaleX: Math.sqrt(ddx * ddx + ddy * ddy), rotation: Math.atan2(ddy, ddx) * 180 / Math.PI }; } }]);
          tl.to("#cursor", { scale: 1, duration: 0.08 }, letGo);
          tl.to(line, { opacity: 0, duration: 0.1 }, end);
        }
      });
      window.__timelines = window.__timelines || {};
      window.__timelines[root.dataset.compositionId] = tl;
    })();`;
