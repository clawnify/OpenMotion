// Run: pnpm test (Node 22+).
// The fixtures are synthetic sounds made with ffmpeg; the expected numbers are
// ffmpeg's own (ebur128 for loudness, its decoder for the peak sample).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LoudnessMeter, kWeighting, measureAudio } from "../src/server/audio-measure.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function tone(meter: LoudnessMeter, dbfs: number, seconds: number, hz = 1000) {
  const amp = Math.pow(10, dbfs / 20);
  const frame = new Float64Array(meter.channels);
  const n = Math.round(seconds * meter.sampleRate);
  for (let i = 0; i < n; i++) {
    frame.fill(amp * Math.sin((2 * Math.PI * hz * i) / meter.sampleRate));
    meter.push(frame);
  }
}

test("K-weighting at 48 kHz is the standard's own table", () => {
  const [shelf, highPass] = kWeighting(48000);
  const table = [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1, -2, 1, -1.99004745483398, 0.99007225036621],
  ];
  [shelf, highPass].forEach((got, s) => got.forEach((v, i) => assert.ok(Math.abs(v - table[s][i]) < 1e-12, `stage ${s} [${i}]: ${v}`)));
});

test("a 1 kHz stereo tone at -23 dBFS reads -23 LUFS (EBU Tech 3341, case 1), at any rate", () => {
  for (const rate of [48000, 44100]) {
    const m = new LoudnessMeter(rate, 2);
    tone(m, -23, 20);
    assert.equal(m.result().loudness, -23, `${rate} Hz`);
  }
  const quieter = new LoudnessMeter(48000, 2);
  tone(quieter, -33, 20);
  assert.equal(quieter.result().loudness, -33);
});

test("silence does not pull the loudness down, and pure silence has none", () => {
  const m = new LoudnessMeter(48000, 2);
  tone(m, -23, 10);
  tone(m, -200, 10);
  // Only the blocks that straddle the tone's end still count, partly loud.
  // ffmpeg's ebur128 reads this signal as -23.1 too.
  assert.equal(m.result().loudness, -23.1);

  const quiet = new LoudnessMeter(48000, 1);
  tone(quiet, -200, 2);
  assert.deepEqual(quiet.result(), { loudness: null, peak_at: null });
});

test("a WAV is read directly: its loudness, and where it hits hardest", async () => {
  const rate = 8000;
  const samples = new Int16Array(rate); // 1 s of near-silence with one hit at 0.75 s
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(300 * Math.sin((2 * Math.PI * 1000 * i) / rate));
  samples[6000] = 30000;
  const wav = new Uint8Array(44 + samples.byteLength);
  const v = new DataView(wav.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF"); v.setUint32(4, 36 + samples.byteLength, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, samples.byteLength, true);
  wav.set(new Uint8Array(samples.buffer), 44);

  const m = await measureAudio(wav);
  assert.equal(m?.peak_at, 0.75);
  assert.ok(m?.loudness !== null && m!.loudness! < -30 && m!.loudness! > -50, JSON.stringify(m));
});

test("MP3: the loudness ffmpeg reports, and the peak where the render plays it", async () => {
  // A click: sharp attack at 0.15 s. ffmpeg: -20.5 LUFS, peak at 0.1502 s.
  assert.deepEqual(await measureAudio(fixture("click.mp3")), { loudness: -20.5, peak_at: 0.15 });
  // A hit at 1.25-1.27 s in pink noise, written with a gapless (Info) header:
  // the header frame and the encoder delay are not played. ffmpeg: -24.7, 1.2704 s.
  assert.deepEqual(await measureAudio(fixture("spike.mp3")), { loudness: -24.7, peak_at: 1.27 });
  // The same sound without that header: nothing is skipped, so every sample
  // comes 1105 samples (25 ms) later. ffmpeg: -24.8, 1.2954 s.
  assert.deepEqual(await measureAudio(fixture("spike-no-info.mp3")), { loudness: -24.8, peak_at: 1.295 });
});

test("what cannot be decoded is not measured", async () => {
  assert.equal(await measureAudio(fixture("mpeg2.mp3")), null); // MPEG-2 (22 kHz): js-mp3 reads MPEG-1 only
  assert.equal(await measureAudio(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), null);
  assert.equal(await measureAudio(new Uint8Array(0)), null);
});
