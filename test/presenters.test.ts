import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OutputGone,
  STALL_MS,
  audioProblem,
  costUsd,
  dataUri,
  presenterAssetName,
  presenterKey,
  settle,
  type PresenterJob,
  type SettleIO,
} from "../src/server/presenters.ts";
import { audioDurationSeconds } from "../src/server/audio-duration.ts";
import { falResult, falStatus, listVoices, speak, submitAurora } from "../src/server/providers.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");

function job(over: Partial<PresenterJob> = {}): PresenterJob {
  return {
    id: "p1",
    name: "Ric",
    status: "generating",
    image_asset_id: "img",
    audio_asset_id: "aud",
    video_prompt: null,
    resolution: "480p",
    audio_seconds: 31.7,
    estimated_cost_usd: 2.24,
    fal_request_id: "req-1",
    fal_status_url: "https://queue.fal.run/fal-ai/creatify/requests/req-1/status",
    fal_response_url: "https://queue.fal.run/fal-ai/creatify/requests/req-1",
    asset_id: null,
    error: null,
    consent_by: "ric@example.com",
    consent_caller: "user",
    consent_at: "2026-10-05 11:58:00",
    created_at: "2026-10-05 11:58:00",
    updated_at: "2026-10-05 11:58:00",
    ...over,
  };
}

/**
 * A fake world where fal says `status` (or can't be reached), answers `result`
 * (or throws it), and the copy succeeds or throws `keepFails`. Every call is recorded.
 */
function io(
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | Error,
  result: { videoUrl: string } | { error: string } | Error = { videoUrl: "https://v3b.fal.media/out.mp4" },
  keepFails?: Error,
) {
  const calls: string[] = [];
  const updates: unknown[] = [];
  const fake: SettleIO = {
    async status() {
      calls.push("status");
      if (status instanceof Error) throw status;
      return status;
    },
    async result() {
      calls.push("result");
      if (result instanceof Error) throw result;
      return result;
    },
    async keep(url, key) {
      calls.push(`keep ${url} -> ${key}`);
      if (keepFails) throw keepFails;
      return 2_434_324;
    },
    async discard(j) {
      calls.push(`discard ${j.fal_request_id}`);
      throw new Error("fal refused: not an admin key");
    },
    async asset(key, size) {
      calls.push(`asset ${key} ${size}`);
      return "asset-9";
    },
    async update(id, patch) {
      updates.push({ id, ...patch });
    },
  };
  return { fake, calls, updates };
}

test("a generating presenter reports where fal has it, and changes nothing", async () => {
  for (const [state, phase] of [["IN_QUEUE", "queued"], ["IN_PROGRESS", "running"]] as const) {
    const w = io(state);
    const out = await settle(job(), w.fake, NOW);
    assert.equal(out.phase, phase);
    assert.equal(out.status, "generating");
    assert.deepEqual(w.updates, []);
  }
});

test("a finished presenter is copied in, registered as generated media, and completed", async () => {
  const w = io("COMPLETED");
  const out = await settle(job(), w.fake, NOW);
  // fal is asked to drop its copy once ours is saved; a refusal (here) changes nothing.
  assert.deepEqual(w.calls, [
    "status",
    "result",
    "keep https://v3b.fal.media/out.mp4 -> presenters/req-1.mp4",
    "asset presenters/req-1.mp4 2434324",
    "discard req-1",
  ]);
  assert.deepEqual(w.updates, [{ id: "p1", status: "completed", asset_id: "asset-9" }]);
  assert.equal(out.status, "completed");
  assert.equal(presenterKey("req-1"), "presenters/req-1.mp4");
  assert.equal(presenterAssetName("Ric"), "Ric (AI presenter).mp4");
});

test("a generation fal failed is marked failed with fal's reason", async () => {
  const w = io("COMPLETED", { error: "fal.ai answered 422: face not detected" });
  const out = await settle(job(), w.fake, NOW);
  assert.equal(out.status, "failed");
  assert.match(out.error ?? "", /face not detected/);
  assert.ok(!w.calls.some((c) => c.startsWith("keep")));
});

test("a video that expired at fal before anyone saved it fails the job, instead of generating forever", async () => {
  const w = io("COMPLETED", undefined, new OutputGone("fal.ai answered 404 for the video"));
  const out = await settle(job(), w.fake, NOW);
  assert.equal(out.status, "failed");
  assert.match(out.error ?? "", /expired at fal\.ai before it was saved/);
  assert.ok(!w.calls.some((c) => c.startsWith("asset")));
});

test("a blip asking for the result or copying the video keeps the paid job for the next look", async () => {
  for (const w of [io("COMPLETED", new Error("fal.ai answered 502")), io("COMPLETED", undefined, new Error("connection reset"))]) {
    await assert.rejects(settle(job(), w.fake, NOW));
    assert.deepEqual(w.updates, []);
  }
});

test("fal unreachable for a moment leaves the job as it was; one stuck for hours fails", async () => {
  const blip = io(new Error("network"));
  assert.equal((await settle(job(), blip.fake, NOW)).status, "generating");
  assert.deepEqual(blip.updates, []);

  const stuck = io("IN_QUEUE");
  const old = job({ created_at: new Date(NOW - STALL_MS - 1000).toISOString().replace("T", " ").slice(0, 19) });
  assert.equal((await settle(old, stuck.fake, NOW)).status, "failed");
});

test("a job that already ended is never touched again", async () => {
  const w = io("COMPLETED");
  for (const status of ["completed", "failed"] as const) {
    assert.equal((await settle(job({ status }), w.fake, NOW)).status, status);
  }
  assert.deepEqual(w.calls, []);
});

test("the voice clip's length is checked against the cap before spending, with what it would cost", () => {
  assert.equal(audioProblem(31.7, 60, "480p"), null);
  assert.match(audioProblem(75.2, 60, "480p") ?? "", /runs 75 s, over max_seconds \(60\).*\$5\.32/);
  assert.match(audioProblem(null, 60, "480p") ?? "", /MP3 or WAV/);
  // fal bills whole seconds, rounded up.
  assert.equal(costUsd(31.7, "480p"), 2.24);
  assert.equal(costUsd(31.7, "720p"), 4.48);
});

/** A constant-bitrate MP3 (MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono) of about `seconds`. */
function mp3(seconds: number): Uint8Array {
  const frameLength = 417;
  const frames = Math.round((seconds * 128_000) / 8 / frameLength);
  const out = new Uint8Array(frames * frameLength);
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0xc0], f * frameLength);
  return out;
}

/** A 16-bit mono PCM WAV of `seconds` at 8 kHz. */
function wav(seconds: number): Uint8Array {
  const data = seconds * 16000;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => (b[at + i] = ch.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, data, true);
  return b;
}

test("audio length is read from MP3 and WAV headers, and nothing else passes for audio", () => {
  assert.ok(Math.abs((audioDurationSeconds(mp3(12)) ?? 0) - 12) < 0.1);
  assert.equal(audioDurationSeconds(wav(4)), 4);
  assert.equal(audioDurationSeconds(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])), null);
  // Two bytes that look like an MP3 sync word, with no second frame behind them (a PNG once read as 11.7 s).
  assert.equal(audioDurationSeconds(new Uint8Array([1, 2, 0xff, 0xfb, 0x90, 0xc0, ...new Array(2000).fill(7)])), null);
});

test("a large file becomes a data: URI without overflowing the stack", () => {
  const uri = dataUri(new Uint8Array(1_000_000).fill(65), "audio/mpeg");
  assert.ok(uri.startsWith("data:audio/mpeg;base64,QUFB"));
  assert.equal(uri.length, "data:audio/mpeg;base64,".length + Math.ceil(1_000_000 / 3) * 4);
});

/** Swap global fetch for one call, recording what was sent. */
async function withFetch<T>(answer: Response, run: () => Promise<T>) {
  const sent: Array<{ url: string; init?: RequestInit }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer;
  }) as typeof fetch;
  try {
    return { out: await run(), sent };
  } finally {
    globalThis.fetch = real;
  }
}

test("fal.ai is asked to keep nothing, and the key never leaves fal's queue host", async () => {
  const { out, sent } = await withFetch(
    Response.json({ request_id: "req-1", status_url: "https://queue.fal.run/x/status", response_url: "https://queue.fal.run/x" }),
    () => submitAurora("fal-key", { image: "data:image/png;base64,AA", audio: "data:audio/mpeg;base64,AA", resolution: "480p", prompt: "warm" }),
  );
  assert.equal(out.request_id, "req-1");
  const headers = new Headers(sent[0].init?.headers);
  assert.equal(sent[0].url, "https://queue.fal.run/fal-ai/creatify/aurora");
  assert.equal(headers.get("authorization"), "Key fal-key");
  assert.equal(headers.get("x-fal-store-io"), "0");
  // A week: long enough that a job nobody looks at for a while is still saved.
  assert.deepEqual(JSON.parse(headers.get("x-fal-object-lifecycle-preference") ?? ""), { expiration_duration_seconds: 604800 });
  assert.deepEqual(JSON.parse(String(sent[0].init?.body)), {
    image_url: "data:image/png;base64,AA",
    audio_url: "data:audio/mpeg;base64,AA",
    resolution: "480p",
    prompt: "warm",
  });

  await assert.rejects(falStatus("fal-key", "https://evil.example/status"), /not a fal.ai queue link/);
});

test("fal's result: a 5xx or 429 is asked again later, a 4xx is the job's failure", async () => {
  const url = "https://queue.fal.run/fal-ai/creatify/requests/req-1";
  for (const status of [502, 503, 429]) {
    const r = withFetch(new Response("busy", { status }), () => falResult("fal-key", url));
    await assert.rejects(r, new RegExp(`answered ${status}`));
  }
  const bad = await withFetch(Response.json({ detail: "face not detected" }, { status: 422 }), () => falResult("fal-key", url));
  assert.deepEqual(Object.keys(bad.out), ["error"]);
  assert.match((bad.out as { error: string }).error, /422.*face not detected/);
});

test("speech passes the voice, model and settings through, and voices come back trimmed and paged", async () => {
  const { sent } = await withFetch(new Response(new Uint8Array([0xff, 0xfb])), () =>
    speak("el-key", { voiceId: "ric clone", text: "Hello", modelId: "eleven_v3", voiceSettings: { stability: 0.5 } }),
  );
  assert.equal(sent[0].url, "https://api.elevenlabs.io/v1/text-to-speech/ric%20clone?output_format=mp3_44100_128");
  assert.equal(new Headers(sent[0].init?.headers).get("xi-api-key"), "el-key");
  assert.deepEqual(JSON.parse(String(sent[0].init?.body)), { text: "Hello", model_id: "eleven_v3", voice_settings: { stability: 0.5 } });

  const voices = await withFetch(
    Response.json({ voices: [{ voice_id: "v1", name: "Ric", category: "cloned", labels: { accent: "italian" }, preview_url: "https://x/p.mp3", extra: 1 }], has_more: true, next_page_token: "t2", total_count: 40 }),
    () => listVoices("el-key", { search: "ric", category: "cloned" }),
  );
  assert.equal(voices.sent[0].url, "https://api.elevenlabs.io/v2/voices?page_size=30&search=ric&category=cloned");
  assert.deepEqual(voices.out, {
    voices: [{ voice_id: "v1", name: "Ric", category: "cloned", description: null, labels: { accent: "italian" }, preview_url: "https://x/p.mp3" }],
    next_page_token: "t2",
  });
});
