// How long an audio file plays, read from its header, without decoding it.
//
// A presenter is billed by the second at fal.ai, so a clip's length has to be
// known BEFORE anything is spent: a request capped at 60 seconds must not be
// able to hand over ten minutes. Only the two formats a voice clip arrives in
// are read (MP3, what ElevenLabs returns, and WAV, what a recorder writes);
// anything else is reported as unknown and the caller refuses it.

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Seconds of audio in `bytes`, or null when the format is not MP3 or WAV or the header is unreadable. */
export function audioDurationSeconds(bytes: Uint8Array): number | null {
  return wavDuration(bytes) ?? mp3Duration(bytes);
}

function ascii(b: Uint8Array, at: number, n: number): string {
  return String.fromCharCode(...b.subarray(at, at + n));
}

function wavDuration(b: Uint8Array): number | null {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 16 <= b.length) byteRate = view.getUint32(at + 16, true);
    if (id === "data") return byteRate > 0 ? Math.min(size, b.length - at - 8) / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

function mp3Duration(b: Uint8Array): number | null {
  let start = 0;
  // An ID3v2 tag sits before the first frame: 10-byte header, syncsafe size.
  if (b.length >= 10 && ascii(b, 0, 3) === "ID3") {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    start = 10 + size + (b[5] & 0x10 ? 10 : 0);
  }
  // First frame sync within a small window; a file that has none is not MP3.
  const limit = Math.min(b.length - 4, start + 64 * 1024);
  for (let at = start; at < limit; at++) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[at + 1] >> 3) & 0x03; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (b[at + 1] >> 1) & 0x03; // 1 = Layer III
    const bitrateIdx = (b[at + 2] >> 4) & 0x0f;
    const rateIdx = (b[at + 2] >> 2) & 0x03;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
    const sampleRate = MP3_RATES[version][rateIdx];
    const mono = ((b[at + 3] >> 6) & 0x03) === 3;
    const samplesPerFrame = version === 3 ? 1152 : 576;
    const kbps = (version === 3 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bitrateIdx];

    // Two bytes that merely look like a sync word turn up in any binary file (a
    // PNG read as 11.7 s of audio). A real stream has the next frame exactly one
    // frame length on, so require that.
    const frameLength = Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sampleRate) + ((b[at + 2] >> 1) & 0x01);
    const next = at + frameLength;
    if (next + 1 < b.length && (b[next] !== 0xff || (b[next + 1] & 0xe0) !== 0xe0)) continue;

    // A VBR file says how many frames it has in a Xing/Info header inside its
    // first frame, after the side info; trust that over the bitrate.
    const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const tag = at + 4 + sideInfo;
    if (tag + 12 <= b.length && (ascii(b, tag, 4) === "Xing" || ascii(b, tag, 4) === "Info")) {
      const flags = new DataView(b.buffer, b.byteOffset + tag + 4, 4).getUint32(0);
      if (flags & 0x1) {
        const frames = new DataView(b.buffer, b.byteOffset + tag + 8, 4).getUint32(0);
        if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
      }
    }

    // Constant bitrate: the bytes from the first frame on, at that bitrate.
    return ((b.length - at) * 8) / (kbps * 1000);
  }
  return null;
}
