// The two providers behind voices and presenters: ElevenLabs (speech, music,
// sound effects) and
// fal.ai (a photo animated to speak). Each is called with the user's own key,
// so each bills the user directly. index.ts finds the key (a Clawnify
// connection, or an env var when self-hosted) and hands it in.

/** Photo + voice -> talking head, on fal.ai. */
export const AURORA_ENDPOINT = "fal-ai/creatify/aurora";
import { type CharacterAlignment, type Word, wordsFromAlignment, wordsFromTranscript } from "../shared/words.ts";

const FAL_QUEUE = "https://queue.fal.run";
const ELEVENLABS = "https://api.elevenlabs.io";

/**
 * Keep as little as possible at fal.ai: no stored request payloads
 * (X-Fal-Store-IO; fal's default keeps them 30 days), and the output off fal's
 * CDN after a week (its default is forever, readable by anyone with the
 * unguessable link). The app copies the video into its own storage the first
 * time anyone looks at a finished job, then asks fal to delete it (see
 * deleteFalOutput), so the week only matters for a job nobody looks at. It must
 * outlast that look: a shorter expiry loses a video already paid for.
 */
const FAL_OUTPUT_SECONDS = 7 * 24 * 60 * 60;
const FAL_NO_RETENTION = {
  "X-Fal-Store-IO": "0",
  "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: FAL_OUTPUT_SECONDS }),
};

export class ProviderError extends Error {
  provider: "elevenlabs" | "fal";
  status: number;
  detail: string;
  constructor(provider: "elevenlabs" | "fal", status: number, detail: string) {
    super(`${provider === "fal" ? "fal.ai" : "ElevenLabs"} answered ${status}: ${detail}`);
    this.provider = provider;
    this.status = status;
    this.detail = detail;
  }
}

async function failure(provider: "elevenlabs" | "fal", res: Response): Promise<ProviderError> {
  return new ProviderError(provider, res.status, (await res.text().catch(() => "")).slice(0, 1000));
}

// ── ElevenLabs ───────────────────────────────────────────────────────────────

export interface Voice {
  voice_id: string;
  name: string;
  category: string | null;
  description: string | null;
  labels: Record<string, string>;
  preview_url: string | null;
}

export interface VoiceQuery {
  search?: string;
  /** premade | cloned | generated | professional */
  category?: string;
  pageToken?: string;
  pageSize?: number;
}

/** The voices in the user's ElevenLabs account (their own, cloned and saved), one page at a time. */
export async function listVoices(apiKey: string, q: VoiceQuery): Promise<{ voices: Voice[]; next_page_token: string | null }> {
  const params = new URLSearchParams({ page_size: String(q.pageSize ?? 30) });
  if (q.search) params.set("search", q.search);
  if (q.category) params.set("category", q.category);
  if (q.pageToken) params.set("next_page_token", q.pageToken);
  const res = await fetch(`${ELEVENLABS}/v2/voices?${params}`, { headers: { "xi-api-key": apiKey } });
  if (!res.ok) throw await failure("elevenlabs", res);
  const body = (await res.json()) as { voices?: Array<Record<string, unknown>>; has_more?: boolean; next_page_token?: string | null };
  return {
    voices: (body.voices ?? []).map((v) => ({
      voice_id: String(v.voice_id),
      name: String(v.name ?? ""),
      category: typeof v.category === "string" ? v.category : null,
      description: typeof v.description === "string" ? v.description : null,
      labels: (v.labels && typeof v.labels === "object" ? v.labels : {}) as Record<string, string>,
      preview_url: typeof v.preview_url === "string" ? v.preview_url : null,
    })),
    next_page_token: body.has_more ? (body.next_page_token ?? null) : null,
  };
}

export interface SpeechRequest {
  voiceId: string;
  text: string;
  /** ElevenLabs model; theirs is eleven_multilingual_v2 when omitted. */
  modelId?: string;
  /** Passed through as given: stability, similarity_boost, style, speed, ... */
  voiceSettings?: Record<string, unknown>;
}

/**
 * Text to speech in one of the user's ElevenLabs voices. MP3, 44.1 kHz,
 * 128 kbps, with when each word is spoken (the `/with-timestamps` variant:
 * same voice, same price, the audio comes back as base64 beside character
 * times). The times follow the script as written, not as normalised for
 * reading, so a caption says "$5" where the voice says "five dollars".
 */
export async function speak(apiKey: string, req: SpeechRequest): Promise<{ audio: Uint8Array; words: Word[] }> {
  const url = `${ELEVENLABS}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: req.text,
      ...(req.modelId ? { model_id: req.modelId } : {}),
      ...(req.voiceSettings ? { voice_settings: req.voiceSettings } : {}),
    }),
  });
  if (!res.ok) throw await failure("elevenlabs", res);
  const body = (await res.json()) as { audio_base64?: string; alignment?: CharacterAlignment | null };
  if (!body.audio_base64) throw new ProviderError("elevenlabs", res.status, "no audio in the answer");
  return { audio: fromBase64(body.audio_base64), words: wordsFromAlignment(body.alignment) };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The words spoken in a recording or video, with their times: ElevenLabs
 * speech to text (Scribe). The language is detected unless one is given
 * (ISO 639-1 or 639-3). Sound events such as laughter are left out.
 */
export async function transcribe(apiKey: string, file: Blob, language?: string): Promise<{ words: Word[]; language: string | null }> {
  const form = new FormData();
  form.set("model_id", "scribe_v2");
  form.set("file", file, "media");
  form.set("timestamps_granularity", "word");
  form.set("tag_audio_events", "false");
  if (language) form.set("language_code", language);
  const res = await fetch(`${ELEVENLABS}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": apiKey }, body: form });
  if (!res.ok) throw await failure("elevenlabs", res);
  const body = (await res.json()) as { words?: Parameters<typeof wordsFromTranscript>[0]; language_code?: string };
  return { words: wordsFromTranscript(body.words), language: body.language_code ?? null };
}

export interface MusicRequest {
  prompt: string;
  /** 3 to 600 seconds (ElevenLabs' range). */
  seconds: number;
  /** No vocals, whatever the prompt says. */
  instrumental: boolean;
  /** ElevenLabs model; theirs is music_v1 when omitted. */
  modelId?: string;
}

/**
 * A piece of music from a prompt, at a set length. MP3, 44.1 kHz, 128 kbps,
 * named explicitly: their "auto" picks 192 kbps for newer models, which not
 * every plan may download.
 */
export async function composeMusic(apiKey: string, req: MusicRequest): Promise<Uint8Array> {
  const res = await fetch(`${ELEVENLABS}/v1/music?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      prompt: req.prompt,
      music_length_ms: Math.round(req.seconds * 1000),
      force_instrumental: req.instrumental,
      ...(req.modelId ? { model_id: req.modelId } : {}),
    }),
  });
  if (!res.ok) throw await failure("elevenlabs", res);
  return new Uint8Array(await res.arrayBuffer());
}

export interface SoundEffectRequest {
  prompt: string;
  /** 0.5 to 30 seconds; ElevenLabs guesses from the prompt when omitted. */
  seconds?: number;
  /** Ends where it starts, to repeat seamlessly (an ambience under a scene). */
  loop?: boolean;
  /** 0 to 1: higher follows the prompt more literally. Theirs is 0.3. */
  promptInfluence?: number;
}

/** A sound effect from a prompt: a whoosh, a click, a riser. MP3, 44.1 kHz, 128 kbps. */
export async function soundEffect(apiKey: string, req: SoundEffectRequest): Promise<Uint8Array> {
  const res = await fetch(`${ELEVENLABS}/v1/sound-generation?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: req.prompt,
      ...(req.seconds !== undefined ? { duration_seconds: req.seconds } : {}),
      ...(req.loop ? { loop: true } : {}),
      ...(req.promptInfluence !== undefined ? { prompt_influence: req.promptInfluence } : {}),
    }),
  });
  if (!res.ok) throw await failure("elevenlabs", res);
  return new Uint8Array(await res.arrayBuffer());
}

// ── fal.ai ───────────────────────────────────────────────────────────────────

export interface FalJob {
  request_id: string;
  status_url: string;
  response_url: string;
}

export interface AuroraInput {
  /** The photo, as a data: URI (the app's own files sit behind its login, so fal could not fetch a link). */
  image: string;
  /** The voice, as a data: URI. */
  audio: string;
  prompt?: string;
  resolution: "480p" | "720p";
}

/** Queue one generation. Returns at once; the work runs at fal.ai. */
export async function submitAurora(apiKey: string, input: AuroraInput): Promise<FalJob> {
  const res = await fetch(`${FAL_QUEUE}/${AURORA_ENDPOINT}`, {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json", ...FAL_NO_RETENTION },
    body: JSON.stringify({
      image_url: input.image,
      audio_url: input.audio,
      resolution: input.resolution,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    }),
  });
  if (!res.ok) throw await failure("fal", res);
  const job = (await res.json()) as Partial<FalJob>;
  if (!job.request_id || !isFalQueueUrl(job.status_url) || !isFalQueueUrl(job.response_url)) {
    throw new ProviderError("fal", res.status, `unexpected queue answer: ${JSON.stringify(job).slice(0, 300)}`);
  }
  return job as FalJob;
}

/** The user's fal.ai key only ever goes back to fal's own queue host. */
export function isFalQueueUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(`${FAL_QUEUE}/`);
}

export type FalStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

export async function falStatus(apiKey: string, statusUrl: string): Promise<FalStatus> {
  if (!isFalQueueUrl(statusUrl)) throw new ProviderError("fal", 0, "not a fal.ai queue link");
  const res = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` } });
  if (!res.ok) throw await failure("fal", res);
  return ((await res.json()) as { status: FalStatus }).status;
}

/** fal could not answer right now (5xx, 429): ask again later, nothing is decided. */
export function isTransient(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * A completed job's video link, or why it failed. A request that failed at fal
 * still reports COMPLETED; its result answers with an error instead. A
 * transient answer (5xx, 429) throws, so the job is not failed over a blip.
 */
export async function falResult(apiKey: string, responseUrl: string): Promise<{ videoUrl: string } | { error: string }> {
  if (!isFalQueueUrl(responseUrl)) return { error: "not a fal.ai queue link" };
  const res = await fetch(responseUrl, { headers: { Authorization: `Key ${apiKey}` } });
  if (!res.ok && isTransient(res.status)) throw await failure("fal", res);
  if (!res.ok) return { error: `fal.ai answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 1000)}` };
  const body = (await res.json().catch(() => null)) as { video?: { url?: unknown } } | null;
  const url = body?.video?.url;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return { error: `fal.ai returned no video: ${JSON.stringify(body).slice(0, 500)}` };
  }
  return { videoUrl: url };
}

/**
 * Ask fal to delete a request's output from its CDN, once the app holds its
 * own copy. fal's docs say this needs an admin key, which the user's key may
 * not be, so it is best effort: on refusal the output still expires (see
 * FAL_OUTPUT_SECONDS).
 */
export async function deleteFalOutput(apiKey: string, requestId: string): Promise<void> {
  await fetch(`https://api.fal.ai/v1/models/requests/${encodeURIComponent(requestId)}/payloads`, {
    method: "DELETE",
    headers: { Authorization: `Key ${apiKey}` },
  }).catch(() => undefined);
}
