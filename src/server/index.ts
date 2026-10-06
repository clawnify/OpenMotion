import { Hono } from "hono";
import { initDB, query, get, run } from "./db";
import {
  initUploads,
  putUpload,
  getUpload,
  getUploadRange,
  getUploadBytes,
  deleteUpload,
  makeKey,
} from "./uploads";
import { startRender } from "./render";
import { settle, type RenderJob, type SettleIO } from "./exports";
import { compositionLength, withLength } from "../shared/length";
import { lintComposition } from "./lint";
import { z } from "zod";
import { type ScreenDemoOptions, screenDemoHtml, screenDemoProblems, defaultSeconds, demoSpecOf, fitSeconds, minimumSeconds, replaceDemoSteps, withDemoSpec } from "../shared/screen-demo";
import { capturePage, outlinePage, getVideoRender, ClawnifyServicesError, type CaptureStep, type CapturedPage } from "@clawnify/services";
import { connect, type ConnectionsEnv, type CredentialBinding } from "@clawnify/connections";
import { caller, user } from "@clawnify/app";
import { audioDurationSeconds } from "./audio-duration";
import {
  ProviderError,
  composeMusic,
  deleteFalOutput,
  falResult,
  falStatus,
  isTransient,
  listVoices,
  soundEffect,
  speak,
  submitAurora,
} from "./providers";
import {
  DEFAULT_MAX_SECONDS,
  HARD_MAX_SECONDS,
  IMAGE_TYPES,
  OutputGone,
  audioProblem,
  costUsd,
  dataUri,
  presenterAssetName,
  settle as settlePresenter,
  type PresenterJob,
  type SettleIO as PresenterIO,
} from "./presenters";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  // Injected into every WfP app at deploy time; authorizes managed services.
  CLAWNIFY_TOKEN?: string;
  // Override for local dev (defaults to https://services.clawnify.com).
  SERVICES_URL?: string;
  // On Clawnify: the credentials broker and the org, for the org's fal.ai and
  // ElevenLabs connections (clawnify.json app.credentials).
  CREDENTIALS?: CredentialBinding;
  CLAWNIFY_ORG_ID?: string;
  // Self-hosted: the providers' own keys, used only when no Clawnify
  // connection can be reached (see providerKey).
  FAL_KEY?: string;
  ELEVENLABS_API_KEY?: string;
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
// assets by key. With composition_id the stills are swapped into that video
// and the rest of it (layout, clips, look) is left as it is; without it, a
// new one is made.
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
  // Into an existing composition, only its stills change (as a refresh does).
  const replaced = existing ? replaceDemoSteps(existing.html, opts.steps, opts.page ?? { width: 1600, height: 900 }) : null;
  if (existing && !replaced) return c.json({ error: "this composition has no demo stills to replace" }, 400);
  const html = replaced ?? screenDemoHtml(opts);

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
// What a demo keeps to be captured again: the walk, never the look. Layout
// and look options shape a new demo once; after that the composition is the
// user's, and a refresh changes its stills only.
type DemoSpec = {
  url: string;
  page?: { width: number; height: number };
  wait_gone?: string;
  steps: Record<string, unknown>[];
  allow_writes?: boolean;
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
  const spec: DemoSpec | null = b.url && b.steps
    ? { url: b.url, page: b.page, wait_gone: b.wait_gone, steps: b.steps, allow_writes: b.allow_writes }
    : before && { url: before.url, page: before.page, wait_gone: before.wait_gone, steps: before.steps, allow_writes: before.allow_writes };
  if (!spec) return c.json({ error: "url and steps are required, or the composition_id of a demo made here" }, 400);
  const look: z.infer<z.ZodObject<typeof lookSchema>> = Object.fromEntries(
    Object.entries(b).filter(([k, v]) => k in lookSchema && v !== undefined),
  );
  const notes: string[] = [];
  if (existing && Object.keys(look).length) {
    notes.push("Layout and look options shape a new demo only; this one kept its own. Change them in the editor.");
  }

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

  // Each still (and click motion video) into the media library, under keys
  // unique to this capture.
  const id = existing?.id ?? crypto.randomUUID();
  const prefix = `demo-${id.slice(0, 8)}-${lower8().slice(0, 6)}`;
  const keep = async (url: string, name: string, video?: { seconds: number }) => {
    const res = await fetch(url);
    if (!res.ok) throw new ClawnifyServicesError(`could not fetch a captured ${video ? "video" : "still"} (${res.status})`, { status: 502 });
    const data = await res.arrayBuffer();
    const type = video ? "video/mp4" : "image/png";
    const key = `${prefix}-${name}.${video ? "mp4" : "png"}`;
    await putUpload(key, data, type);
    await run("INSERT INTO assets (key, name, content_type, size, duration) VALUES (?, ?, ?, ?, ?)", [
      key,
      key,
      type,
      data.byteLength,
      video?.seconds ?? null,
    ]);
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
        motion: s.motion && s.click
          ? { src: `assets/${await keep(s.motion.video_url, `${i + 1}-motion`, s.motion)}`, seconds: s.motion.seconds }
          : undefined,
      });
    }
  } catch (err) {
    return captureFailed(c, err);
  }

  // A layout's clip (new demos only): an uploaded video, played for its own
  // length, and the steps spread over it unless the spec timed them itself.
  let layout: ScreenDemoOptions["layout"] = undefined;
  const l = existing ? undefined : look.layout;
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
  let html: string;
  if (existing) {
    // A refresh: new stills in place, everything else as the user left it.
    const replaced = replaceDemoSteps(existing.html, steps, captured.page);
    if (!replaced) return c.json({ error: "this composition has no demo stills to replace" }, 400);
    html = withDemoSpec(replaced, spec);
  } else {
    html = screenDemoHtml(opts);
  }

  if (existing) {
    await run(
      `UPDATE compositions SET name = ?, description = ?, html = ?, updated_at = datetime('now') WHERE id = ?`,
      [b.name ?? existing.name, b.description ?? existing.description, html, id],
    );
    // The stills and videos of the capture this one replaces: only keys this
    // endpoint made for this composition (demo-<id8>-<run>-…), never an upload
    // of the user's that happens to be named demo-something.
    const ours = new RegExp(`assets/(demo-${id.slice(0, 8)}-[0-9a-f]{6}-[0-9a-z-]+\\.(?:png|mp4))`, "g");
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
  return c.json({ ...(row && (await withLint(row))), warnings: [...captured.warnings, ...notes] }, existing ? 200 : 201);
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
// is unusably slow without 206 responses. A key can hold a slash (exports
// are renders/<name>.mp4), and the preview rewrites assets/<key> to this path
// unencoded, so the key is the whole rest of the path.
app.get("/api/uploads/:key{.+}", async (c) => {
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
// An export renders in the background on the managed render service: POST
// answers at once, and the job is finished by whoever looks at it next (the
// editor polling, an agent, the export list). See exports.ts.

function settleIO(env: Bindings): SettleIO {
  return {
    status: (id) => getVideoRender(servicesEnv(env), id),
    async keep(url, key) {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`could not fetch the finished render (${res.status})`);
      // R2 streams a body only when its length is known; a signed R2 link says it.
      const length = Number(res.headers.get("content-length"));
      if (length > 0) {
        await putUpload(key, res.body, "video/mp4");
        return length;
      }
      const bytes = await res.arrayBuffer();
      await putUpload(key, bytes, "video/mp4");
      return bytes.byteLength;
    },
    async asset(key, size, job) {
      // A finished composition is footage. Register it in the media library, so
      // it can be reused and, later, handed to OpenVideo as an editable clip.
      const comp = await get<{ name: string }>("SELECT name FROM compositions WHERE id = ?", [job.composition_id]);
      await run(
        "INSERT OR IGNORE INTO assets (id, key, name, content_type, size, duration) VALUES (?, ?, ?, 'video/mp4', ?, ?)",
        [lower16(), key, `${comp?.name ?? "Export"}.mp4`, size, job.seconds],
      );
      const row = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
      return row!.id;
    },
    async update(id, patch) {
      const cols = Object.keys(patch);
      await run(
        `UPDATE render_jobs SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
        [...cols.map((k) => patch[k as keyof typeof patch] ?? null), id],
      );
    },
  };
}

/** An export brought up to date, as stored (re-read when settling changed it). */
async function look(row: RenderJob, io: SettleIO) {
  const out = await settle(row, io);
  if (out.status === row.status) return out;
  return (await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [row.id])) ?? out;
}

// Newest first. ?composition_id narrows to one video; ?before=<id> pages back.
app.get("/api/renders", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
  const where: string[] = [];
  const args: unknown[] = [];
  const comp = c.req.query("composition_id");
  if (comp) {
    where.push("composition_id = ?");
    args.push(comp);
  }
  const before = Number(c.req.query("before"));
  if (before > 0) {
    where.push("id < ?");
    args.push(before);
  }
  const rows = await query<RenderJob>(
    `SELECT * FROM render_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    [...args, limit],
  );
  const io = settleIO(c.env);
  return c.json(await Promise.all(rows.map((r) => look(r, io))));
});

app.get("/api/renders/:id", async (c) => {
  const row = await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(await look(row, settleIO(c.env)));
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

  // Stated on the root, so the MP4 is as long as the preview and the timeline
  // say (see shared/length.ts).
  const html = withLength(comp.html);
  const res = await run(
    "INSERT INTO render_jobs (composition_id, status, seconds) VALUES (?, 'rendering', ?)",
    [composition_id, compositionLength(html)],
  );
  const jobId = res.lastInsertRowid as number;

  try {
    const assets = await query<Asset>("SELECT key FROM assets");
    const serviceJobId = await startRender(servicesEnv(c.env), {
      html,
      fps: comp.fps,
      assets,
      filename: `${makeKey(comp.name)}.mp4`,
    });
    await run("UPDATE render_jobs SET service_job_id = ? WHERE id = ?", [serviceJobId, jobId]);
  } catch (err) {
    await run(
      "UPDATE render_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
      [String(err instanceof Error ? err.message : err).slice(0, 1000), jobId],
    );
  }

  const job = await get<RenderJob>("SELECT * FROM render_jobs WHERE id = ?", [jobId]);
  return c.json(job, job?.status === "failed" ? 201 : 202);
});

// ── Voices, music, sound effects and presenters ──────────────────────
// Speech from a script, music and sound effects from a prompt (ElevenLabs),
// and a photo animated to speak a voice clip (fal.ai). All run on the user's
// own accounts. See presenters.ts.

const PROVIDER_NAMES = { falai: "fal.ai", elevenlabs: "ElevenLabs" } as const;
const SELF_HOSTED_KEY = { falai: "FAL_KEY", elevenlabs: "ELEVENLABS_API_KEY" } as const;

/**
 * The user's key for a provider. On Clawnify, the org's connection; nothing
 * else, so disconnecting it there turns the feature off. Self-hosted (no
 * Clawnify broker or token), the provider's own env var.
 */
async function providerKey(env: Bindings, service: "falai" | "elevenlabs"): Promise<string | null> {
  const viaClawnify = await connect(service, env as unknown as ConnectionsEnv).token();
  if (viaClawnify || env.CREDENTIALS || env.CLAWNIFY_TOKEN) return viaClawnify;
  return env[SELF_HOSTED_KEY[service]] ?? null;
}

function notConnected(env: Bindings, service: "falai" | "elevenlabs") {
  const how =
    env.CREDENTIALS || env.CLAWNIFY_TOKEN
      ? `connect ${PROVIDER_NAMES[service]} under Integrations in Clawnify`
      : `set ${SELF_HOSTED_KEY[service]}`;
  return { error: `${PROVIDER_NAMES[service]} is not connected: ${how}.`, service };
}

function providerFailure(err: unknown) {
  if (err instanceof ProviderError) return { error: err.message, provider: err.provider };
  throw err;
}

// The voices in the user's ElevenLabs account. ?search, ?category
// (premade | cloned | generated | professional), ?page_token from the last page.
app.get("/api/voices", async (c) => {
  const key = await providerKey(c.env, "elevenlabs");
  if (!key) return c.json(notConnected(c.env, "elevenlabs"), 409);
  try {
    return c.json(
      await listVoices(key, {
        search: c.req.query("search") || undefined,
        category: c.req.query("category") || undefined,
        pageToken: c.req.query("page_token") || undefined,
        pageSize: Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100),
      }),
    );
  } catch (err) {
    return c.json(providerFailure(err), 502);
  }
});

const speechBody = z
  .object({
    voice_id: z.string().min(1).max(100),
    script: z.string().min(1).max(10_000),
    /** ElevenLabs model; theirs (eleven_multilingual_v2) when omitted. */
    voice_model: z.string().min(1).max(100).optional(),
    /** ElevenLabs voice_settings, passed through: stability, similarity_boost, style, speed, ... */
    voice_settings: z.record(z.unknown()).optional(),
    /** Library name. Default: the script's first words. */
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

// Script -> speech in one of the user's voices -> an MP3 in the media library.
// A voiceover on its own, or the voice of a presenter.
app.post("/api/speech", async (c) => {
  const parsed = speechBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid speech request", problems: problems(parsed.error) }, 422);
  const b = parsed.data;
  const key = await providerKey(c.env, "elevenlabs");
  if (!key) return c.json(notConnected(c.env, "elevenlabs"), 409);

  let audio: Uint8Array;
  try {
    audio = await speak(key, { voiceId: b.voice_id, text: b.script, modelId: b.voice_model, voiceSettings: b.voice_settings });
  } catch (err) {
    return c.json(providerFailure(err), 502);
  }
  return c.json(await saveMp3(audio, "voice", b.name ?? `Voiceover - ${firstWords(b.script)}`), 201);
});

/** "Upbeat lo-fi beat, warm keys." -> "Upbeat lo-fi beat, warm keys" (a library name). */
function firstWords(text: string): string {
  return text.trim().split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
}

/** A generated MP3 into the media library, with its length read from the file. */
async function saveMp3(audio: Uint8Array, folder: string, name: string): Promise<Asset | undefined> {
  const assetKey = `${folder}/${lower16()}.mp3`;
  await putUpload(assetKey, audio, "audio/mpeg");
  const id = lower16();
  await run("INSERT INTO assets (id, key, name, content_type, size, duration) VALUES (?, ?, ?, 'audio/mpeg', ?, ?)", [
    id,
    assetKey,
    `${name}.mp3`,
    audio.byteLength,
    audioDurationSeconds(audio),
  ]);
  return get<Asset>("SELECT * FROM assets WHERE id = ?", [id]);
}

const musicBody = z
  .object({
    /** Genre, mood, instruments, tempo: "warm lo-fi beat, soft keys, 90 bpm". */
    prompt: z.string().min(1).max(4000),
    /** Length; set it to the video's. ElevenLabs makes 3 to 600 seconds. */
    seconds: z.number().min(3).max(600),
    /** No vocals (the default): a bed under a voiceover must not sing over it. */
    instrumental: z.boolean().default(true),
    /** ElevenLabs model; theirs (music_v1) when omitted. */
    music_model: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

// Prompt -> a piece of music of a set length -> an MP3 in the media library.
// The bed under a video. Answers when the track is done (tens of seconds).
app.post("/api/music", async (c) => {
  const parsed = musicBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid music request", problems: problems(parsed.error) }, 422);
  const b = parsed.data;
  const key = await providerKey(c.env, "elevenlabs");
  if (!key) return c.json(notConnected(c.env, "elevenlabs"), 409);

  let audio: Uint8Array;
  try {
    audio = await composeMusic(key, { prompt: b.prompt, seconds: b.seconds, instrumental: b.instrumental, modelId: b.music_model });
  } catch (err) {
    return c.json(providerFailure(err), 502);
  }
  return c.json(await saveMp3(audio, "music", b.name ?? `Music - ${firstWords(b.prompt)}`), 201);
});

const soundEffectBody = z
  .object({
    /** What it sounds like: "soft whoosh, left to right", "mouse click". */
    prompt: z.string().min(1).max(1000),
    /** 0.5 to 30 seconds; ElevenLabs picks a length when omitted. */
    seconds: z.number().min(0.5).max(30).optional(),
    /** Ends where it starts, to repeat seamlessly. */
    loop: z.boolean().optional(),
    /** 0 to 1: higher follows the prompt more literally (theirs is 0.3). */
    prompt_influence: z.number().min(0).max(1).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

// Prompt -> a sound effect -> an MP3 in the media library: a whoosh on a
// transition, a click on a tap, a riser before a reveal.
app.post("/api/sound-effects", async (c) => {
  const parsed = soundEffectBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid sound effect request", problems: problems(parsed.error) }, 422);
  const b = parsed.data;
  const key = await providerKey(c.env, "elevenlabs");
  if (!key) return c.json(notConnected(c.env, "elevenlabs"), 409);

  let audio: Uint8Array;
  try {
    audio = await soundEffect(key, { prompt: b.prompt, seconds: b.seconds, loop: b.loop, promptInfluence: b.prompt_influence });
  } catch (err) {
    return c.json(providerFailure(err), 502);
  }
  return c.json(await saveMp3(audio, "sfx", b.name ?? `Sound - ${firstWords(b.prompt)}`), 201);
});

const presenterBody = z
  .object({
    /** The photo: a media-library image (PNG, JPEG or WebP). */
    image_asset_id: z.string().min(1),
    /** The voice: a media-library MP3 or WAV, e.g. from POST /api/speech. */
    audio_asset_id: z.string().min(1),
    /** How the person should come across: gestures, expression, energy. */
    video_prompt: z.string().min(1).max(2000).optional(),
    resolution: z.enum(["480p", "720p"]).default("480p"),
    /** Longest voice clip accepted, in seconds. Longer is refused before anything is spent. */
    max_seconds: z.number().int().min(1).max(HARD_MAX_SECONDS).default(DEFAULT_MAX_SECONDS),
    /** Confirms the person shown agreed to be animated. Recorded with the job. */
    consent: z.literal(true, { errorMap: () => ({ message: "must be true: the person shown agreed to be animated" }) }),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * The photo and voice travel to fal.ai inside the request, as base64 in JSON:
 * roughly four copies in memory at once, so 8 MB stays well inside the app
 * Worker's 128 MB. A minute of 128 kbps MP3 is about 1 MB, a photo a few MB.
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

// Photo + voice clip -> a video of that person speaking, generated at fal.ai in
// the background. Answers 202 with the job; GET /api/presenters/:id finishes it.
app.post("/api/presenters", async (c) => {
  const parsed = presenterBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid presenter request", problems: problems(parsed.error) }, 422);
  const b = parsed.data;

  const image = await get<Asset>("SELECT * FROM assets WHERE id = ?", [b.image_asset_id]);
  if (!image) return c.json({ error: "image_asset_id: no such asset" }, 404);
  if (!IMAGE_TYPES.has(image.content_type)) {
    return c.json({ error: `The photo must be PNG, JPEG or WebP, not ${image.content_type}.` }, 422);
  }
  const audio = await get<Asset>("SELECT * FROM assets WHERE id = ?", [b.audio_asset_id]);
  if (!audio) return c.json({ error: "audio_asset_id: no such asset" }, 404);
  if (image.size + audio.size > MAX_INLINE_BYTES) {
    return c.json({ error: "The photo and voice clip together are over 8 MB. Use a smaller photo or a shorter clip." }, 413);
  }

  const key = await providerKey(c.env, "falai");
  if (!key) return c.json(notConnected(c.env, "falai"), 409);

  const [imageBytes, audioBytes] = await Promise.all([getUploadBytes(image.key), getUploadBytes(audio.key)]);
  if (!imageBytes || !audioBytes) return c.json({ error: "The photo or voice clip is missing from storage." }, 404);
  const voice = new Uint8Array(audioBytes);
  const seconds = audioDurationSeconds(voice);
  const problem = audioProblem(seconds, b.max_seconds, b.resolution);
  if (problem) return c.json({ error: problem, audio_seconds: seconds }, 422);

  let fal;
  try {
    fal = await submitAurora(key, {
      image: dataUri(new Uint8Array(imageBytes), image.content_type),
      audio: dataUri(voice, voice[0] === 0x52 ? "audio/wav" : "audio/mpeg"),
      prompt: b.video_prompt,
      resolution: b.resolution,
    });
  } catch (err) {
    return c.json(providerFailure(err), 502);
  }

  const id = crypto.randomUUID();
  const who = user(c);
  await run(
    `INSERT INTO presenter_jobs (id, name, image_asset_id, audio_asset_id, video_prompt, resolution, audio_seconds,
       estimated_cost_usd, fal_request_id, fal_status_url, fal_response_url, consent_by, consent_caller, consent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      id,
      b.name ?? image.name.replace(/\.[^.]+$/, ""),
      image.id,
      audio.id,
      b.video_prompt ?? null,
      b.resolution,
      seconds,
      costUsd(seconds!, b.resolution),
      fal.request_id,
      fal.status_url,
      fal.response_url,
      who?.email ?? null,
      caller(c),
    ],
  );
  return c.json(await get<PresenterJob>("SELECT * FROM presenter_jobs WHERE id = ?", [id]), 202);
});

function presenterIO(env: Bindings, falKey: string): PresenterIO {
  return {
    status: (job) => falStatus(falKey, job.fal_status_url),
    result: (job) => falResult(falKey, job.fal_response_url),
    async keep(url, key) {
      const res = await fetch(url);
      // A 4xx from fal's CDN means the file is gone (expired); waiting won't bring it back.
      if (!res.ok && !isTransient(res.status)) throw new OutputGone(`fal.ai answered ${res.status} for the video`);
      if (!res.ok || !res.body) throw new Error(`could not fetch the finished video from fal.ai (${res.status})`);
      const length = Number(res.headers.get("content-length"));
      if (length > 0) {
        await putUpload(key, res.body, "video/mp4");
        return length;
      }
      const bytes = await res.arrayBuffer();
      await putUpload(key, bytes, "video/mp4");
      return bytes.byteLength;
    },
    discard: (job) => deleteFalOutput(falKey, job.fal_request_id),
    async asset(key, size, job) {
      await run(
        "INSERT OR IGNORE INTO assets (id, key, name, content_type, size, duration) VALUES (?, ?, ?, 'video/mp4', ?, ?)",
        [lower16(), key, presenterAssetName(job.name), size, job.audio_seconds],
      );
      const row = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
      return row!.id;
    },
    async update(id, patch) {
      const cols = Object.keys(patch);
      await run(
        `UPDATE presenter_jobs SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
        [...cols.map((k) => patch[k as keyof typeof patch] ?? null), id],
      );
    },
  };
}

/** A presenter brought up to date, as stored. Without a fal.ai key it is shown as it was. */
async function lookPresenter(row: PresenterJob, env: Bindings) {
  if (row.status !== "generating") return row;
  const key = await providerKey(env, "falai");
  if (!key) return row;
  let out;
  try {
    out = await settlePresenter(row, presenterIO(env, key));
  } catch (err) {
    // Copying the finished video failed this time. The job stays generating
    // and the next look tries again (fal keeps the output for an hour).
    console.error(err);
    return row;
  }
  if (out.status === row.status) return out;
  return (await get<PresenterJob>("SELECT * FROM presenter_jobs WHERE id = ?", [row.id])) ?? out;
}

// Newest first. ?before=<id of the last presenter on the page> pages back.
// created_at has one-second resolution, so the id breaks ties: no row is
// skipped or repeated when several start in the same second.
app.get("/api/presenters", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
  const before = c.req.query("before");
  const after = before
    ? await get<{ created_at: string; id: string }>("SELECT created_at, id FROM presenter_jobs WHERE id = ?", [before])
    : null;
  if (before && !after) return c.json({ error: "before: no such presenter" }, 404);
  const rows = await query<PresenterJob>(
    `SELECT * FROM presenter_jobs ${after ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : ""}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    after ? [after.created_at, after.created_at, after.id, limit] : [limit],
  );
  return c.json(await Promise.all(rows.map((r) => lookPresenter(r, c.env))));
});

app.get("/api/presenters/:id", async (c) => {
  const row = await get<PresenterJob>("SELECT * FROM presenter_jobs WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(await lookPresenter(row, c.env));
});

function problems(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
}

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
      // An <audio> clip plays at its data-volume, as in the render (a browser
      // stops at 1, so a boost plays at full). Set before the timelines
      // render their start, so a tween on the clip's volume wins.
      document.querySelectorAll('audio.clip[data-volume]').forEach(function (el) {
        var gain = parseFloat(el.getAttribute('data-volume'));
        if (isFinite(gain)) el.volume = Math.max(0, Math.min(1, gain));
      });
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
      // Video and audio play on their own clock while the preview plays and
      // are re-seeked only after a real jump (a loop, a scrub), as OpenVideo
      // does: a seek empties the decoder's buffer, so seeking every frame
      // stalls them. Paused, they follow the playhead closely, so scrubbing
      // shows the frame the render will. A <video> is muted, as HyperFrames
      // renders it; sound comes from an <audio> clip, which plays.
      clips = [].slice.call(document.querySelectorAll('.clip')).map(function (el) {
        var media = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
        if (media) { try { if (el.tagName === 'VIDEO') el.muted = true; el.pause(); } catch (e) {} }
        return { el: el, media: media, start: parseFloat(el.getAttribute('data-start')) || 0,
                 duration: parseFloat(el.getAttribute('data-duration')) };
      });
      parent.postMessage({ source: 'hf-preview', type: 'meta', duration: duration }, '*');
      last = performance.now();
      requestAnimationFrame(tick);
    });
    // One media clip against the playhead: \`at\` is where in the clip it
    // should be. Playing, drift is tolerated (0.75 s video, 0.25 s audio) and
    // only a jump re-seeks; paused, it follows within 0.05 s. Past the clip's
    // end it holds the last frame, as the render does.
    function syncMedia(el, live, at, natural) {
      try {
        if (!live) { if (!el.paused) el.pause(); return; }
        if (at >= natural) {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - (natural - 0.001)) > 0.05) el.currentTime = natural - 0.001;
          return;
        }
        var drift = playing ? (el.tagName === 'AUDIO' ? 0.25 : 0.75) : 0.05;
        if (!el.seeking && Math.abs(el.currentTime - at) > drift) el.currentTime = at;
        if (playing && el.paused) { var started = el.play(); if (started && started.catch) started.catch(function () {}); }
        if (!playing && !el.paused) el.pause();
      } catch (e) {}
    }
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
        if (c.media) syncMedia(c.el, live && isFinite(natural), t - c.start, natural);
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
