import { test } from "node:test";
import assert from "node:assert/strict";
import { ORPHAN_MS, exportKey, settle, type RenderJob, type SettleIO } from "../src/server/exports.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");

function job(over: Partial<RenderJob> = {}): RenderJob {
  return {
    id: 7,
    composition_id: "c1",
    status: "rendering",
    output_url: null,
    error: null,
    asset_id: null,
    service_job_id: "3f1c2b9e-0000-4000-8000-000000000001",
    seconds: 12.5,
    created_at: "2026-10-05 11:59:00",
    updated_at: "2026-10-05 11:59:00",
    ...over,
  };
}

/** A fake world: the service answers `answer`; every call is recorded. */
function io(answer: Awaited<ReturnType<SettleIO["status"]>> | Error) {
  const calls: string[] = [];
  const updates: unknown[] = [];
  const fake: SettleIO = {
    async status(id) {
      calls.push(`status ${id}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async keep(url, key) {
      calls.push(`keep ${url} -> ${key}`);
      return 1234;
    },
    async asset(key, size, j) {
      calls.push(`asset ${key} ${size} ${j.seconds}`);
      return "a1";
    },
    async update(id, patch) {
      updates.push({ id, ...patch });
    },
  };
  return { fake, calls, updates };
}

test("a finished or failed export is left as it is", async () => {
  const w = io(new Error("must not be asked"));
  for (const status of ["completed", "failed"] as const) {
    const j = job({ status });
    assert.deepEqual(await settle(j, w.fake, NOW), j);
  }
  assert.deepEqual(w.calls, []);
});

test("still rendering: says whether it waits for other renders or runs", async () => {
  for (const status of ["queued", "running"] as const) {
    const w = io({ job_id: "x", status });
    const out = await settle(job(), w.fake, NOW);
    assert.equal(out.status, "rendering");
    assert.equal(out.phase, status);
    assert.deepEqual(w.updates, []);
  }
});

test("done: the file is copied into uploads, becomes an asset, and the export completes", async () => {
  const w = io({ job_id: "x", status: "done", url: "https://r2.example/out.mp4?sig" });
  const out = await settle(job(), w.fake, NOW);
  const key = "renders/3f1c2b9e-0000-4000-8000-000000000001.mp4";
  assert.equal(exportKey(job().service_job_id!), key);
  assert.deepEqual(w.calls.slice(1), [`keep https://r2.example/out.mp4?sig -> ${key}`, `asset ${key} 1234 12.5`]);
  const output_url = `/api/uploads/${encodeURIComponent(key)}`;
  assert.deepEqual(w.updates, [{ id: 7, status: "completed", output_url, asset_id: "a1" }]);
  assert.equal(out.status, "completed");
  assert.equal(out.output_url, output_url);
});

test("settling the same finished export twice writes the same file, not a second one", async () => {
  const a = io({ job_id: "x", status: "done", url: "https://r2.example/out.mp4" });
  const b = io({ job_id: "x", status: "done", url: "https://r2.example/out.mp4" });
  await settle(job(), a.fake, NOW);
  await settle(job(), b.fake, NOW);
  assert.deepEqual(a.calls, b.calls);
});

test("failed: the renderer's reason is kept on the export", async () => {
  const w = io({ job_id: "x", status: "failed", error: "render_failed", detail: "render failed\nChrome crashed" });
  const out = await settle(job(), w.fake, NOW);
  assert.equal(out.status, "failed");
  assert.equal(out.error, "render failed\nChrome crashed");
  assert.deepEqual(w.updates, [{ id: 7, status: "failed", error: "render failed\nChrome crashed" }]);
});

test("the service cannot be asked: nothing changes, the next look tries again", async () => {
  const w = io(new Error("network"));
  const j = job();
  assert.deepEqual(await settle(j, w.fake, NOW), j);
  assert.deepEqual(w.updates, []);
});

test("an export from before background renders fails once it is clearly abandoned", async () => {
  const young = job({ service_job_id: null, created_at: "2026-10-05 11:55:00" });
  const w = io(new Error("must not be asked"));
  assert.deepEqual(await settle(young, w.fake, NOW), young);

  const old = job({ service_job_id: null, created_at: "2026-10-05 11:49:59" });
  assert.ok(NOW - Date.parse("2026-10-05T11:49:59Z") > ORPHAN_MS);
  const out = await settle(old, w.fake, NOW);
  assert.equal(out.status, "failed");
  assert.match(out.error!, /Export again/);
  assert.deepEqual(w.calls, []);
});
