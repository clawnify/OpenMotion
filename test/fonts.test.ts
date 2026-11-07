// Run: pnpm test (Node 22+).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintComposition } from "../src/server/lint.ts";

const page = (style: string, body: string) => `<div id="root" data-composition-id="t" data-start="0" data-duration="3" data-width="1920" data-height="1080" style="width:1920px;height:1080px;background:#000;position:relative">
${style}
${body}
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
<script>const tl = gsap.timeline({ paused: true }); tl.from("#a", { opacity: 0, duration: 1 }, 0); window.__timelines = window.__timelines || {}; window.__timelines["t"] = tl;</script>
</div>`;

const termClass = (family: string) =>
  page(`<style>.term{font-family:'${family}',monospace}</style>`, `<p id="a" class="clip term" data-start="0" data-duration="3" data-track-index="0" style="color:#fff">ls</p>`);

/** Google Fonts as the lint sees it: `answer` per requested family. */
async function withGoogle<T>(answer: (family: string) => number | "down", run: (asked: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const family = decodeURIComponent(new URL(String(input)).searchParams.get("family")!.split(":")[0]).replace(/\+/g, " ");
    asked.push(family);
    const a = answer(family);
    if (a === "down") throw new TypeError("fetch failed");
    return new Response("", { status: a });
  }) as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = real;
  }
}

test("a Google font named in a <style> class is fine: the renderer fetches it by that name", async () => {
  await withGoogle(
    () => 200,
    async (asked) => {
      assert.deepEqual(await lintComposition(termClass("Roboto Mono")), { errors: 0, warnings: 0, findings: [] });
      assert.deepEqual(asked, ["Roboto Mono"]); // asked as written, not as the rule lowercased it
    },
  );
});

test("a name Google Fonts does not know stays an error, saying so", async () => {
  await withGoogle(
    () => 400,
    async () => {
      const lint = await lintComposition(termClass("Robotto Mono"));
      assert.equal(lint?.errors, 1);
      const f = lint!.findings[0];
      assert.equal(f.code, "font_family_without_font_face");
      assert.match(f.message, /no family named exactly Robotto Mono/);
      assert.match(f.fix ?? "", /case sensitive/);
    },
  );
});

test("when Google Fonts cannot be reached the renderer's finding stays as it was", async () => {
  await withGoogle(
    () => "down",
    async () => {
      const lint = await lintComposition(termClass("Space Grotesk"));
      assert.equal(lint?.errors, 1);
      assert.match(lint!.findings[0].message, /without @font-face declaration: space grotesk/);
    },
  );
});

test("a font list that starts with monospace or serif is a warning; a named font first, or a sans-serif start, is not", async () => {
  const html = page(
    `<style>.quote{font-family:serif}</style>`,
    [
      `<p id="a" class="clip" data-start="0" data-duration="3" data-track-index="0" style="font-family:monospace">ls</p>`,
      `<p id="b" class="clip" data-start="0" data-duration="3" data-track-index="1" style="font-family:'JetBrains Mono',monospace">ls</p>`,
      `<p id="c" class="clip" data-start="0" data-duration="3" data-track-index="2" style="font-family:system-ui,sans-serif">hi</p>`,
      `<p id="d" class="clip quote" data-start="0" data-duration="3" data-track-index="3" style="font-family:monospace">again</p>`,
    ].join("\n"),
  );
  const lint = await lintComposition(html);
  assert.deepEqual(
    lint?.findings.map((f) => [f.severity, f.code, f.line]),
    [
      ["warning", "generic_font_first", 2],
      ["warning", "generic_font_first", 3],
    ],
  );
  assert.match(lint!.findings[0].message, /starts with serif comes out in Inter/);
  assert.match(lint!.findings[1].fix ?? "", /'JetBrains Mono', monospace/);
});
