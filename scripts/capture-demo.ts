// Capture a product demo of a web app, one still per state, for
// POST /api/compositions/screen-demo (see src/shared/screen-demo.ts).
//
//   CHROME_PATH=/path/to/chrome pnpm demo:capture spec.json [--out dir]
//     [--api <base> [--header "Name: value"]... [--composition <id>]]
//
// The spec names elements by what they say, not where they are, so the same
// spec captures the app again after its layout changes:
//
//   { "name": "Studio: a workflow",
//     "url": "https://app.example.com/…",
//     "page": { "width": 1600, "height": 900 },        // optional, the default
//     "wait_gone": "Loading",                           // optional
//     "steps": [
//       { "focus": { "text": "A tidy creative studio" },
//         "click": { "text": "Outputs" }, "seconds": 4 },
//       { "click": { "selector": "nav a[href$='/workflows']" }, "seconds": 3.5 },
//       { "seconds": 2.5 } ] }
//
// Each step: wait for the page to settle, screenshot it, measure `focus` and
// `click`, then really click `click` to reach the next state. A text matches
// the smallest visible element whose text contains it, in any frame of the
// page; for a click, a button, link, tab or other control wins over plain
// text. Stills are taken at device scale factor 2 so a zoom stays sharp.
//
// Without --api it writes the stills and screen-demo.json (the request body,
// with file names as asset keys) to --out. With --api, the base the app's API
// is reached at (its origin, or a proxy such as
// https://provision.clawnify.com/v1/apps/by-slug/<slug>/proxy), it uploads the
// stills and creates the composition, or rebuilds --composition in place.

import puppeteer, { type Frame, type Page, type ElementHandle } from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface Locator {
  /** Visible text the element contains. */
  text?: string;
  /** CSS selector the element matches (with `text`, both must hold). */
  selector?: string;
  /** Grow the match to its nearest ancestor matching this, e.g. a card. */
  closest?: string;
}
interface Spec {
  name: string;
  url: string;
  page?: { width: number; height: number };
  wait_gone?: string;
  steps: { focus?: Locator; click?: Locator; seconds: number }[];
}
type Box = { x: number; y: number; w: number; h: number };

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const specPath = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!specPath) {
  console.error("usage: capture-demo <spec.json> [--out dir] [--api base] [--header 'K: V'] [--composition id]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
const page = spec.page ?? { width: 1600, height: 900 };
const out = flag("--out") ?? join("demo-captures", slug(spec.name));
const api = flag("--api")?.replace(/\/+$/, "");
const headers: Record<string, string> = {};
args.forEach((a, i) => {
  if (a !== "--header") return;
  const [k, ...v] = (args[i + 1] ?? "").split(":");
  if (k && v.length) headers[k.trim()] = v.join(":").trim();
});
const chrome = process.env.CHROME_PATH;
if (!chrome) {
  console.error("Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(2);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "demo";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Network quiet, no `wait_gone` text in any frame, then a beat for paint. */
async function settle(p: Page) {
  await p.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
  if (spec.wait_gone) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const shown = await Promise.all(
        p.frames().map((f) => f.evaluate((t) => document.body?.innerText.includes(t) ?? false, spec.wait_gone!).catch(() => false)),
      );
      if (!shown.some(Boolean)) break;
      await sleep(250);
    }
  }
  await sleep(600);
}

/** The best match for a locator across every frame, as a handle and its box on the page. */
async function find(p: Page, loc: Locator, preferControls: boolean): Promise<{ el: ElementHandle; box: Box }> {
  const candidates: { el: ElementHandle; box: Box; control: boolean }[] = [];
  for (const f of p.frames() as Frame[]) {
    // Filter inside the page in one call; only the matches come back as handles.
    const list = await f
      .evaluateHandle((loc: Locator) => {
        const controls = "button,a,input,select,textarea,summary,label,[role=button],[role=tab],[role=link],[role=menuitem],[role=option],[role=checkbox],[role=switch]";
        const seen = new Set<Element>();
        for (const el of Array.from(document.querySelectorAll(loc.selector ?? "body *"))) {
          const e = el as HTMLElement;
          if (loc.text && !(e.innerText ?? "").includes(loc.text)) continue;
          const pick = (loc.closest ? e.closest(loc.closest) : e) as HTMLElement | null;
          if (!pick) continue;
          const r = pick.getBoundingClientRect(), st = getComputedStyle(pick);
          if (r.width < 1 || r.height < 1 || st.visibility === "hidden" || st.display === "none" || +st.opacity === 0) continue;
          seen.add(pick);
        }
        return Array.from(seen).map((el) => ({ el, control: el.matches(controls) }));
      }, loc)
      .catch(() => null);
    if (!list) continue;
    for (const item of (await list.getProperties()).values()) {
      const el = (await item.getProperty("el")).asElement() as ElementHandle | null;
      const control = (await (await item.getProperty("control")).jsonValue()) as boolean;
      const b = el && (await el.boundingBox());
      if (el && b) candidates.push({ el, control, box: { x: b.x, y: b.y, w: b.width, h: b.height } });
    }
  }
  const visible = candidates.filter((c) => c.box.x < page.width && c.box.y < page.height && c.box.x + c.box.w > 0 && c.box.y + c.box.h > 0);
  const pool = preferControls && visible.some((c) => c.control) ? visible.filter((c) => c.control) : visible;
  pool.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
  if (!pool[0]) throw new Error(`nothing on the page matches ${JSON.stringify(loc)}`);
  return pool[0];
}

const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const files: string[] = [];
const steps: { asset: string; seconds: number; focus?: Box; click?: Box }[] = [];
try {
  const p = await browser.newPage();
  await p.setViewport({ width: page.width, height: page.height, deviceScaleFactor: 2 });
  await p.goto(spec.url, { waitUntil: "networkidle2", timeout: 60000 });
  for (const [i, step] of spec.steps.entries()) {
    await settle(p);
    const file = join(out, `${slug(spec.name)}-${i + 1}.png`);
    await p.screenshot({ path: file as `${string}.png` });
    files.push(file);
    const focus = step.focus ? round((await find(p, step.focus, false)).box) : undefined;
    let click: Box | undefined;
    if (step.click) {
      const target = await find(p, step.click, true);
      click = round(target.box);
      await target.el.click();
    }
    steps.push({ asset: basename(file), seconds: step.seconds, focus, click });
    console.log(`step ${i + 1}: ${file}${focus ? " focus " + JSON.stringify(focus) : ""}${click ? " click " + JSON.stringify(click) : ""}`);
  }
} finally {
  await browser.close();
}

const body = { name: spec.name, page, steps, ...(flag("--composition") ? { composition_id: flag("--composition") } : {}) };
writeFileSync(join(out, "screen-demo.json"), JSON.stringify(body, null, 2));
console.log(`wrote ${join(out, "screen-demo.json")}`);

if (api) {
  for (const [i, file] of files.entries()) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(file)], { type: "image/png" }), basename(file));
    const res = await fetch(`${api}/api/assets`, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`upload ${file}: ${res.status} ${await res.text()}`);
    // The app suffixes a key that is taken; use the one it gave.
    steps[i].asset = ((await res.json()) as { key: string }).key;
  }
  const res = await fetch(`${api}/api/compositions/screen-demo`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const row = (await res.json()) as { id?: string; lint?: { errors: number }; error?: string; problems?: string[] };
  if (!res.ok) throw new Error(`screen-demo: ${res.status} ${row.error} ${(row.problems ?? []).join("; ")}`);
  console.log(`composition ${row.id} (lint errors: ${row.lint?.errors ?? "n/a"})`);
}
