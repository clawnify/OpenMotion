// Run: pnpm test (Node 22+).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintComposition } from "../src/server/lint.ts";
import { starterHtml } from "../src/client/starter.ts";
import { FORMATS } from "../src/shared/format.ts";

const STARTER = starterHtml(1920, 1080);

test("every starter lints clean", async () => {
  for (const s of FORMATS) {
    const lint = await lintComposition(starterHtml(s.width, s.height));
    assert.deepEqual(lint, { errors: 0, warnings: 0, findings: [] }, s.id);
  }
});

test("a bare root div is linted as the renderer loads it, not flagged for its missing page", async () => {
  const lint = await lintComposition(STARTER);
  assert.ok(lint && !lint.findings.some((f) => f.code === "root_composition_missing_html_wrapper"));
});

test("centring with a CSS transform under a GSAP tween is an error, with the fix", async () => {
  const html = STARTER.replace(/\s*gsap\.set\(\[[^\n]*\n/, "\n")
    .replace(/white-space:nowrap"/g, 'white-space:nowrap;transform:translate(-50%,-50%)"')
    .replace('.from("#sub", { opacity: 0, y: 30, duration: 0.8 }, 0.9)', '.to("#sub", { y: 30, duration: 0.8 }, 0.9)');
  const lint = await lintComposition(html);
  const f = lint?.findings.find((x) => x.code === "gsap_css_transform_conflict");
  assert.ok(f, JSON.stringify(lint));
  assert.equal(f.severity, "error");
  assert.match(f.fix ?? "", /xPercent/);
});

test("line numbers point into the HTML as stored", async () => {
  const html = STARTER.replace('window.__timelines["untitled"] = tl;', "");
  const lint = await lintComposition(html);
  const f = lint?.findings.find((x) => x.code === "gsap_timeline_not_registered");
  assert.ok(f?.line, JSON.stringify(lint));
  assert.match(html.split("\n")[f.line - 1], /gsap\.timeline/);
});

test("the list is bounded, the counts are not, and no problem hides behind repeats of another", async () => {
  // Twelve clips centred with CSS and tweened on x and letterSpacing: 24 errors of two kinds.
  const clips = Array.from({ length: 12 }, (_, i) =>
    `<div id="c${i}" class="clip" data-start="0" data-duration="1" data-track-index="${i + 3}" style="position:absolute;transform:translate(-50%,-50%)">x</div>`,
  ).join("\n");
  const tweens = Array.from({ length: 12 }, (_, i) => `tl.to("#c${i}", { x: 10, letterSpacing: "4px", duration: 0.5 }, 0);`).join("\n");
  const html = STARTER.replace("  <script src=", `${clips}\n  <script src=`).replace(
    "window.__timelines = window",
    `${tweens}\n    window.__timelines = window`,
  );
  const lint = await lintComposition(html);
  assert.ok(lint);
  assert.equal(lint.errors, 24);
  assert.equal(lint.findings.length, 10);
  const codes = new Set(lint.findings.map((f) => f.code));
  assert.ok(codes.has("gsap_css_transform_conflict") && codes.has("gsap_non_transform_motion"), [...codes].join());
});

test("empty HTML has nothing to lint", async () => {
  assert.equal(await lintComposition("  "), null);
});

test("a product demo's many stills are not reported: the fix (separate files) cannot be made here", async () => {
  const { screenDemoHtml } = await import("../src/shared/screen-demo.ts");
  const steps = Array.from({ length: 6 }, (_, i) => ({ src: `assets/s${i}.png`, seconds: 2 }));
  const lint = await lintComposition(screenDemoHtml({ id: "d", steps }));
  assert.ok(lint && !lint.findings.some((f) => f.code === "timeline_track_too_dense"), JSON.stringify(lint));
  assert.equal(lint.warnings, 0);
});

test("a split demo with its clip and the clip's audio lints clean", async () => {
  const { screenDemoHtml } = await import("../src/shared/screen-demo.ts");
  const steps = [{ src: "assets/s1.png", seconds: 3, click: { x: 10, y: 10, w: 20, h: 20 } }, { src: "assets/s2.png", seconds: 3 }];
  const html = screenDemoHtml({ id: "d", steps, frame: { width: 1080, height: 1920 }, fit: "cover", layout: { kind: "split", demo: "top", clip: "assets/t.mp4", seconds: 6 } });
  const lint = await lintComposition(html);
  assert.equal(lint?.errors, 0, JSON.stringify(lint));
});
