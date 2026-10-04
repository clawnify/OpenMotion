// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipsEnd, compositionLength, rootLength, withLength } from "../src/shared/length.ts";
import { starterHtml } from "../src/client/starter.ts";
import { FORMATS } from "../src/shared/format.ts";

const STARTER_HTML = starterHtml(1920, 1080);

// The starter as it was before it stated its length: clips run to 5 s, the
// GSAP entrances end at 1.7 s, and HyperFrames rendered 1.7 s of it.
const unstated = STARTER_HTML.replace(/ data-duration="5"(?= data-width)/, "");

test("the starter states its length", () => {
  assert.equal(rootLength(STARTER_HTML), 5);
  assert.equal(withLength(STARTER_HTML), STARTER_HTML);
});

test("without a root length, the length is where the last clip ends", () => {
  assert.equal(rootLength(unstated), null);
  assert.equal(clipsEnd(unstated), 5);
  assert.equal(compositionLength(unstated), 5);
});

test("withLength writes it on the root, once", () => {
  const stamped = withLength(unstated);
  assert.equal(rootLength(stamped), 5);
  assert.match(stamped.match(/<div id="root"[^>]*>/)![0], / data-duration="5">$/);
  assert.equal(withLength(stamped), stamped);
});

test("a stated length wins over the clips", () => {
  const html = `<div data-composition-id="a" data-duration="12"><p class="clip" data-start="0" data-duration="3"></p></div>`;
  assert.equal(compositionLength(html), 12);
  assert.equal(withLength(html), html);
});

test("single quotes, several classes, an unusable root length", () => {
  const html = `<div data-composition-id='a' data-duration='' data-width='10'><p class='big clip' data-start='1.5' data-duration='2'></p></div>`;
  assert.equal(compositionLength(html), 3.5);
  assert.equal(
    withLength(html),
    `<div data-composition-id='a' data-width='10' data-duration="3.5"><p class='big clip' data-start='1.5' data-duration='2'></p></div>`,
  );
});

test("no clips and no root length: left to the timelines", () => {
  const html = `<div data-composition-id="a" data-width="10"></div>`;
  assert.equal(compositionLength(html), null);
  assert.equal(withLength(html), html);
});

test("only the clip class counts, and $ in the root survives", () => {
  const html = `<div data-composition-id="a" title="$& $1"><i class="clipboard" data-start="0" data-duration="9"></i><b class="clip" data-start="0" data-duration="2"></b></div>`;
  assert.equal(clipsEnd(html), 2);
  assert.ok(withLength(html).startsWith(`<div data-composition-id="a" title="$& $1" data-duration="2">`));
});

test("clips inside an inline nested composition do not count", () => {
  const html = `<div data-composition-id="a"><div class="clip" data-composition-id="intro" data-start="0" data-duration="4"></div><template id="t"><div data-composition-id="intro"><h1 class="clip" data-start="9" data-duration="3"></h1></div></template></div>`;
  assert.equal(clipsEnd(html), 4);
});

test("every shape starts at its own size and states the same length", () => {
  for (const { width, height } of FORMATS) {
    const html = starterHtml(width, height);
    const root = html.match(/<div id="root"[^>]*>/)![0];
    assert.match(root, new RegExp(`data-width="${width}" data-height="${height}"`));
    assert.match(root, new RegExp(`width:${width}px;height:${height}px;`));
    assert.equal(compositionLength(html), 5);
  }
});
