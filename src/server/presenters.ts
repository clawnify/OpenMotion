// Presenters: a photo of a person and a voice clip, turned into a video of that
// person speaking (fal.ai's Creatify Aurora). The result is an ordinary video
// in the media library, used like any other clip (a screen demo's "pip" or
// "split" layout, or a layer of its own).
//
// One row per generation in presenter_jobs. Nothing runs in the background:
// whoever looks at a job (the editor polling, an agent) brings it up to date,
// the same way exports settle (exports.ts). Every step is safe to run twice.
//
// Pure: the routes in index.ts hand in what talks to fal.ai, storage and D1.

export type Resolution = "480p" | "720p";

/**
 * fal.ai's price per output second for Aurora, rounded UP to whole seconds.
 * From fal's model page for fal-ai/creatify/aurora, read 2026-10-05; the bill
 * comes from fal, so this is an estimate shown before spending.
 */
export const USD_PER_SECOND: Record<Resolution, number> = { "480p": 0.07, "720p": 0.14 };

export function costUsd(seconds: number, resolution: Resolution): number {
  return Math.round(Math.ceil(seconds) * USD_PER_SECOND[resolution] * 100) / 100;
}

/** Longest voice clip a presenter takes unless the request raises it, and the most it can. */
export const DEFAULT_MAX_SECONDS = 60;
export const HARD_MAX_SECONDS = 300;

/** fal's queue normally clears in minutes; past this, a job is reported failed instead of polled forever. */
export const STALL_MS = 2 * 60 * 60 * 1000;

export interface PresenterJob {
  id: string;
  name: string;
  status: "generating" | "completed" | "failed";
  image_asset_id: string;
  audio_asset_id: string;
  video_prompt: string | null;
  resolution: Resolution;
  audio_seconds: number;
  estimated_cost_usd: number;
  fal_request_id: string;
  fal_status_url: string;
  fal_response_url: string;
  /** The media-library video, once the job completed. */
  asset_id: string | null;
  error: string | null;
  /** Who confirmed the person shown agreed to be animated: an email when a person did, else null. */
  consent_by: string | null;
  /** How the request came in: user, agent, api, ... */
  consent_caller: string;
  consent_at: string;
  created_at: string;
  updated_at: string;
}

/** A job still generating, with where fal says it is. Never stored. */
export type PresenterView = PresenterJob & { phase?: "queued" | "running" };

export interface SettleIO {
  status(job: PresenterJob): Promise<"IN_QUEUE" | "IN_PROGRESS" | "COMPLETED">;
  result(job: PresenterJob): Promise<{ videoUrl: string } | { error: string }>;
  /** Copy the finished video into the app's uploads under `key`; returns its size in bytes. */
  keep(url: string, key: string): Promise<number>;
  /** The media-library asset for `key`, made if it is missing. Returns its id. */
  asset(key: string, size: number, job: PresenterJob): Promise<string>;
  update(id: string, patch: Partial<Pick<PresenterJob, "status" | "asset_id" | "error">>): Promise<void>;
}

/** Where a presenter's video lives in the app's uploads: one per fal job, so settling twice writes one file. */
export function presenterKey(falRequestId: string): string {
  return `presenters/${falRequestId}.mp4`;
}

/** The library name of a finished presenter. Says it is generated, wherever the file travels. */
export function presenterAssetName(name: string): string {
  return `${name} (AI presenter).mp4`;
}

export async function settle(job: PresenterJob, io: SettleIO, now = Date.now()): Promise<PresenterView> {
  if (job.status !== "generating") return job;

  const fail = async (error: string): Promise<PresenterView> => {
    const e = error.slice(0, 1000);
    await io.update(job.id, { status: "failed", error: e });
    return { ...job, status: "failed", error: e };
  };

  let status;
  try {
    status = await io.status(job);
  } catch {
    // fal could not be asked just now. The generation goes on; look again later.
    return job;
  }

  if (status !== "COMPLETED") {
    const age = now - Date.parse(job.created_at.replace(" ", "T") + "Z");
    if (age > STALL_MS) return fail("fal.ai did not finish within 2 hours. Generate it again.");
    return { ...job, phase: status === "IN_PROGRESS" ? "running" : "queued" };
  }

  const out = await io.result(job);
  if ("error" in out) return fail(out.error);
  const key = presenterKey(job.fal_request_id);
  const size = await io.keep(out.videoUrl, key);
  const assetId = await io.asset(key, size, job);
  await io.update(job.id, { status: "completed", asset_id: assetId });
  return { ...job, status: "completed", asset_id: assetId };
}

/** Why a voice clip can't be used, or null. `seconds` is null when the format could not be read. */
export function audioProblem(seconds: number | null, maxSeconds: number, resolution: Resolution): string | null {
  if (seconds === null) return "The voice clip must be MP3 or WAV.";
  if (seconds > maxSeconds) {
    return (
      `The voice clip runs ${Math.round(seconds)} s, over max_seconds (${maxSeconds}); ` +
      `it would cost about $${costUsd(seconds, resolution).toFixed(2)} at fal.ai. ` +
      `Raise max_seconds (up to ${HARD_MAX_SECONDS}) if that is intended.`
    );
  }
  return null;
}

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Bytes as a data: URI, in chunks (String.fromCharCode over a whole file overflows the stack). */
export function dataUri(bytes: Uint8Array, contentType: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${contentType};base64,${btoa(bin)}`;
}
