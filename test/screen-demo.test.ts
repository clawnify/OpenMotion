// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenDemoHtml, screenDemoProblems, typingWindow, defaultSeconds, demoSpecOf, fitSeconds, replaceDemoSteps, demoStepTimes, withDemoSpec, type ScreenDemoOptions } from "../src/shared/screen-demo.ts";
import { compositionLength } from "../src/shared/length.ts";

const demo: ScreenDemoOptions = {
  id: "demo-1",
  steps: [
    { src: "assets/a.png", seconds: 4, focus: { x: 616.4, y: 250, w: 670, h: 330 }, click: { x: 1316, y: 55, w: 70, h: 28 } },
    { src: "assets/b.png", seconds: 3.5, click: { x: 26, y: 324, w: 240, h: 28 } },
    { src: "assets/c.png", seconds: 2.5 },
  ],
};

test("steps follow each other with no gap, and the video ends where the last does", () => {
  const html = screenDemoHtml(demo);
  const starts = [...html.matchAll(/class="clip demo-step" data-start="([\d.]+)" data-duration="([\d.]+)"/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(starts, [[0, 4], [4, 3.5], [7.5, 2.5]]);
  assert.match(html, /data-composition-id="demo-1" data-start="0" data-duration="10"/);
  assert.equal(compositionLength(html), 10);
});

test("boxes are written as whole page pixels, and only where given", () => {
  const html = screenDemoHtml(demo);
  assert.match(html, /id="step1"[^>]*data-focus="616,250,670,330" data-click="1316,55,70,28"/);
  assert.doesNotMatch(html, /id="step2"[^>]*data-focus/);
  assert.doesNotMatch(html, /id="step3"[^>]*data-click/);
});

test("the timeline is registered under the composition's id", () => {
  assert.match(screenDemoHtml(demo), /window\.__timelines\[root\.dataset\.compositionId\] = tl/);
});

test("by default the app fills the video: no window, shadow or margin; the kit fits it at play time", () => {
  const html = screenDemoHtml(demo);
  const frame = html.match(/id="frame" style="[^"]*"/)![0];
  assert.doesNotMatch(frame, /box-shadow|border-radius|left:|width:/);
  assert.doesNotMatch(html, /data-floating="1"/);
  assert.match(html, /data-width="1920" data-height="1080"/);
  assert.match(html, /frame\.style\.left = WX/);
});

test("floating: a rounded window with a shadow and background around it", () => {
  const html = screenDemoHtml({ ...demo, floating: true });
  assert.match(html, /data-floating="1"/);
  assert.match(html.match(/id="frame" style="[^"]*"/)![0], /border-radius:14px;box-shadow/);
  assert.match(html, /linear-gradient/);
  assert.match(screenDemoHtml({ ...demo, frame: { width: 1080, height: 1920 } }), /data-width="1080" data-height="1920"/);
});

test("valid steps have no problems", () => {
  assert.deepEqual(screenDemoProblems(demo), []);
});

test("a click step too short for the kit, a box off the page and a bad src are named", () => {
  const problems = screenDemoProblems({
    id: "demo-1",
    steps: [
      { src: "assets/a.png", seconds: 1, click: { x: 10, y: 10, w: 5, h: 5 } },
      { src: "assets/b.png", seconds: 3, focus: { x: 1700, y: 10, w: 5, h: 5 } },
      { src: 'x" onerror="alert(1)', seconds: 2 },
    ],
  });
  assert.deepEqual(problems, [
    "steps[0].seconds: at least 2 for a step with click",
    "steps[1].focus: a box {x,y,w,h} on the 1600x900 page",
    "steps[2].src: an assets/<key> path",
  ]);
});

test("a bad id, no steps and a bad accent are named", () => {
  assert.deepEqual(screenDemoProblems({ id: "a b", steps: [], accent: "red" }), [
    "id: letters, digits and dashes only",
    "steps: at least one",
    "accent: r,g,b",
  ]);
});

test("the background cannot close the style attribute", () => {
  const html = screenDemoHtml({ ...demo, background: '#fff" onload="x' });
  assert.match(html, /background:#fff&quot; onload=&quot;x"/);
});

test("drag and connect write both boxes; type writes its box and one clip per typed still", () => {
  const html = screenDemoHtml({
    id: "flow",
    steps: [
      { src: "assets/1.png", seconds: 3, drag: { from: { x: 287, y: 127, w: 235, h: 55 }, to: { x: 699, y: 559, w: 2, h: 2 } } },
      { src: "assets/2.png", seconds: 4.5, type: { box: { x: 706, y: 600, w: 212, h: 64 }, frames: ["assets/t1.png", "assets/t2.png", "assets/t3.png"] } },
      { src: "assets/3.png", seconds: 3, connect: { from: { x: 981, y: 611, w: 10, h: 10 }, to: { x: 991, y: 388, w: 10, h: 10 } } },
      { src: "assets/4.png", seconds: 2 },
    ],
  });
  assert.match(html, /id="step1"[^>]*data-drag-from="287,127,235,55" data-drag-to="699,559,2,2"/);
  assert.match(html, /id="step3"[^>]*data-connect-from="981,611,10,10" data-connect-to="991,388,10,10"/);
  assert.match(html, /id="step2"[^>]*data-type="706,600,212,64"/);
  // Typed stills share the typing window in order; the last holds to the step's end.
  const typed = [...html.matchAll(/id="step2-typed(\d)" src="([^"]+)" class="clip demo-typed" data-start="([\d.]+)" data-duration="([\d.]+)"/g)]
    .map((m) => [m[2], Number(m[3]), Number(m[4])]);
  const [from, to] = typingWindow(3, 4.5);
  const slice = (to - from) / 3;
  assert.deepEqual(typed.map((x) => x[0]), ["assets/t1.png", "assets/t2.png", "assets/t3.png"]);
  assert.ok(Math.abs((typed[0][1] as number) - from) < 1e-3);
  assert.ok(Math.abs((typed[1][1] as number) - (from + slice)) < 1e-3);
  assert.ok(Math.abs((typed[2][1] as number) + (typed[2][2] as number) - 7.5) < 1e-3);
  assert.equal(compositionLength(html), 12.5);
});

test("one action per step, each with its own minimum length, and typing needs stills", () => {
  const b = { x: 10, y: 10, w: 20, h: 20 };
  assert.deepEqual(
    screenDemoProblems({
      id: "x",
      steps: [
        { src: "assets/a.png", seconds: 3, click: b, drag: { from: b, to: b } },
        { src: "assets/b.png", seconds: 2, type: { box: b, frames: [] } },
        { src: "assets/c.png", seconds: 2, connect: { from: b, to: { x: 5000, y: 0, w: 2, h: 2 } } },
      ],
    }),
    [
      "steps[0]: one of click, drag, connect, type per step, not click and drag",
      "steps[1].seconds: at least 2.5 for a step with type",
      "steps[1].type.frames: at least one",
      "steps[2].seconds: at least 2.2 for a step with connect",
      "steps[2].connect.to: a box {x,y,w,h} on the 1600x900 page",
    ],
  );
});

test("the cursor's randomness is seeded: no Math.random in the composition", () => {
  assert.doesNotMatch(screenDemoHtml(demo), /Math\.random/);
});

test("the 3D open and close is off unless asked for", () => {
  assert.doesNotMatch(screenDemoHtml(demo), /data-tilt="1"/);
  assert.match(screenDemoHtml({ ...demo, tilt: true }), /data-accent="224,82,104" data-tilt="1"/);
});

test("the capture spec rides inside the composition and comes back out intact", () => {
  const spec = { url: "https://example.com/a?b=1", steps: [{ type: { into: { text: "</script><b>" }, text: "x" } }], look: { tilt: true } };
  const html = screenDemoHtml({ ...demo, spec });
  assert.doesNotMatch(html, /<\/script><b>/); // cannot close its own tag
  assert.deepEqual(demoSpecOf(html), spec);
  assert.equal(demoSpecOf(screenDemoHtml(demo)), null);
});

test("a step lasts long enough for its action unless the spec says", () => {
  assert.equal(defaultSeconds({ type: {} }, false), 4.5);
  assert.equal(defaultSeconds({ drag: {} }, false), 3.4);
  assert.equal(defaultSeconds({ click: {} }, false), 3.5);
  assert.equal(defaultSeconds({}, true), 3);
  assert.equal(defaultSeconds({}, false), 2.5);
});

test("fit cover is marked for the kit; contain is the default and leaves no mark", () => {
  const win = (html: string) => html.match(/<div id="win"[^>]*>/)![0];
  assert.match(win(screenDemoHtml({ ...demo, fit: "cover" })), /data-fit="cover"/);
  assert.doesNotMatch(win(screenDemoHtml(demo)), /data-fit/);
});

test("steps spread over a clip's length in proportion, never below their minimum", () => {
  assert.deepEqual(fitSeconds([3.5, 3.5, 3], [2, 2, 0.5], 7.5), [2.625, 2.625, 2.25]);
  // Too short for the click minimums: the minimums hold, the rest shrinks.
  assert.deepEqual(fitSeconds([3.5, 3.5, 3], [2, 2, 0.5], 5), [2, 2, 1]);
  // Shorter than the minimums together: the minimums win.
  assert.deepEqual(fitSeconds([3.5, 3.5], [2, 2], 3), [2, 2]);
  assert.deepEqual(fitSeconds([3, 3], [2, 2], 12), [6, 6]);
});

test("split: the demo fills its half, the clip the other, muted with its sound on <audio>", () => {
  const clip = { clip: "assets/talk.mp4", seconds: 7.5 };
  const top = screenDemoHtml({ ...demo, frame: { width: 1080, height: 1920 }, layout: { kind: "split", demo: "top", ...clip } });
  assert.match(top, /<div id="demo-area" style="position:absolute;left:0;top:0px;width:1080px;height:960px;overflow:hidden">\s*<div id="cam"/);
  assert.match(top, /<video id="clip" src="assets\/talk.mp4" class="clip" data-start="0" data-duration="7.5" data-track-index="2" muted playsinline\s+style="position:absolute;left:0;top:960px;width:1080px;height:960px;object-fit:cover/);
  assert.match(top, /<audio id="clip-audio" src="assets\/talk.mp4" class="clip" data-start="0" data-duration="7.5"/);
  // The video runs as long as the longer of the two.
  assert.equal(compositionLength(top), 10);
  const bottom = screenDemoHtml({ ...demo, frame: { width: 1080, height: 1920 }, layout: { kind: "split", demo: "bottom", ...clip } });
  assert.match(bottom, /id="demo-area" style="position:absolute;left:0;top:960px/);
  assert.match(bottom, /<video id="clip"[^>]*\s+style="position:absolute;left:0;top:0px/);
});

test("pip: the demo fills the video, the clip is a round bubble in the corner", () => {
  const html = screenDemoHtml({ ...demo, layout: { kind: "pip", clip: "assets/talk.mp4", seconds: 12, corner: "bottom-left" } });
  assert.doesNotMatch(html, /id="demo-area"/);
  assert.match(html, /left:43px;bottom:43px;width:324px;height:324px;border-radius:50%/);
  assert.equal(compositionLength(html), 12);
});

test("a layout with a bad clip or position is named", () => {
  assert.deepEqual(
    screenDemoProblems({ ...demo, layout: { kind: "split", demo: "top", clip: 'x"y', seconds: 0, position: "middle" } }),
    ["layout.clip: an assets/<key> path", "layout.seconds: above 0", 'layout.position: like "50% 40%"'],
  );
});

const page = { width: 1600, height: 900 };
const split = (): string => {
  const html = screenDemoHtml({ ...demo, frame: { width: 1080, height: 1920 }, layout: { kind: "split", demo: "top", clip: "assets/talk.mp4", seconds: 7.5 } });
  // The user's own additions after the template: a title clip.
  return html.replace(/(<!-- \/layout-clip -->\n)/, '$1  <h1 id="title" class="clip" data-start="0" data-duration="3" data-track-index="4">Hi</h1>\n');
};

test("a refresh swaps the stills and keeps the layout, the clip, added clips and the timing", () => {
  const before = split().replace('id="step2" src="assets/b.png" class="clip demo-step" data-start="4" data-duration="3.5"', 'id="step2" src="assets/b.png" class="clip demo-step" data-start="5" data-duration="2"');
  const fresh = demo.steps.map((st, i) => ({ ...st, src: `assets/new-${i + 1}.png`, seconds: 9 }));
  const after = replaceDemoSteps(before, fresh, page)!;
  assert.match(after, /src="assets\/new-1.png"/);
  assert.doesNotMatch(after, /src="assets\/a.png"/);
  assert.deepEqual(demoStepTimes(after), [{ start: 0, seconds: 4 }, { start: 5, seconds: 2 }, { start: 7.5, seconds: 2.5 }]);
  for (const kept of ['id="demo-area"', 'id="clip"', 'id="clip-audio"', 'id="title"', "data-width=\"1080\""]) assert.ok(after.includes(kept), kept);
});

test("a refresh with a different number of steps runs them on from the first start, and grows the video if needed", () => {
  const before = screenDemoHtml(demo);
  const fresh = [1, 2, 3, 4].map((n) => ({ src: `assets/n${n}.png`, seconds: 4 }));
  const after = replaceDemoSteps(before, fresh, page)!;
  assert.deepEqual(demoStepTimes(after).map((x) => x.start), [0, 4, 8, 12]);
  assert.match(after, /data-composition-id="demo-1" data-start="0" data-duration="16"/);
});

test("demos made before the markers are refreshed too", () => {
  const legacy = screenDemoHtml(demo).replace("      <!-- demo-steps -->\n", "").replace("\n      <!-- /demo-steps -->", "");
  const after = replaceDemoSteps(legacy, demo.steps.map((st) => ({ ...st, src: "assets/z.png" })), page)!;
  assert.equal((after.match(/src="assets\/z.png"/g) ?? []).length, 3);
  assert.equal((after.match(/id="ripple"/g) ?? []).length, 1);
  assert.equal(replaceDemoSteps("<div>no demo</div>", demo.steps, page), null);
});

test("the spec is replaced, or added to a composition without one", () => {
  const withSpec = screenDemoHtml({ ...demo, spec: { url: "https://a.example" } });
  assert.deepEqual(demoSpecOf(withDemoSpec(withSpec, { url: "https://b.example" })), { url: "https://b.example" });
  assert.deepEqual(demoSpecOf(withDemoSpec(screenDemoHtml(demo), { url: "https://c.example" })), { url: "https://c.example" });
});
