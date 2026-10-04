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
//       { "drag": { "from": { "text": "Prompt", "selector": "[draggable=true]" },
//                   "to": { "x": 700, "y": 560 } }, "seconds": 3.2 },
//       { "type": { "into": { "selector": "[contenteditable=true]",
//                             "within": { "text": "PROMPT 2", "closest": ".react-flow__node" } },
//                   "text": "A neon city skyline at dusk" }, "seconds": 4 },
//       { "connect": { "from": { "selector": ".react-flow__handle.source", "within": … },
//                      "to": { "selector": ".react-flow__handle.target", "within": … } }, "seconds": 3 },
//       { "focus": { "text": "Generate image" }, "click": { "text": "Outputs" }, "seconds": 3.5 },
//       { "seconds": 2.5 } ] }
//
// Each step: wait for the page to settle, screenshot it, measure `focus`, then
// really do its one action to reach the next state: `click`, `drag` (press,
// move, release: also how a palette item lands on a canvas), `connect` (the
// same gesture between two handles, shown as a line), or `type` (click into
// the element, type the text in a few chunks and screenshot after each, so the
// video shows it going in). A target is a locator or a page point {x, y}.
//
// A locator's `text` matches the smallest visible element containing it, in
// any frame of the page; for a click or a drag source, a control wins over
// plain text. `selector` narrows it, `closest` grows it to an ancestor (a
// card), `within` searches only inside another locator's match (the handle of
// one particular node). Stills are taken at device scale factor 2 so a zoom
// stays sharp.
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
  /** Search only inside this locator's match. */
  within?: Locator;
}
type Point = { x: number; y: number };
type Target = Locator | Point;
interface Spec {
  name: string;
  url: string;
  page?: { width: number; height: number };
  wait_gone?: string;
  steps: {
    seconds: number;
    focus?: Locator;
    click?: Locator;
    drag?: { from: Locator; to: Target };
    connect?: { from: Locator; to: Target };
    type?: { into: Locator; text: string; frames?: number };
  }[];
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
  // Filter inside the page in one call; only the matches come back as handles.
  // `scope` is the element to search inside, or null for the whole document.
  const search = (scope: Element | null, loc: Locator) => {
    const controls = "button,a,input,select,textarea,summary,label,[draggable=true],[role=button],[role=tab],[role=link],[role=menuitem],[role=option],[role=checkbox],[role=switch]";
    const seen = new Set<Element>();
    for (const el of Array.from((scope ?? document).querySelectorAll(loc.selector ?? (scope ? "*" : "body *")))) {
      const e = el as HTMLElement;
      if (loc.text && !(e.innerText ?? "").includes(loc.text)) continue;
      const pick = (loc.closest ? e.closest(loc.closest) : e) as HTMLElement | null;
      if (!pick) continue;
      const r = pick.getBoundingClientRect(), st = getComputedStyle(pick);
      if (r.width < 1 || r.height < 1 || st.visibility === "hidden" || st.display === "none" || +st.opacity === 0) continue;
      seen.add(pick);
    }
    return Array.from(seen).map((el) => ({ el, control: el.matches(controls) }));
  };
  const { within, ...own } = loc;
  const scope = within ? (await find(p, within, false)).el : null;
  const lists = scope
    ? [await scope.evaluateHandle(search, own).catch(() => null)]
    : await Promise.all((p.frames() as Frame[]).map((f) => f.evaluateHandle(search, null, own).catch(() => null)));
  const candidates: { el: ElementHandle; box: Box; control: boolean }[] = [];
  for (const list of lists) {
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
  // A click target that several controls match is a guess; say so, so the
  // spec can be made exact before the guess drifts on a re-capture. (A focus
  // always matches its ancestors too, and the smallest is the one meant.)
  const controls = pool.filter((c) => c.control).length;
  if (preferControls && controls > 1) {
    console.warn(`  ${JSON.stringify(loc)} matched ${controls} controls; took the smallest. Add a selector to be exact.`);
  }
  return pool[0];
}

const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

const isPoint = (t: Target): t is Point => typeof (t as Point).x === "number" && typeof (t as Point).y === "number";
const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Press at `a`, move to `b` in small steps (so drag events fire), release. */
async function gesture(p: Page, a: Point, b: Point) {
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await p.mouse.move(a.x + ((b.x - a.x) * i) / 20, a.y + ((b.y - a.y) * i) / 20);
    await sleep(25);
  }
  await p.mouse.up();
}

type StepOut = {
  asset: string;
  seconds: number;
  focus?: Box;
  click?: Box;
  drag?: { from: Box; to: Box };
  connect?: { from: Box; to: Box };
  type?: { box: Box; frames: string[] };
};

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const files: string[] = [];
const steps: StepOut[] = [];
try {
  const p = await browser.newPage();
  await p.setViewport({ width: page.width, height: page.height, deviceScaleFactor: 2 });
  await p.goto(spec.url, { waitUntil: "networkidle2", timeout: 60000 });
  for (const [i, step] of spec.steps.entries()) {
    await settle(p);
    const name = `${slug(spec.name)}-${i + 1}`;
    const file = join(out, `${name}.png`);
    await p.screenshot({ path: file as `${string}.png` });
    files.push(file);
    const o: StepOut = { asset: basename(file), seconds: step.seconds };
    if (step.focus) o.focus = round((await find(p, step.focus, false)).box);
    if (step.click) {
      const target = await find(p, step.click, true);
      o.click = round(target.box);
      await target.el.click();
    }
    for (const kind of ["drag", "connect"] as const) {
      const move = step[kind];
      if (!move) continue;
      const from = round((await find(p, move.from, true)).box);
      const to = isPoint(move.to) ? { x: Math.round(move.to.x) - 1, y: Math.round(move.to.y) - 1, w: 2, h: 2 } : round((await find(p, move.to, true)).box);
      o[kind] = { from, to };
      await gesture(p, centre(from), centre(to));
    }
    if (step.type) {
      const target = await find(p, step.type.into, false);
      const box = round(target.box);
      await target.el.click();
      // Type in chunks and screenshot after each: these become the frames the
      // video shows while the text goes in (wrapping, a growing box and all).
      const n = Math.max(1, Math.min(30, step.type.frames ?? 8));
      const text = step.type.text, frames: string[] = [];
      for (let j = 1; j <= n; j++) {
        await p.keyboard.type(text.slice(Math.round(((j - 1) * text.length) / n), Math.round((j * text.length) / n)), { delay: 15 });
        await sleep(150);
        const frame = join(out, `${name}-typed-${j}.png`);
        await p.screenshot({ path: frame as `${string}.png` });
        files.push(frame);
        frames.push(basename(frame));
      }
      o.type = { box, frames };
    }
    steps.push(o);
    const act = (["click", "drag", "connect", "type"] as const).find((k) => o[k]);
    console.log(`step ${i + 1}: ${basename(file)}${o.focus ? " focus " + JSON.stringify(o.focus) : ""}${act ? ` ${act} ` + JSON.stringify(o[act]) : ""}`);
  }
} finally {
  await browser.close();
}

const body = { name: spec.name, page, steps, ...(flag("--composition") ? { composition_id: flag("--composition") } : {}) };
writeFileSync(join(out, "screen-demo.json"), JSON.stringify(body, null, 2));
console.log(`wrote ${join(out, "screen-demo.json")}`);

if (api) {
  const keys = new Map<string, string>();
  for (const file of files) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(file)], { type: "image/png" }), basename(file));
    const res = await fetch(`${api}/api/assets`, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`upload ${file}: ${res.status} ${await res.text()}`);
    // The app suffixes a key that is taken; use the one it gave.
    keys.set(basename(file), ((await res.json()) as { key: string }).key);
  }
  for (const st of steps) {
    st.asset = keys.get(st.asset) ?? st.asset;
    if (st.type) st.type.frames = st.type.frames.map((f) => keys.get(f) ?? f);
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
