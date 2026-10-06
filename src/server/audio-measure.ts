// How loud a sound is, and where it hits hardest, measured from its samples.
//
// An agent mixing a video cannot hear it. It sets a music bed under a voice
// and lines a click up with a cursor from numbers, so every sound in the media
// library carries two:
//
//   loudness  integrated loudness in LUFS (ITU-R BS.1770-4, the measure EBU
//             R128 and ffmpeg's ebur128 report). Two sounds' difference is how
//             far apart they sit; a gain of 10^(dB/20) moves one by dB.
//   peak_at   seconds from the start of the sound as it plays (the renderer's
//             timing) to its loudest sample. A click's hit, not its file start.
//
// A Worker cannot compile WebAssembly at runtime, and the draft tier ships one
// JavaScript file, so MP3 is decoded in plain JavaScript (js-mp3, a port of
// go-mp3: MPEG-1 Layer III, what generated speech, music and effects are). WAV
// is read directly. Anything else is not measured. At most the first
// MAX_SECONDS are read, which bounds the work for a long upload.

import { findMp3Frame } from "./audio-duration.ts";

export const MAX_SECONDS = 120;

export interface AudioMeasure {
  /** Integrated loudness, LUFS; null for silence. */
  loudness: number | null;
  /** Seconds to the loudest sample; null for silence. */
  peak_at: number | null;
}

// ── Loudness (ITU-R BS.1770-4) ───────────────────────────────────────────────

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number];

/**
 * The K-weighting filter at any sample rate: a high shelf (+4 dB above ~1.7
 * kHz, the head's effect) then a high-pass (~38 Hz). The standard tabulates
 * coefficients for 48 kHz only; this is the bilinear design libebur128 (and
 * so ffmpeg's ebur128) derives them from, which reproduces that table.
 */
export function kWeighting(fs: number): [Biquad, Biquad] {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highPass: Biquad = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, highPass];
}

/**
 * Feed it sample frames, in order; read loudness and the peak at the end.
 * Keeps only one number per 100 ms, so a long sound costs no memory.
 */
export class LoudnessMeter {
  private readonly filters: [Biquad, Biquad];
  /** Per channel: the two filters' state (x1, x2, y1, y2 each). */
  private readonly state: Float64Array[];
  private readonly hop: number;
  private hopEnergy = 0;
  private inHop = 0;
  private readonly hops: number[] = [];
  private frames = 0;
  private peak = 0;
  private peakFrame = -1;

  readonly sampleRate: number;
  readonly channels: number;

  constructor(sampleRate: number, channels: number) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.filters = kWeighting(sampleRate);
    this.state = Array.from({ length: channels }, () => new Float64Array(8));
    this.hop = Math.round(sampleRate / 10);
  }

  /** One sample frame: a value per channel, -1..1. */
  push(frame: ArrayLike<number>): void {
    let energy = 0;
    for (let ch = 0; ch < this.channels; ch++) {
      const x = frame[ch];
      const a = Math.abs(x);
      if (a > this.peak) {
        this.peak = a;
        this.peakFrame = this.frames;
      }
      const s = this.state[ch];
      let y = x;
      for (let f = 0; f < 2; f++) {
        const [b0, b1, b2, a1, a2] = this.filters[f];
        const o = f * 4;
        const out = b0 * y + b1 * s[o] + b2 * s[o + 1] - a1 * s[o + 2] - a2 * s[o + 3];
        s[o + 1] = s[o];
        s[o] = y;
        s[o + 3] = s[o + 2];
        s[o + 2] = out;
        y = out;
      }
      energy += y * y;
    }
    this.hopEnergy += energy;
    this.frames++;
    if (++this.inHop === this.hop) {
      this.hops.push(this.hopEnergy);
      this.hopEnergy = 0;
      this.inHop = 0;
    }
  }

  get seconds(): number {
    return this.frames / this.sampleRate;
  }

  result(): AudioMeasure {
    // 400 ms blocks, a new one every 100 ms. A sound shorter than one block
    // (a click) is measured as a single block of its own length.
    const blocks: number[] = [];
    for (let j = 0; j + 4 <= this.hops.length; j++) {
      blocks.push((this.hops[j] + this.hops[j + 1] + this.hops[j + 2] + this.hops[j + 3]) / (4 * this.hop));
    }
    if (blocks.length === 0 && this.frames > 0) {
      blocks.push((this.hops.reduce((a, b) => a + b, 0) + this.hopEnergy) / this.frames);
    }
    const lufs = (z: number) => -0.691 + 10 * Math.log10(z);
    const mean = (zs: number[]) => zs.reduce((a, b) => a + b, 0) / zs.length;
    const audible = blocks.filter((z) => z > 0 && lufs(z) > -70);
    if (audible.length === 0 || this.peakFrame < 0) return { loudness: null, peak_at: null };
    const relative = lufs(mean(audible)) - 10;
    const gated = audible.filter((z) => lufs(z) > relative);
    return {
      loudness: Math.round(lufs(mean(gated)) * 10) / 10,
      peak_at: Math.round((this.peakFrame / this.sampleRate) * 1000) / 1000,
    };
  }
}

// ── Decoding ─────────────────────────────────────────────────────────────────

/** Loudness and peak of an MP3 or WAV file; null when it is neither, or unreadable. */
export async function measureAudio(bytes: Uint8Array): Promise<AudioMeasure | null> {
  try {
    return measureWav(bytes) ?? (await measureMp3(bytes));
  } catch {
    // A file that breaks the decoder is simply not measured.
    return null;
  }
}

function ascii(b: Uint8Array, at: number, n: number): string {
  return String.fromCharCode(...b.subarray(at, at + n));
}

function measureWav(b: Uint8Array): AudioMeasure | null {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 24 <= b.length) {
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes.
      if (format === 0xfffe && at + 34 <= b.length) format = view.getUint16(at + 32, true);
    }
    if (id === "data") {
      const pcm = format === 1 && (bits === 16 || bits === 24 || bits === 32);
      const float = format === 3 && bits === 32;
      if ((!pcm && !float) || channels < 1 || rate < 1) return null;
      const width = bits / 8;
      const end = Math.min(b.length, at + 8 + size);
      const meter = new LoudnessMeter(rate, channels);
      const frame = new Float64Array(channels);
      const limit = MAX_SECONDS * rate;
      for (let p = at + 8, n = 0; p + width * channels <= end && n < limit; n++) {
        for (let ch = 0; ch < channels; ch++, p += width) {
          frame[ch] = float
            ? view.getFloat32(p, true)
            : bits === 16
              ? view.getInt16(p, true) / 32768
              : bits === 24
                ? ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608)
                : view.getInt32(p, true) / 2147483648;
        }
        meter.push(frame);
      }
      return meter.result();
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Sample frames the renderer leaves out at the start, so peak_at matches what
 * plays. A gapless (Xing/Info) header is a frame of its own, not audio; and
 * the encoder delay it records, plus the decoder's own 529 samples, are
 * skipped too. That is ffmpeg's rule (it renders the video), so a file with
 * no such header skips nothing.
 */
export function mp3StartSkip(b: Uint8Array, infoTag: number | null, samplesPerFrame: number): number {
  if (infoTag === null) return 0;
  const flags = new DataView(b.buffer, b.byteOffset + infoTag + 4, 4).getUint32(0);
  // Frames (4 bytes), bytes (4), table of contents (100), quality (4), each when flagged.
  let p = infoTag + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x2 ? 4 : 0) + (flags & 0x4 ? 100 : 0) + (flags & 0x8 ? 4 : 0);
  // The LAME-style extension: a 9-byte encoder name ("LAME3.100", "Lavf"),
  // then 12 bytes of levels and flags, then the delay in the top 12 bits.
  const encoder = ascii(b, p, 4);
  if (p + 24 > b.length || !/^(LAME|Lavf|Lavc|L3\.9)/.test(encoder)) return samplesPerFrame;
  p += 21;
  const delay = (b[p] << 4) | (b[p + 1] >> 4);
  return samplesPerFrame + delay + 529;
}

interface Mp3Source {
  pos: number;
  skipTags(): { err?: unknown };
}
interface Mp3Frame {
  decode(): Uint8Array;
}

async function measureMp3(b: Uint8Array): Promise<AudioMeasure | null> {
  const first = findMp3Frame(b);
  // js-mp3 decodes MPEG-1 Layer III only (44.1, 48 and 32 kHz).
  if (!first || first.version !== 3) return null;
  // Loaded on first use, like the linter: most requests never measure a sound.
  const [{ default: Mp3 }, { default: Frame }] = await Promise.all([
    import("js-mp3") as Promise<{ default: { newSource(buf: ArrayBuffer): Mp3Source } }>,
    import("js-mp3/src/frame.js") as Promise<{
      default: { read(source: Mp3Source, position: number, prev: Mp3Frame | null): { f: Mp3Frame; err?: unknown } };
    }>,
  ]);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const source = Mp3.newSource(buf);
  if (source.skipTags().err) return null;

  const channels = first.mono ? 1 : 2;
  const meter = new LoudnessMeter(first.sampleRate, channels);
  let skip = mp3StartSkip(b, first.infoTag, first.samplesPerFrame);
  const frame = new Float64Array(channels);
  let prev: Mp3Frame | null = null;
  while (meter.seconds < MAX_SECONDS) {
    const r = Frame.read(source, source.pos, prev);
    if (r.err) break;
    prev = r.f;
    // 16-bit little-endian samples, channels interleaved.
    const pcm = r.f.decode();
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    for (let i = 0; i + channels <= samples.length; i += channels) {
      if (skip > 0) {
        skip--;
        continue;
      }
      for (let ch = 0; ch < channels; ch++) frame[ch] = samples[i + ch] / 32768;
      meter.push(frame);
    }
  }
  return meter.result();
}
