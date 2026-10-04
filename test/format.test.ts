// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS, formatOf, frameOf, ratioLabel, withFrame } from "../src/shared/format.ts";
import { starterHtml } from "../src/client/starter.ts";

test("five formats, the same shapes as OpenVideo", () => {
  assert.deepEqual(FORMATS.map((f) => f.ratio), ["16:9", "9:16", "1:1", "4:5", "4:3"]);
  for (const f of FORMATS) assert.equal(ratioLabel(f.width, f.height), f.ratio, f.id);
});

test("a canvas is matched to its format by shape, at any size", () => {
  assert.equal(formatOf(3840, 2160)?.id, "landscape");
  assert.equal(formatOf(1080, 1350)?.id, "portrait");
  assert.equal(formatOf(1000, 300), undefined);
  assert.equal(ratioLabel(2390, 1000), "2.39:1");
});

test("withFrame changes the root's size and nothing else", () => {
  const html = starterHtml(1920, 1080).replace("overflow:hidden", "overflow:hidden;max-width:5000px;line-height:1200px");
  const next = withFrame(html, 1080, 1920);
  assert.deepEqual(frameOf(next), { width: 1080, height: 1920 });
  assert.match(next, /style="width:1080px;height:1920px;/);
  assert.match(next, /max-width:5000px;line-height:1200px/); // look-alikes untouched
  // Every line but the root's opening tag is the same.
  const a = html.split("\n"), b = next.split("\n");
  assert.equal(a.length, b.length);
  assert.deepEqual(a.slice(2), b.slice(2));
});

test("no root, no change", () => {
  assert.equal(withFrame("<div>x</div>", 10, 10), "<div>x</div>");
  assert.equal(frameOf("<div>x</div>"), null);
});
