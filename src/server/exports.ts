import type { VideoRenderJob } from "@clawnify/services";

/** One export, as the render_jobs table keeps it. */
export interface RenderJob {
  id: number;
  composition_id: string;
  status: "rendering" | "completed" | "failed";
  output_url: string | null;
  error: string | null;
  asset_id: string | null;
  /** The render service's job, polled until it lands. */
  service_job_id: string | null;
  /** The video's length when it was exported. */
  seconds: number | null;
  created_at: string;
  updated_at: string;
}

/** A job still rendering, with where the service says it is. Never stored. */
export type ExportView = RenderJob & { phase?: "queued" | "running" };

export interface SettleIO {
  status(serviceJobId: string): Promise<VideoRenderJob>;
  /** Copy the finished file into the app's uploads under `key`; returns its size in bytes. */
  keep(url: string, key: string): Promise<number>;
  /** The media-library asset for `key`, made if it is missing. Returns its id. */
  asset(key: string, size: number, job: RenderJob): Promise<string>;
  update(id: number, patch: Partial<Pick<RenderJob, "status" | "output_url" | "asset_id" | "error">>): Promise<void>;
}

/** An export made before renders ran in the background has no service job. If
 *  it still says rendering after this long, the request that ran it is gone. */
export const ORPHAN_MS = 10 * 60 * 1000;

/** Where an export's file lives in the app's uploads: one per service job, so
 *  settling the same export twice writes the same file, never a second one. */
export function exportKey(serviceJobId: string): string {
  return `renders/${serviceJobId}.mp4`;
}

/**
 * Bring an export up to date with the render service. A rendering job whose
 * render has finished is kept: the MP4 is copied into the app's uploads,
 * registered in the media library, and the job completed. Nothing runs in the
 * background, so whoever looks at an export (the editor polling, an agent,
 * the export list) finishes it. Every step can run twice without harm, so two
 * looks at once are fine.
 */
export async function settle(job: RenderJob, io: SettleIO, now = Date.now()): Promise<ExportView> {
  if (job.status !== "rendering") return job;

  if (!job.service_job_id) {
    const age = now - Date.parse(job.created_at.replace(" ", "T") + "Z");
    if (!(age > ORPHAN_MS)) return job;
    const error = "This export stopped before it finished. Export again.";
    await io.update(job.id, { status: "failed", error });
    return { ...job, status: "failed", error };
  }

  let s: VideoRenderJob;
  try {
    s = await io.status(job.service_job_id);
  } catch {
    // The service could not be asked. The render goes on; look again later.
    return job;
  }

  if (s.status === "done" && s.url) {
    const key = exportKey(job.service_job_id);
    const size = await io.keep(s.url, key);
    const assetId = await io.asset(key, size, job);
    const output_url = `/api/uploads/${encodeURIComponent(key)}`;
    await io.update(job.id, { status: "completed", output_url, asset_id: assetId });
    return { ...job, status: "completed", output_url, asset_id: assetId };
  }
  if (s.status === "failed") {
    const error = s.detail || s.error || "The render failed.";
    await io.update(job.id, { status: "failed", error: error.slice(0, 1000) });
    return { ...job, status: "failed", error: error.slice(0, 1000) };
  }
  return { ...job, phase: s.status === "queued" ? "queued" : "running" };
}
