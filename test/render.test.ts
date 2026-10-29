import { test } from "node:test";
import assert from "node:assert/strict";
import { ClawnifyServicesError, type StagedFile, type VideoAsset } from "@clawnify/services";
import { MAX_INLINE_BYTES, startRender, stagedSrc, type RenderAsset, type RenderIO } from "../src/server/render.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function asset(over: Partial<RenderAsset> = {}): RenderAsset {
  return {
    id: "a1",
    key: "demo.mp4",
    content_type: "video/mp4",
    size: 36_000_000,
    service_key: null,
    service_key_expires_at: null,
    ...over,
  };
}

/** A fake world. `refuse` lists service error codes for the first start calls, in order. */
function world(refuse: string[] = []) {
  const calls: string[] = [];
  const started: VideoAsset[][] = [];
  let n = 0;
  const io: RenderIO = {
    async stage(a) {
      calls.push(`stage ${a.key}`);
      n += 1;
      const key = `stage/tok/${n}.mp4`;
      return { src: `file:${key}`, key, size: a.size, content_type: a.content_type, expires_at: new Date(NOW + 30 * DAY).toISOString() } satisfies StagedFile;
    },
    async remember(id, staged) {
      calls.push(`remember ${id} ${staged?.key ?? null}`);
    },
    async bytes(key) {
      calls.push(`bytes ${key}`);
      return new TextEncoder().encode("<svg/>").buffer as ArrayBuffer;
    },
    async start(opts) {
      started.push(opts.assets);
      const code = refuse.shift();
      if (code) throw new ClawnifyServicesError(code, { status: 422, code });
      return "job-1";
    },
  };
  return { io, calls, started };
}

const html = (...keys: string[]) => `<div id="root">${keys.map((k) => `<video src="assets/${k}"></video>`).join("")}</div>`;
const args = (assets: RenderAsset[], keys: string[]) => ({ html: html(...keys), fps: 30, assets, filename: "x.mp4" });

test("a big clip is staged, never read into memory, and its pointer kept", async () => {
  const w = world();
  const id = await startRender(w.io, args([asset()], ["demo.mp4"]), NOW);
  assert.equal(id, "job-1");
  assert.deepEqual(w.calls, ["stage demo.mp4", "remember a1 stage/tok/1.mp4"]);
  assert.deepEqual(w.started[0], [{ path: "demo.mp4", src: "file:stage/tok/1.mp4" }]);
});

test("a kept copy with days left is reused; one about to expire is staged again", async () => {
  const fresh = asset({ service_key: "stage/tok/old.mp4", service_key_expires_at: new Date(NOW + 10 * DAY).toISOString() });
  const w = world();
  await startRender(w.io, args([fresh], ["demo.mp4"]), NOW);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.started[0], [{ path: "demo.mp4", src: "file:stage/tok/old.mp4" }]);

  const ending = { ...fresh, service_key_expires_at: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() };
  assert.equal(stagedSrc(ending, NOW), null);
  const w2 = world();
  await startRender(w2.io, args([ending], ["demo.mp4"]), NOW);
  assert.deepEqual(w2.calls, ["stage demo.mp4", "remember a1 stage/tok/1.mp4"]);
});

test("only the files the HTML uses go; what cannot be staged goes inline", async () => {
  const w = world();
  const svg = asset({ id: "a2", key: "logo.svg", content_type: "image/svg+xml", size: 6 });
  const unused = asset({ id: "a3", key: "other.mp4" });
  await startRender(w.io, args([asset(), svg, unused], ["demo.mp4", "logo.svg"]), NOW);
  assert.deepEqual(w.started[0], [
    { path: "demo.mp4", src: "file:stage/tok/1.mp4" },
    { path: "logo.svg", dataBase64: btoa("<svg/>") },
  ]);
  assert.ok(!w.calls.some((c) => c.includes("other.mp4")));
});

test("a kept copy the service no longer has is staged again, once", async () => {
  const kept = asset({ service_key: "stage/oldtoken/x.mp4", service_key_expires_at: new Date(NOW + 10 * DAY).toISOString() });
  const w = world(["forbidden_source"]);
  assert.equal(await startRender(w.io, args([kept], ["demo.mp4"]), NOW), "job-1");
  assert.deepEqual(w.started.map((a) => a[0].src), ["file:stage/oldtoken/x.mp4", "file:stage/tok/1.mp4"]);

  const w2 = world(["staged_file_missing", "staged_file_missing"]);
  await assert.rejects(startRender(w2.io, args([kept], ["demo.mp4"]), NOW), { code: "staged_file_missing" });
  assert.equal(w2.started.length, 2);
});

test("other refusals are not retried", async () => {
  const w = world(["quota_exceeded"]);
  await assert.rejects(startRender(w.io, args([asset()], ["demo.mp4"]), NOW), { code: "quota_exceeded" });
  assert.equal(w.started.length, 1);
});

test("too much that cannot be staged fails before anything is read", async () => {
  const w = world();
  const fonts = [1, 2].map((i) => asset({ id: `f${i}`, key: `font${i}.woff2`, content_type: "font/woff2", size: MAX_INLINE_BYTES / 2 + 1 }));
  await assert.rejects(startRender(w.io, args(fonts, ["font1.woff2", "font2.woff2"]), NOW), /over 20 MB together/);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.started, []);
});

test("an upload gone from storage is left out, and its pointer cleared", async () => {
  const w = world();
  w.io.stage = async () => null;
  await startRender(w.io, args([asset()], ["demo.mp4"]), NOW);
  assert.deepEqual(w.calls, ["remember a1 null"]);
  assert.deepEqual(w.started[0], []);
});
