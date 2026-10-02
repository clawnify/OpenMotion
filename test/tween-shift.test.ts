// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftTweenPositions } from "../src/shared/tween-shift.ts";

test("shifts a from() entrance by the delta", () => {
  const s = `tl.from("#title", { opacity: 0, y: 50, duration: 1 }, 0.3);`;
  assert.equal(
    shiftTweenPositions(s, "title", 2),
    `tl.from("#title", { opacity: 0, y: 50, duration: 1 }, 2.3);`,
  );
});

test("shifts a negative delta and rounds away float noise", () => {
  const s = `tl.from("#sub", {}, 0.9);`;
  assert.equal(shiftTweenPositions(s, "sub", -0.6), `tl.from("#sub", {}, 0.3);`);
});

test("handles to() and fromTo() (position is the last arg either way)", () => {
  const to = `tl.to("#a", { x: 100 }, 1);`;
  assert.equal(shiftTweenPositions(to, "a", 0.5), `tl.to("#a", { x: 100 }, 1.5);`);
  const fromTo = `tl.fromTo("#b", { opacity: 0 }, { opacity: 1 }, 2);`;
  assert.equal(
    shiftTweenPositions(fromTo, "b", 1),
    `tl.fromTo("#b", { opacity: 0 }, { opacity: 1 }, 3);`,
  );
});

test("shifts every tween that targets the id", () => {
  const s = `tl.from("#x", {}, 0.3).to("#x", { scale: 1.1 }, 1.5);`;
  assert.equal(
    shiftTweenPositions(s, "x", 1),
    `tl.from("#x", {}, 1.3).to("#x", { scale: 1.1 }, 2.5);`,
  );
});

test("leaves other clips' tweens untouched", () => {
  const s = `tl.from("#title", {}, 0.3).from("#sub", {}, 0.9);`;
  assert.equal(
    shiftTweenPositions(s, "title", 2),
    `tl.from("#title", {}, 2.3).from("#sub", {}, 0.9);`,
  );
});

test("leaves a relative position untouched", () => {
  const s = `tl.from("#x", {}, "+=0.5");`;
  assert.equal(shiftTweenPositions(s, "x", 2), s);
});

test("leaves a label position untouched", () => {
  const s = `tl.from("#x", {}, "intro");`;
  assert.equal(shiftTweenPositions(s, "x", 2), s);
});

test("leaves a positionless tween untouched", () => {
  const s = `tl.from("#x", { duration: 1 });`;
  assert.equal(shiftTweenPositions(s, "x", 2), s);
});

test("does not match a class or multi-target selector", () => {
  const cls = `tl.from(".clip", {}, 0.3);`;
  assert.equal(shiftTweenPositions(cls, "clip", 2), cls);
  const multi = `tl.from("#title .word", {}, 0.3);`;
  assert.equal(shiftTweenPositions(multi, "title", 2), multi);
});

test("does not match an id that is a prefix of another", () => {
  const s = `tl.from("#title2", {}, 0.3);`;
  assert.equal(shiftTweenPositions(s, "title", 2), s);
});

test("copes with nested braces and commas in vars", () => {
  const s = `tl.from("#x", { y: 50, onComplete: () => f(1, 2), ease: "power2.out" }, 0.3);`;
  assert.equal(
    shiftTweenPositions(s, "x", 1),
    `tl.from("#x", { y: 50, onComplete: () => f(1, 2), ease: "power2.out" }, 1.3);`,
  );
});

test("a zero delta is a no-op", () => {
  const s = `tl.from("#x", {}, 0.3);`;
  assert.equal(shiftTweenPositions(s, "x", 0), s);
});

test("preserves integer-start whitespace and single quotes", () => {
  const s = `tl.from('#x', {},  2 );`;
  assert.equal(shiftTweenPositions(s, "x", 1), `tl.from('#x', {},  3 );`);
});
