// The timeline's drag arithmetic: moves, trims, frames and snapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dragEdit, nearestSnap, snapPointsFor } from "../src/client/timeline-edit.ts";

const clip = { id: "a", start: 1, duration: 2 };
// 100 px per second, 30 fps, no snap points unless a test adds them.
const ctx = (snapPoints: number[] = []) => ({ zoom: 100, fps: 30, snapPx: 6, snapPoints });

test("a move keeps the duration and lands on a frame", () => {
  // 1 + 0.511 = 1.511 s, which is frame 45.33 at 30 fps: it lands on frame 45 = 1.5 s.
  const r = dragEdit("move", clip, 0.511, ctx());
  assert.equal(r.duration, undefined);
  assert.equal(r.start, 1.5);
});

test("a move never goes before 0", () => {
  assert.equal(dragEdit("move", clip, -5, ctx()).start, 0);
});

test("a left trim keeps the end", () => {
  const r = dragEdit("left", clip, 0.5, ctx());
  assert.equal(r.start, 1.5);
  assert.equal(r.duration, 1.5);
});

test("a right trim keeps the start", () => {
  const r = dragEdit("right", clip, 1, ctx());
  assert.equal(r.start, undefined);
  assert.equal(r.duration, 3);
});

test("a trim never makes a clip shorter than 0.1 s", () => {
  assert.equal(dragEdit("right", clip, -10, ctx()).duration, 0.1);
  const l = dragEdit("left", clip, 10, ctx());
  assert.equal(l.duration, 0.1);
  assert.equal(l.start, 2.9);
});

test("the start snaps to a point within 6 px", () => {
  // 1 + 0.97 = 1.97; the playhead at 2.0 is 3 px away at 100 px/s.
  const r = dragEdit("move", clip, 0.97, ctx([2]));
  assert.equal(r.start, 2);
  assert.equal(r.snappedTo, 2);
});

test("the end snaps when it lands closer than the start", () => {
  // start 1 -> 1.48 (end 3.48); an edge at 3.5 is 2 px from the end.
  const r = dragEdit("move", clip, 0.48, ctx([3.5]));
  assert.equal(r.start, 1.5);
  assert.equal(r.snappedTo, 3.5);
});

test("nothing snaps beyond 6 px", () => {
  assert.equal(nearestSnap(1.9, ctx([2])), null); // 10 px away
  assert.equal(dragEdit("move", clip, 0.9, ctx([2])).snappedTo, null);
});

test("snap points are 0, the playhead, the end and the other clips' edges", () => {
  const all = [clip, { id: "b", start: 4, duration: 1 }];
  assert.deepEqual(snapPointsFor(clip, all, 2.5, 8), [0, 2.5, 8, 4, 5]);
});
