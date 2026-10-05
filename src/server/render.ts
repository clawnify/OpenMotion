import { startVideoRender, type ServicesEnv } from "@clawnify/services";
import { getUploadBytes } from "./uploads";

interface Asset {
  key: string;
}

interface RenderArgs {
  html: string;
  fps: number;
  assets: Asset[];
  filename: string;
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Start rendering a composition to MP4 on the managed Clawnify render service
 * (services.clawnify.com/video/render, HyperFrames in a container) and return
 * the service's job id at once. The render runs to the end on its own; poll it
 * with getVideoRender (see exports.ts). Only the assets the HTML references are
 * shipped, inline as base64: the app's R2 uploads sit behind perimeter auth,
 * so the service cannot be handed a fetchable URL.
 *
 * Throws with the service's error detail when it refuses the job.
 */
export async function startRender(env: ServicesEnv, args: RenderArgs): Promise<string> {
  const referenced = args.assets.filter((a) => args.html.includes(`assets/${a.key}`));

  const assets = [];
  for (const a of referenced) {
    const bytes = await getUploadBytes(a.key);
    if (!bytes) continue;
    assets.push({ path: a.key, dataBase64: bytesToBase64(bytes) });
  }

  const job = await startVideoRender(env, {
    html: args.html,
    fps: args.fps as 24 | 30 | 60,
    format: "mp4",
    filename: args.filename,
    assets,
  });
  return job.job_id;
}
