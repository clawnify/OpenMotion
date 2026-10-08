import { ClawnifyServicesError, type StagedFile, type VideoAsset } from "@clawnify/services";

export interface RenderAsset {
  id: string;
  key: string;
  content_type: string;
  size: number;
  /** The staged copy on the render service (stage/<token>/<uuid>.<ext>), if any. */
  service_key: string | null;
  service_key_expires_at: string | null;
}

interface RenderArgs {
  html: string;
  fps: number;
  assets: RenderAsset[];
  filename: string;
}

/** What a render needs from the outside world. Real I/O in index.ts; fakes in tests. */
export interface RenderIO {
  /** Upload one asset from R2 to the render service; null when it is gone from R2. */
  stage(asset: RenderAsset): Promise<StagedFile | null>;
  /** Keep the staged copy's pointer, so the next export reuses it. */
  remember(id: string, staged: StagedFile | null): Promise<void>;
  /** The bytes of an asset the service cannot stage, or null when gone. */
  bytes(key: string): Promise<ArrayBuffer | null>;
  start(opts: { html: string; fps: 24 | 30 | 60; format: "mp4"; filename: string; assets: VideoAsset[] }): Promise<string>;
}

// The types the render service stages (its POST /files). Everything else (an
// SVG, a font) is small and goes inline.
const STAGEABLE = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac",
]);
// A staged copy lives ~30 days. Re-stage one with less than a day left, so it
// cannot expire between this export and the render fetching it.
const FRESH_MS = 24 * 60 * 60 * 1000;
// A request out of the app is capped at 32 MiB, and base64 adds a third.
export const MAX_INLINE_BYTES = 20 * 1024 * 1024;

export function stageable(contentType: string): boolean {
  return STAGEABLE.has(contentType.split(";")[0].trim().toLowerCase());
}

/** A staged copy that will still be there when the render fetches it. */
export function stagedSrc(a: RenderAsset, now: number): string | null {
  if (!a.service_key || !a.service_key_expires_at) return null;
  const expires = Date.parse(a.service_key_expires_at);
  return Number.isFinite(expires) && expires - now > FRESH_MS ? `file:${a.service_key}` : null;
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
 * with getVideoRender (see exports.ts).
 *
 * Only the assets the HTML references are sent. Media goes staged: streamed
 * from the app's R2 to the service once, then fetched by the render container,
 * so a big clip is never held in memory or base64'd into the request (which a
 * Worker cannot send past 32 MiB). The staged copy's pointer is kept on the
 * asset and reused until it is about to expire. Anything the service cannot
 * stage goes inline.
 *
 * Throws with the service's error detail when it refuses the job.
 */
export async function startRender(io: RenderIO, args: RenderArgs, now = Date.now()): Promise<string> {
  const referenced = args.assets.filter((a) => args.html.includes(`assets/${a.key}`));

  const small = referenced.filter((a) => !stageable(a.content_type));
  if (small.reduce((sum, a) => sum + a.size, 0) > MAX_INLINE_BYTES) {
    const types = [...new Set(small.map((a) => a.content_type))].join(", ");
    throw new Error(
      `The files this video uses that cannot be staged (${types}) are over ${MAX_INLINE_BYTES / 1024 / 1024} MB together. Use smaller ones.`,
    );
  }
  const inline: VideoAsset[] = [];
  for (const a of small) {
    const bytes = await io.bytes(a.key);
    if (bytes) inline.push({ path: a.key, dataBase64: bytesToBase64(bytes) });
  }

  const media = referenced.filter((a) => stageable(a.content_type));
  const staged = async (fresh: boolean): Promise<VideoAsset[]> => {
    const out = await Promise.all(
      media.map(async (a): Promise<VideoAsset | null> => {
        const src = fresh ? null : stagedSrc(a, now);
        if (src) return { path: a.key, src };
        const file = await io.stage(a);
        await io.remember(a.id, file);
        return file ? { path: a.key, src: file.src } : null;
      }),
    );
    return out.filter((a): a is VideoAsset => a !== null);
  };

  const opts = { html: args.html, fps: args.fps as 24 | 30 | 60, format: "mp4" as const, filename: args.filename };
  try {
    return await io.start({ ...opts, assets: [...(await staged(false)), ...inline] });
  } catch (err) {
    // A kept pointer the service no longer honours: the copy expired early, or
    // the org's token changed (copies belong to the token). Stage again, once.
    const stale = err instanceof ClawnifyServicesError && (err.code === "staged_file_missing" || err.code === "forbidden_source");
    if (!stale) throw err;
    return io.start({ ...opts, assets: [...(await staged(true)), ...inline] });
  }
}
