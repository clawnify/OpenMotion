// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenDemoHtml, screenDemoProblems, type ScreenDemoOptions } from "../src/shared/screen-demo.ts";
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

test("a landscape page sits 1:1 in a 1080p frame; a smaller frame scales the window down", () => {
  assert.match(screenDemoHtml(demo), /id="frame" style="position:absolute;left:160px;top:90px;width:1600px;height:900px/);
  assert.match(screenDemoHtml(demo), /data-page-scale="1"/);
  const vertical = screenDemoHtml({ ...demo, frame: { width: 1080, height: 1920 } });
  assert.match(vertical, /data-page-scale="0.608"/);
  assert.match(vertical, /width:972px;height:547px/);
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
    "steps[0].seconds: at least 2 for a step with a click",
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
