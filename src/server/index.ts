import { Hono } from "hono";
import { initDB, query, get, run } from "./db";
import {
  initUploads,
  putUpload,
  getUpload,
  getUploadRange,
  deleteUpload,
  makeKey,
} from "./uploads";
import { renderComposition } from "./render";
import { compositionLength, withLength } from "../shared/length";
import { lintComposition } from "./lint";
import { z } from "zod";
import { type ScreenDemoOptions, screenDemoHtml, screenDemoProblems, defaultSeconds, demoSpecOf, fitSeconds, minimumSeconds } from "../shared/screen-demo";
import { capturePage, outlinePage, ClawnifyServicesError, type CaptureStep, type CapturedPage } from "@clawnify/services";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  // Injected into every WfP app at deploy time; authorizes managed services.
  CLAWNIFY_TOKEN?: string;
  // Override for local dev (defaults to https://services.clawnify.com).
  SERVICES_URL?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", async (c, next) => {
  initDB(c.env);
  initUploads(c.env.UPLOADS);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// ── Compositions ─────────────────────────────────────────────────────

interface Composition {
  id: string;
  name: string;
  description: string;
  html: string;
  fps: number;
  created_at: string;
  updated_at: string;
}

app.get("/api/compositions", async (c) => {
  const rows = await query<Composition>("SELECT * FROM compositions ORDER BY updated_at DESC");
  return c.json(rows);
});

// One composition, with what HyperFrames' linter says about it (see lint.ts).
// The writes answer the same way, so whoever wrote it, the agent or the
// editor, learns in the same response what will render wrong.
async function withLint(row: Composition) {
  return { ...row, lint: await lintComposition(row.html) };
}

app.get("/api/compositions/:id", async (c) => {
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(await withLint(row));
});

app.post("/api/compositions", async (c) => {
  const b = await c.req.json<Partial<Composition>>();
  if (!b.name?.trim()) return c.json({ error: "name is required" }, 400);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO compositions (id, name, description, html, fps) VALUES (?, ?, ?, ?, ?)",
    [id, b.name.trim(), b.description ?? "", b.html ?? "", b.fps ?? 30],
  );
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  return c.json(row && (await withLint(row)), 201);
});

// A product demo in the style of a screen recording, built from one captured
// still per state of an app (see shared/screen-demo.ts). Steps name uploaded
// assets by key. With composition_id it rebuilds that video in place, which is
// how a demo is refreshed after the app changes and its states are captured
// again; without it, it creates one.
const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const sizeSchema = z.object({ width: z.number().int().min(16).max(4096), height: z.number().int().min(16).max(4096) });
const screenDemoSchema = z.object({
  composition_id: z.string().optional(),
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  steps: z.array(z.object({
    asset: z.string().min(1),
    seconds: z.number(),
    focus: boxSchema.optional(),
    click: boxSchema.optional(),
    drag: z.object({ from: boxSchema, to: boxSchema }).optional(),
    connect: z.object({ from: boxSchema, to: boxSchema }).optional(),
    type: z.object({ box: boxSchema, frames: z.array(z.string().min(1)).min(1).max(30) }).optional(),
  })).min(1).max(40),
  page: sizeSchema.optional(),
  frame: sizeSchema.optional(),
  background: z.string().max(300).optional(),
  accent: z.string().optional(),
  tilt: z.boolean().optional(),
  floating: z.boolean().optional(),
  fit: z.enum(["contain", "cover"]).optional(),
});

app.post("/api/compositions/screen-demo", async (c) => {
  const parsed = screenDemoSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid screen demo", problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  }
  const b = parsed.data;
  const existing = b.composition_id
    ? await get<Composition>("SELECT * FROM compositions WHERE id = ?", [b.composition_id])
    : null;
  if (b.composition_id && !existing) return c.json({ error: "Not found" }, 404);
  if (!existing && !b.name) return c.json({ error: "name is required" }, 400);

  const keys = new Set((await query<{ key: string }>("SELECT key FROM assets")).map((a) => a.key));
  const missing = b.steps.flatMap((s) => [s.asset, ...(s.type?.frames ?? [])]).filter((k) => !keys.has(k));
  if (missing.length) return c.json({ error: "unknown asset", problems: missing.map((k) => `no asset with key ${k}`) }, 400);

  const id = existing?.id ?? crypto.randomUUID();
  const opts = {
    id: `demo-${id.slice(0, 8)}`,
    steps: b.steps.map((s) => ({
      src: `assets/${s.asset}`,
      seconds: s.seconds,
      focus: s.focus,
      click: s.click,
      drag: s.drag,
      connect: s.connect,
      type: s.type && { box: s.type.box, frames: s.type.frames.map((k) => `assets/${k}`) },
    })),
    page: b.page,
    frame: b.frame,
    background: b.background,
    accent: b.accent,
    tilt: b.tilt,
    floating: b.floating,
    fit: b.fit,
  };
  const problems = screenDemoProblems(opts);
  if (problems.length) return c.json({ error: "invalid screen demo", problems }, 400);
  const html = screenDemoHtml(opts);

  if (existing) {
    await run(
      `UPDATE compositions SET name = ?, description = ?, html = ?, updated_at = datetime('now') WHERE id = ?`,
      [b.name ?? existing.name, b.description ?? existing.description, html, id],
    );
  } else {
    await run(
      "INSERT INTO compositions (id, name, description, html, fps) VALUES (?, ?, ?, ?, ?)",
      [id, b.name, b.description ?? "", html, 30],
    );
  }
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  return c.json(row && (await withLint(row)), existing ? 200 : 201);
});

// ── Product demos from a link ────────────────────────────────────────
// The AI in the app plans a demo by looking at the page (outline: one
// screenshot and its visible controls after any steps so far), then makes it
// in one call: the capture service walks the page for real (capture.ts), the
// stills land in the media library and the composition is built with the
// screen-demo kit. The spec stays inside the composition, so the same call
// with only composition_id captures the demo again after the app changes.

const CAPTURE_OFF = { error: "Capture service not configured (missing CLAWNIFY_TOKEN). Captures run on deployed apps." };

const servicesEnv = (env: Bindings) => ({ CLAWNIFY_TOKEN: env.CLAWNIFY_TOKEN, CLAWNIFY_SERVICES_URL: env.SERVICES_URL });

/** A capture that failed: the spec's fault (400) or the service's (502). */
function captureFailed(c: { json: (b: unknown, s: 400 | 502) => Response }, err: unknown) {
  if (!(err instanceof ClawnifyServicesError)) throw err;
  const problems = (err.body?.problems as string[] | undefined) ?? undefined;
  return c.json({ error: err.message, ...(problems ? { problems } : {}) }, err.status === 422 ? 400 : 502);
}

app.post("/api/demos/outline", async (c) => {
  if (!c.env.CLAWNIFY_TOKEN) return c.json(CAPTURE_OFF, 503);
  const b = await c.req
    .json<{ url?: string; page?: { width: number; height: number }; wait_gone?: string; steps?: CaptureStep[]; allow_writes?: boolean }>()
    .catch(() => null);
  if (!b?.url) return c.json({ error: "url is required" }, 400);
  try {
    return c.json(
      await outlinePage(servicesEnv(c.env), { url: b.url, page: b.page, waitGone: b.wait_gone, steps: b.steps, allowWrites: b.allow_writes === true }),
    );
  } catch (err) {
    return captureFailed(c, err);
  }
});

// A layout names its clip by asset key; the app turns it into the clip's
// path and length (see /api/demos).
const position = z.string().regex(/^\d{1,3}% \d{1,3}%$/).optional();
const layoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full") }),
  z.object({ kind: z.literal("split"), demo: z.enum(["top", "bottom"]), clip: z.string().min(1), seconds: z.number().positive().optional(), position }),
  z.object({
    kind: z.literal("pip"),
    clip: z.string().min(1),
    seconds: z.number().positive().optional(),
    corner: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).optional(),
    position,
  }),
]);

const lookSchema = {
  layout: layoutSchema.optional(),
  frame: sizeSchema.optional(),
  floating: z.boolean().optional(),
  fit: z.enum(["contain", "cover"]).optional(),
  tilt: z.boolean().optional(),
  accent: z.string().optional(),
  background: z.string().max(300).optional(),
};
const demoSchema = z.object({
  composition_id: z.string().optional(),
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  page: sizeSchema.optional(),
  wait_gone: z.string().optional(),
  steps: z.array(z.record(z.unknown())).min(1).max(12).optional(),
  allow_writes: z.boolean().optional(),
  ...lookSchema,
});
type DemoSpec = {
  url: string;
  page?: { width: number; height: number };
  wait_gone?: string;
  steps: Record<string, unknown>[];
  allow_writes?: boolean;
  look?: z.infer<z.ZodObject<typeof lookSchema>>;
};

app.post("/api/demos", async (c) => {
  if (!c.env.CLAWNIFY_TOKEN) return c.json(CAPTURE_OFF, 503);
  const parsed = demoSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid demo", problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  }
  const b = parsed.data;
  const existing = b.composition_id
    ? await get<Composition>("SELECT * FROM compositions WHERE id = ?", [b.composition_id])
    : null;
  if (b.composition_id && !existing) return c.json({ error: "Not found" }, 404);
  if (!existing && !b.name) return c.json({ error: "name is required" }, 400);

  // A new spec, or the one this demo was made from (a re-capture).
  const before = existing ? (demoSpecOf(existing.html) as DemoSpec | null) : null;
  const look = { ...before?.look, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => k in lookSchema && v !== undefined)) };
  const spec: DemoSpec | null = b.url && b.steps
    ? { url: b.url, page: b.page, wait_gone: b.wait_gone, steps: b.steps, allow_writes: b.allow_writes, look }
    : before && { ...before, look };
  if (!spec) return c.json({ error: "url and steps are required, or the composition_id of a demo made here" }, 400);

  let captured: CapturedPage;
  try {
    captured = await capturePage(servicesEnv(c.env), {
      url: spec.url,
      page: spec.page,
      waitGone: spec.wait_gone,
      steps: spec.steps as CaptureStep[],
      allowWrites: spec.allow_writes === true,
    });
  } catch (err) {
    return captureFailed(c, err);
  }

  // Each still into the media library, under keys unique to this capture.
  const id = existing?.id ?? crypto.randomUUID();
  const prefix = `demo-${id.slice(0, 8)}-${lower8().slice(0, 6)}`;
  const keep = async (url: string, name: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new ClawnifyServicesError(`could not fetch a captured still (${res.status})`, { status: 502 });
    const data = await res.arrayBuffer();
    const key = `${prefix}-${name}.png`;
    await putUpload(key, data, "image/png");
    await run("INSERT INTO assets (key, name, content_type, size) VALUES (?, ?, 'image/png', ?)", [key, key, data.byteLength]);
    return key;
  };
  const steps: ScreenDemoOptions["steps"] = [];
  try {
    for (const [i, s] of captured.steps.entries()) {
      const asked = spec.steps[i] as { seconds?: number };
      const frames = [];
      for (const [j, u] of (s.type?.frame_urls ?? []).entries()) frames.push(`assets/${await keep(u, `${i + 1}-typed-${j + 1}`)}`);
      steps.push({
        src: `assets/${await keep(s.image_url, String(i + 1))}`,
        seconds: asked.seconds ?? defaultSeconds(s, i === captured.steps.length - 1),
        focus: s.focus,
        click: s.click,
        drag: s.drag,
        connect: s.connect,
        type: s.type && { box: s.type.box, frames },
      });
    }
  } catch (err) {
    return captureFailed(c, err);
  }

  // A layout's clip: an uploaded video, played for its own length, and the
  // steps spread over that length unless the spec timed them itself.
  let layout: ScreenDemoOptions["layout"] = undefined;
  const l = look.layout;
  if (l && l.kind !== "full") {
    const asset = await get<Asset & { duration: number | null }>("SELECT * FROM assets WHERE key = ?", [l.clip]);
    if (!asset || !asset.content_type.startsWith("video/")) {
      return c.json({ error: "invalid demo", problems: [`layout.clip: no uploaded video with key ${l.clip}`] }, 400);
    }
    const seconds = l.seconds ?? asset.duration;
    if (!seconds) {
      return c.json({ error: "invalid demo", problems: ["layout.seconds: the clip's length is unknown; pass seconds"] }, 400);
    }
    layout = { ...l, clip: `assets/${l.clip}`, seconds };
    if (spec.steps.every((st) => (st as { seconds?: number }).seconds === undefined)) {
      const fitted = fitSeconds(steps.map((st) => st.seconds), steps.map((st) => minimumSeconds(st)), seconds);
      fitted.forEach((sec, i) => (steps[i].seconds = sec));
    }
  }

  const opts = { id: `demo-${id.slice(0, 8)}`, steps, page: captured.page, ...look, layout, spec };
  const problems = screenDemoProblems(opts);
  if (problems.length) return c.json({ error: "invalid screen demo", problems }, 400);
  const html = screenDemoHtml(opts);

  if (existing) {
    await run(
      `UPDATE compositions SET name = ?, description = ?, html = ?, updated_at = datetime('now') WHERE id = ?`,
      [b.name ?? existing.name, b.description ?? existing.description, html, id],
    );
    // The stills of the capture this one replaces: only keys this endpoint
    // made for this composition (demo-<id8>-<run>-…), never an upload of the
    // user's that happens to be named demo-something.
    const ours = new RegExp(`assets/(demo-${id.slice(0, 8)}-[0-9a-f]{6}-[0-9a-z-]+\\.png)`, "g");
    const old = new Set([...existing.html.matchAll(ours)].map((m) => m[1]));
    for (const key of old) {
      if (html.includes(`assets/${key}`)) continue;
      await run("DELETE FROM assets WHERE key = ?", [key]);
      await deleteUpload(key);
    }
  } else {
    await run("INSERT INTO compositions (id, name, description, html, fps) VALUES (?, ?, ?, ?, ?)", [
      id,
      b.name,
      b.description ?? "",
      html,
      30,
    ]);
  }
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  return c.json({ ...(row && (await withLint(row))), warnings: captured.warnings }, existing ? 200 : 201);
});

app.put("/api/compositions/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<Partial<Composition>>();
  await run(
    `UPDATE compositions SET name = ?, description = ?, html = ?, fps = ?, updated_at = datetime('now') WHERE id = ?`,
    [b.name ?? existing.name, b.description ?? existing.description, b.html ?? existing.html, b.fps ?? existing.fps, id],
  );
  const row = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [id]);
  return c.json(row && (await withLint(row)));
});

app.delete("/api/compositions/:id", async (c) => {
  await run("DELETE FROM compositions WHERE id = ?", [c.req.param("id")]);
  return c.json({ ok: true });
});

// Serve the composition wrapped in a full HTML doc with a preview harness that
// scales it to fit and loops its GSAP timelines. Loaded by the editor iframe.
app.get("/api/compositions/:id/preview", async (c) => {
  const row = await get<Composition>("SELECT html FROM compositions WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.text("Not found", 404);
  return c.html(previewDoc(row.html));
});

// ── Assets (media library) ───────────────────────────────────────────

interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  created_at: string;
}

app.get("/api/assets", async (c) => {
  const rows = await query<Asset>("SELECT * FROM assets ORDER BY created_at DESC");
  return c.json(rows);
});

app.post("/api/assets", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") return c.json({ error: "No file provided" }, 400);

  // Unique R2 key from the original name; suffix on collision.
  let key = makeKey(file.name || "file");
  const clash = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
  if (clash) {
    const dot = key.lastIndexOf(".");
    const suffix = lower8();
    key = dot > 0 ? `${key.slice(0, dot)}-${suffix}${key.slice(dot)}` : `${key}-${suffix}`;
  }

  const data = await file.arrayBuffer();
  const contentType = file.type || "application/octet-stream";
  await putUpload(key, data, contentType);

  // Client-probed media length (seconds) — see schema note on assets.duration.
  const durRaw = Number(body["duration"]);
  const duration = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null;

  const res = await run(
    "INSERT INTO assets (key, name, content_type, size, duration) VALUES (?, ?, ?, ?, ?)",
    [key, file.name || key, contentType, data.byteLength, duration],
  );
  const row = await get<Asset>("SELECT * FROM assets WHERE rowid = ?", [res.lastInsertRowid]);
  return c.json(row, 201);
});

// Backfill a probed duration onto a legacy asset (self-healing library).
app.patch("/api/assets/:id", async (c) => {
  const b = await c.req.json<{ duration?: number }>().catch(() => ({}) as { duration?: number });
  if (typeof b.duration === "number" && Number.isFinite(b.duration) && b.duration > 0) {
    await run("UPDATE assets SET duration = ? WHERE id = ? AND duration IS NULL", [
      b.duration,
      c.req.param("id"),
    ]);
  }
  const row = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.delete("/api/assets/:id", async (c) => {
  const row = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (row) {
    await deleteUpload(row.key);
    await run("DELETE FROM assets WHERE id = ?", [row.id]);
  }
  return c.json({ ok: true });
});

// Serve any R2 object (uploaded media + rendered videos). Range-aware: media
// elements seek with byte ranges, and metadata probing of moov-at-end files
// is unusably slow without 206 responses.
app.get("/api/uploads/:key", async (c) => {
  const key = c.req.param("key");
  const range = c.req.header("Range");
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);

  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : undefined;
    const obj = await getUploadRange(key, start, end !== undefined ? end - start + 1 : undefined);
    if (!obj) return c.json({ error: "Not found" }, 404);
    const last = end !== undefined ? Math.min(end, obj.size - 1) : obj.size - 1;
    return new Response(obj.data, {
      status: 206,
      headers: {
        "Content-Type": obj.contentType,
        "Content-Range": `bytes ${start}-${last}/${obj.size}`,
        "Content-Length": String(last - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  }

  const obj = await getUpload(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.data, {
    headers: {
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000",
    },
  });
});

// ── Renders ──────────────────────────────────────────────────────────

interface RenderJob {
  id: number;
  composition_id: string;
  status: string;
  output_url: string | null;
  error: string | null;
  asset_id: string | null;
  created_at: string;
  updated_at: string;
}

app.get("/api/renders", async (c) => {
  const rows = await query<RenderJob>("SELECT * FROM render_jobs ORDER BY created_at DESC LIMIT 50");
  return c.json(rows);
});

app.get("/api/renders/:id", async (c) => {
  const row = await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.post("/api/renders", async (c) => {
  const { composition_id } = await c.req.json<{ composition_id: string }>();
  const comp = await get<Composition>("SELECT * FROM compositions WHERE id = ?", [composition_id]);
  if (!comp) return c.json({ error: "Composition not found" }, 404);

  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json(
      { error: "Render service not configured (missing CLAWNIFY_TOKEN). Renders run on deployed apps." },
      503,
    );
  }

  const res = await run(
    "INSERT INTO render_jobs (composition_id, status) VALUES (?, 'rendering')",
    [composition_id],
  );
  const jobId = res.lastInsertRowid as number;

  try {
    const assets = await query<Asset>("SELECT key FROM assets");
    const mp4 = await renderComposition({
      // Stated on the root, so the MP4 is as long as the preview and the
      // timeline say (see shared/length.ts).
      html: withLength(comp.html),
      fps: comp.fps,
      assets,
      filename: `${makeKey(comp.name)}.mp4`,
      servicesUrl: c.env.SERVICES_URL,
      token: c.env.CLAWNIFY_TOKEN,
    });

    const key = `renders/render-${jobId}-${lower8()}.mp4`;
    await putUpload(key, mp4, "video/mp4");
    const url = `/api/uploads/${encodeURIComponent(key)}`;

    // A finished composition is footage. Register it in the media library, so
    // it can be reused and, later, handed to OpenVideo as an editable clip.
    const assetId = lower16();
    await run(
      "INSERT INTO assets (id, key, name, content_type, size, duration) VALUES (?, ?, ?, 'video/mp4', ?, ?)",
      [assetId, key, `${comp.name}.mp4`, mp4.byteLength, compositionLength(comp.html)],
    );
    await run(
      "UPDATE render_jobs SET status = 'completed', output_url = ?, asset_id = ?, updated_at = datetime('now') WHERE id = ?",
      [url, assetId, jobId],
    );
  } catch (err) {
    await run(
      "UPDATE render_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
      [String(err).slice(0, 1000), jobId],
    );
  }

  const job = await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [jobId]);
  return c.json(job, 201);
});

// ── helpers ──────────────────────────────────────────────────────────

function lower16(): string {
  return lower8() + lower8();
}

function lower8(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function previewDoc(html: string): string {
  // Master-clock harness: one playhead drives every GSAP timeline so the editor's
  // timeline view stays in sync. Talks to the parent via postMessage:
  //   parent → iframe: { target:'hf-preview', type:'seek'|'play'|'pause', t }
  //   iframe → parent: { source:'hf-preview', type:'time'|'meta', t, duration }
  const harness = `
    window.__timelines = window.__timelines || {};
    // ?start / ?end define a loop window (a selected clip's span); ?play=1 autoplays.
    // Default (no params) is paused on the whole composition.
    var params = new URLSearchParams(location.search);
    var startAt = parseFloat(params.get('start') || '0') || 0;
    var endParam = parseFloat(params.get('end') || '');
    var seekParam = parseFloat(params.get('seek') || '');
    var loopStart = startAt, loopEnd = isFinite(endParam) ? endParam : Infinity;
    var tls = [], clips = [], playhead = startAt, playing = params.get('play') === '1', duration = 5, last = 0;
    // The render length, worked out on the server by the same rule the render
    // uses (shared/length.ts). null: neither the root nor any clip says, so the
    // timelines decide here exactly as they do in the renderer.
    var fixedLength = ${JSON.stringify(compositionLength(html))};
    addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.target !== 'hf-preview') return;
      if (m.type === 'seek') { playing = false; playhead = Math.max(0, Math.min(m.t, duration)); }
      else if (m.type === 'play') { playing = true; }
      else if (m.type === 'pause') { playing = false; }
      else if (m.type === 'window') {
        loopStart = Math.max(0, m.start || 0);
        loopEnd = (m.end == null) ? duration : Math.min(m.end, duration);
        if (loopStart >= loopEnd) loopStart = 0;
        // Do NOT move the playhead — selecting a clip you can already see
        // shouldn't jump the time. (Reload restores time via a 'seek' message.)
      }
    });
    // Scale the stage now, not on load: load waits for every image and video,
    // and until the fit the composition paints at full size, cropped. The head
    // style keeps it hidden until this runs; removing it (rather than writing
    // an inline opacity) leaves the composition's own styles untouched.
    (function () {
      var root = document.querySelector('[data-composition-id]');
      if (!root) return;
      var w = +(root.dataset.width || 1920), h = +(root.dataset.height || 1080);
      root.style.width = w + 'px'; root.style.height = h + 'px';
      root.style.position = 'relative'; root.style.transformOrigin = 'top left';
      var fit = function () {
        var s = Math.min(innerWidth / w, innerHeight / h);
        var tx = (innerWidth - w * s) / 2, ty = (innerHeight - h * s) / 2;
        root.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
      };
      fit(); addEventListener('resize', fit);
      var hold = document.getElementById('om-unfitted'); if (hold) hold.remove();
    })();
    addEventListener('load', function () {
      tls = Object.values(window.__timelines || {});
      tls.forEach(function (tl) { try { tl.pause(0); } catch (e) {} });
      var tlMax = tls.reduce(function (a, tl) { try { return Math.max(a, tl.duration()); } catch (e) { return a; } }, 0);
      duration = fixedLength != null ? fixedLength : Math.max(tlMax, 0.1);
      if (!isFinite(loopEnd) || loopEnd > duration) loopEnd = duration;
      if (loopStart >= loopEnd) loopStart = 0;
      playhead = isFinite(seekParam) ? Math.max(loopStart, Math.min(seekParam, loopEnd)) : loopStart;
      // Click a clip in the preview to select it for editing.
      document.querySelectorAll('.clip').forEach(function (el, i) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          parent.postMessage({ source: 'hf-preview', type: 'select', index: i }, '*');
        });
      });
      // The renderer mounts a clip only inside [data-start, data-start +
      // data-duration), so the preview hides it outside that window too.
      // Video and audio are never played natively: each frame seeks them to
      // the playhead, like GSAP, so scrubbing shows the frame the render will.
      // Muted, because per-frame seeking can't make clean sound; the exported
      // MP4 carries the real audio.
      clips = [].slice.call(document.querySelectorAll('.clip')).map(function (el) {
        var media = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
        if (media) { try { el.muted = true; el.pause(); } catch (e) {} }
        return { el: el, media: media, start: parseFloat(el.getAttribute('data-start')) || 0,
                 duration: parseFloat(el.getAttribute('data-duration')) };
      });
      parent.postMessage({ source: 'hf-preview', type: 'meta', duration: duration }, '*');
      last = performance.now();
      requestAnimationFrame(tick);
    });
    function tick(now) {
      requestAnimationFrame(tick);
      var dt = (now - last) / 1000; last = now;
      if (playing) { playhead += dt; if (playhead > loopEnd) playhead = loopStart; }
      tls.forEach(function (tl) { try { tl.time(Math.min(playhead, tl.duration())); } catch (e) {} });
      // The render's last frame is just before the end, so parking the
      // playhead at the very end shows that frame, not an empty stage.
      var t = Math.min(playhead, duration - 0.001);
      clips.forEach(function (c) {
        // No data-duration: a media clip runs its own length, anything else
        // stays to the end.
        var natural = c.media && isFinite(c.el.duration) ? c.el.duration : Infinity;
        var span = isFinite(c.duration) ? c.duration : natural;
        var live = t >= c.start && t < c.start + span;
        if (live !== c.live) { c.live = live; c.el.style.visibility = live ? '' : 'hidden'; }
        if (live && c.media && isFinite(natural)) {
          var at = Math.min(t - c.start, Math.max(0, natural - 0.001));
          // Skip near-identical seeks so playback stays smooth.
          try { if (Math.abs(c.el.currentTime - at) > 0.03) c.el.currentTime = at; } catch (e) {}
        }
      });
      parent.postMessage({ source: 'hf-preview', type: 'time', t: playhead, duration: duration }, '*');
    }`;
  // Media is referenced as a relative `assets/<key>` path (what the renderer
  // needs, since it writes files into the project's assets/ dir). The preview
  // iframe has no such dir, so rewrite those references to the served R2 URL.
  const rewritten = html.replace(/(["'(])assets\//g, "$1/api/uploads/");
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style>
<style id="om-unfitted">body > [data-composition-id]{opacity:0}</style>
</head><body>
${rewritten}
<script>${harness}</script>
</body></html>`;
}

export default app;
