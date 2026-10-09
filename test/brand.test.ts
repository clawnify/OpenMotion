// Run: pnpm test (Node 22+).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_BRAND,
  colorsIn,
  fontFamiliesIn,
  googleFontsHref,
  hasBrand,
  normalHex,
  offBrandColors,
  readableOn,
  type Brand,
} from "../src/shared/brand.ts";
import { lintComposition } from "../src/server/lint.ts";
import { starterHtml } from "../src/client/starter.ts";
import { FORMATS } from "../src/shared/format.ts";

const BRAND: Brand = {
  ...EMPTY_BRAND,
  background: "#fff8ef",
  text: "#1d1a16",
  accent: "#e4572e",
  secondary: "#2e86ab",
  heading_font: "Playfair Display",
  body_font: "Inter",
};

test("an empty brand is no brand", () => {
  assert.equal(hasBrand(EMPTY_BRAND), false);
  assert.equal(hasBrand({ ...EMPTY_BRAND, notes: "  " }), false);
  assert.equal(hasBrand({ ...EMPTY_BRAND, body_font: "Inter" }), true);
  assert.equal(hasBrand(null), false);
});

test("colours are read from styles, sheets, SVG paint and tween literals, not from selectors or links", () => {
  const html = `<div id="root" style="background:#0B1020;color:rgb(255, 255, 255)">
  <style>#face { border: 2px solid #e4572e } .x{fill:url(#grad)}</style>
  <a href="#abcdef">x</a>
  <svg><circle fill="#2e86ab" stroke="url(#abc123)"/></svg>
  <script>tl.to("#title", { color: "#ff00aa" }); gsap.set("#bad", {});</script>
</div>`;
  assert.deepEqual(
    colorsIn(html).map((c) => c.hex),
    ["#0b1020", "#ffffff", "#e4572e", "#2e86ab", "#ff00aa"],
  );
});

test("off-brand: hues outside the palette, never greys, and a brand colour at any opacity is on brand", () => {
  const html = [
    `<div style="background:#fff8ef;color:#1d1a16">`,
    `<p style="color:rgba(228,87,46,0.5)">on brand at half</p>`,
    `<p style="color:#e5582f">a rounding off</p>`,
    `<p style="color:#888;border-color:#000000;background:#ffffff">greys</p>`,
    `<p style="color:#7c3aed">purple</p>`,
    `</div>`,
  ].join("\n");
  const off = offBrandColors(html, BRAND);
  assert.deepEqual(off.map((c) => [c.raw, c.line]), [["#7c3aed", 5]]);
});

test("a brand without colours flags nothing", () => {
  assert.deepEqual(offBrandColors(`<p style="color:#7c3aed">x</p>`, { ...EMPTY_BRAND, heading_font: "Inter" }), []);
});

test("the lint reports an off-brand colour as a warning naming the palette", async () => {
  const html = starterHtml(1920, 1080);
  const lint = await lintComposition(html, BRAND);
  const f = lint?.findings.find((x) => x.code === "off_brand_color");
  assert.ok(f, JSON.stringify(lint));
  assert.equal(f.severity, "warning");
  assert.match(f.fix ?? "", /accent #e4572e/);
  // Without a brand the same video is clean.
  assert.deepEqual(await lintComposition(html), { errors: 0, warnings: 0, findings: [] });
});

test("a branded starter lints clean against its own brand, in every shape, with and without a logo", async () => {
  const partial: Brand = { ...EMPTY_BRAND, accent: "#e4572e" };
  for (const brand of [BRAND, partial]) {
    for (const s of FORMATS) {
      for (const logo of [null, "acme-logo.png"]) {
        const lint = await lintComposition(starterHtml(s.width, s.height, brand, logo), brand);
        assert.deepEqual(lint, { errors: 0, warnings: 0, findings: [] }, `${s.id} ${logo} ${JSON.stringify(brand)}`);
      }
    }
  }
});

test("the starter uses the brand's colours, fonts and logo", () => {
  const html = starterHtml(1920, 1080, BRAND, "acme-logo.png");
  assert.match(html, /background:#fff8ef/);
  assert.match(html, /color:#e4572e/);
  assert.match(html, /font-family:'Playfair Display',system-ui/);
  assert.match(html, /font-family:'Inter',system-ui/);
  assert.match(html, /src="assets\/acme-logo.png"/);
  assert.match(html, /gsap\.set\(\["#logo"/);
});

test("without brand colours the starter keeps its own look", () => {
  assert.equal(starterHtml(1080, 1080, { ...EMPTY_BRAND, notes: "be calm" }), starterHtml(1080, 1080));
});

test("text on a light background without a text colour turns black", () => {
  assert.equal(readableOn("#fff8ef"), "#000000");
  assert.equal(readableOn("#0b1020"), "#ffffff");
  assert.match(starterHtml(1920, 1080, { ...EMPTY_BRAND, background: "#fff8ef" }), /color:#000000;font-size:96px/);
});

test("font families a composition names, generic and variable ones left out", () => {
  const html = `<div style="font-family:'Playfair Display', Georgia, serif">
  <style>.a{font-family: "Space Mono", monospace} .b{font-family:var(--f), system-ui}</style>
  <p style="font-family:playfair display">again</p></div>`;
  assert.deepEqual(fontFamiliesIn(html), ["Playfair Display", "Georgia", "Space Mono"]);
  assert.match(googleFontsHref("Playfair Display"), /family=Playfair\+Display:ital,wght@/);
});

test("colours pasted from brand guidelines become #rrggbb", () => {
  assert.equal(normalHex("E4572E"), "#e4572e");
  assert.equal(normalHex(" #E4572E "), "#e4572e");
  assert.equal(normalHex("#abc"), "#aabbcc");
  assert.equal(normalHex("red"), "red");
});

test("a lighter or darker shade of a brand colour is on brand, a new hue is not, in hex and hsl()", () => {
  const html = [
    `<div style="background:#fff8ef">`,
    `<p style="color:#f4a78f">accent, lighter</p>`,
    `<p style="color:#8a2f14">accent, darker</p>`,
    `<p style="color:hsl(13 77% 54%)">accent as hsl</p>`,
    `<p style="color:hsla(263deg, 80%, 55%, 0.5)">purple as hsl</p>`,
    `<p style="color:#e4a72e">amber: 40 degrees from the accent</p>`,
    `</div>`,
  ].join("\n");
  assert.deepEqual(
    offBrandColors(html, BRAND).map((c) => [c.raw, c.line]),
    [
      ["hsla(263deg, 80%, 55%, 0.5)", 5],
      ["#e4a72e", 6],
    ],
  );
});

test("a brand of only black and white makes every hue off, and a cream still counts as neutral", () => {
  const mono: Brand = { ...EMPTY_BRAND, background: "#ffffff", text: "#111111" };
  const off = offBrandColors(`<p style="color:#fff8ef;background:#e4572e">x</p>`, mono);
  assert.deepEqual(off.map((c) => c.hex), ["#e4572e"]);
});
