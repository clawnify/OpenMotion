// Adding a file from the Media library to a composition: what a click on a
// tile in the editor's media rail does (as OpenVideo's library does).
//
// The clip goes in at the playhead, on a new track above the others, and
// before the composition's scripts so it is part of the root. An image is
// centred at up to 60% of the frame; a video fills the frame, muted, with its
// sound as a separate <audio> clip (HyperFrames' rule: video is always muted);
// an audio file is an <audio> clip. After that it is ordinary HTML to edit.

export interface MediaToInsert {
  /** The asset's path in the composition: assets/<key>. */
  src: string;
  kind: "image" | "video" | "audio";
  /** How long the clip lasts: the file's own length for video and audio. */
  seconds: number;
  /** Where it starts: the playhead. */
  at: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The kind of clip a file makes, from its MIME type, or null for one that can't be a clip. */
export function mediaKind(contentType: string): MediaToInsert["kind"] | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return null;
}

/** The composition with the file added, and the id of the clip that shows it. */
export function insertMedia(html: string, media: MediaToInsert): { html: string; id: string } | null {
  const root = /<[a-z][^>]*\sdata-composition-id\s*=[^>]*>/i.exec(html);
  if (!root) return null;

  let n = 1;
  while (html.includes(`id="media-${n}"`)) n++;
  const id = `media-${n}`;
  const tracks = [...html.matchAll(/data-track-index="(\d+)"/g)].map((m) => Number(m[1]));
  const track = tracks.length ? Math.max(...tracks) + 1 : 0;
  const when = `data-start="${round(Math.max(0, media.at))}" data-duration="${round(media.seconds)}"`;
  const src = esc(media.src);

  let clip: string;
  if (media.kind === "image") {
    clip = `  <img id="${id}" src="${src}" class="clip" ${when} data-track-index="${track}"\n       style="position:absolute;inset:0;margin:auto;max-width:60%;max-height:60%" />\n`;
  } else if (media.kind === "video") {
    clip =
      `  <video id="${id}" src="${src}" class="clip" ${when} data-track-index="${track}" muted playsinline\n` +
      `         style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>\n` +
      `  <audio id="${id}-audio" src="${src}" class="clip" ${when} data-track-index="${track + 1}" data-volume="1"></audio>\n`;
  } else {
    clip = `  <audio id="${id}" src="${src}" class="clip" ${when} data-track-index="${track}" data-volume="1"></audio>\n`;
  }

  // Before the root's first script, so the clip is inside the root and above
  // what came before it; else just before the root closes.
  const after = root.index + root[0].length;
  const script = html.slice(after).search(/\n[ \t]*<script\b/);
  let at: number;
  if (script >= 0) {
    at = after + script + 1;
  } else {
    const close = html.lastIndexOf("</div>");
    if (close < after) return null;
    at = html.lastIndexOf("\n", close) + 1;
  }
  let out = html.slice(0, at) + clip + html.slice(at);

  // The video grows to hold a clip that runs past its end.
  const end = Math.max(0, media.at) + media.seconds;
  const length = /(<[^>]*data-composition-id[^>]*\sdata-duration=")([\d.]+)(")/.exec(out);
  if (length && Number(length[2]) < end) out = out.replace(length[0], `${length[1]}${round(end)}${length[3]}`);
  return { html: out, id };
}
