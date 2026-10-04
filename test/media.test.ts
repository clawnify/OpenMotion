// Adding a Media library item to a video: where it lands and its markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaHtml, mediaId, mediaKind, placeMedia } from "../src/shared/media.ts";

const base = { fps: 30, tracks: 3, length: 5 as number | null };

test("an image lands at the playhead for 3 s, on a new lane above the others", () => {
  assert.deepEqual(placeMedia({ ...base, kind: "image", seconds: null, playhead: 1 }), { start: 1, duration: 3, track: 3 });
});

test("the start lands on a frame", () => {
  // 1.011 s at 30 fps is frame 30.33: frame 30 = 1 s.
  assert.equal(placeMedia({ ...base, kind: "image", seconds: null, playhead: 1.011 }).start, 1);
});

test("a video runs its own length, and a stated length grows to fit it", () => {
  const p = placeMedia({ ...base, kind: "video", seconds: 7.25, playhead: 2 });
  assert.equal(p.duration, 7.25);
  assert.equal(p.length, 9.25);
});

test("a video of unknown length gets 5 s", () => {
  assert.equal(placeMedia({ ...base, kind: "video", seconds: null, playhead: 0 }).duration, 5);
  assert.equal(placeMedia({ ...base, kind: "audio", seconds: 0, playhead: 0 }).duration, 5);
});

test("no stated length stays unstated, and one that already fits is left alone", () => {
  assert.equal(placeMedia({ ...base, length: null, kind: "video", seconds: 30, playhead: 0 }).length, undefined);
  assert.equal(placeMedia({ ...base, kind: "image", seconds: null, playhead: 2 }).length, undefined);
});

test("a negative playhead starts at 0", () => {
  assert.equal(placeMedia({ ...base, kind: "image", seconds: null, playhead: -1 }).start, 0);
});

test("kinds come from the content type; anything else cannot be added", () => {
  assert.equal(mediaKind("image/png"), "image");
  assert.equal(mediaKind("video/mp4"), "video");
  assert.equal(mediaKind("audio/mpeg"), "audio");
  assert.equal(mediaKind("application/pdf"), null);
});

test("a video brings its sound one lane up, muted picture plus an <audio>", () => {
  const html = mediaHtml("video", "assets/demo.mp4", "media-demo", { start: 1, duration: 4, track: 3 });
  assert.match(html, /<video id="media-demo" src="assets\/demo.mp4" class="clip" data-start="1" data-duration="4" data-track-index="3" muted playsinline/);
  assert.match(html, /<audio id="media-demo-audio" src="assets\/demo.mp4" class="clip" data-start="1" data-duration="4" data-track-index="4"/);
});

test("an image fills the frame without cropping", () => {
  const html = mediaHtml("image", "assets/face.jpg", "media-face", { start: 0, duration: 3, track: 0 });
  assert.match(html, /^<img id="media-face" [^>]*object-fit:contain">$/);
});

test("quotes in a source cannot break out of the attribute", () => {
  assert.match(mediaHtml("audio", 'assets/a".mp3', "m", { start: 0, duration: 1, track: 0 }), /src="assets\/a&quot;.mp3"/);
});

test("ids come from the key and never repeat", () => {
  assert.equal(mediaId("My Face.JPG", new Set()), "media-my-face");
  assert.equal(mediaId("demo.mp4", new Set(["media-demo"])), "media-demo-2");
  assert.equal(mediaId("demo.mp4", new Set(["media-demo-audio"])), "media-demo-2");
  assert.equal(mediaId(".mp4", new Set()), "media-clip");
});
