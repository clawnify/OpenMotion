// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { insertMedia, mediaKind } from "../src/shared/insert-media.ts";
import { starterHtml } from "../src/client/starter.ts";
import { compositionLength } from "../src/shared/length.ts";

const starter = starterHtml(1920, 1080);

test("an image goes in at the playhead, centred, on a new track, inside the root before its scripts", () => {
  const r = insertMedia(starter, { src: "assets/logo.png", kind: "image", seconds: 3, at: 1.25 })!;
  assert.equal(r.id, "media-1");
  assert.match(r.html, /<img id="media-1" src="assets\/logo.png" class="clip" data-start="1.25" data-duration="3" data-track-index="3"\n\s+style="position:absolute;inset:0;margin:auto;max-width:60%;max-height:60%" \/>\n\s*<script/);
});

test("a video fills the frame muted, with its sound on an <audio> clip on the next track", () => {
  const r = insertMedia(starter, { src: "assets/talk.mp4", kind: "video", seconds: 7.5, at: 0 })!;
  assert.match(r.html, /<video id="media-1" src="assets\/talk.mp4" class="clip" data-start="0" data-duration="7.5" data-track-index="3" muted playsinline/);
  assert.match(r.html, /<audio id="media-1-audio" src="assets\/talk.mp4" class="clip" data-start="0" data-duration="7.5" data-track-index="4"/);
  // The starter is 5 s long: the video grows to hold the clip.
  assert.equal(compositionLength(r.html), 7.5);
});

test("ids don't collide, and a composition without a root is refused", () => {
  const once = insertMedia(starter, { src: "assets/a.png", kind: "image", seconds: 2, at: 0 })!;
  const twice = insertMedia(once.html, { src: "assets/b.png", kind: "image", seconds: 2, at: 0 })!;
  assert.equal(twice.id, "media-2");
  assert.equal(insertMedia("<div>no root</div>", { src: "assets/a.png", kind: "image", seconds: 2, at: 0 }), null);
});

test("a path cannot break out of its attribute", () => {
  const r = insertMedia(starter, { src: 'assets/x" onerror="alert(1)', kind: "image", seconds: 2, at: 0 })!;
  assert.doesNotMatch(r.html, /onerror="alert/);
});

test("the clip kind comes from the MIME type", () => {
  assert.equal(mediaKind("image/png"), "image");
  assert.equal(mediaKind("video/mp4"), "video");
  assert.equal(mediaKind("audio/mpeg"), "audio");
  assert.equal(mediaKind("application/pdf"), null);
});
