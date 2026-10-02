// Keep a clip's GSAP entrance aligned with its position on the timeline.
//
// A clip is a DOM element that HyperFrames mounts at its `data-start`; its
// entrance is a GSAP tween placed at an ABSOLUTE composition time in the
// <script>, authored to equal that start (the starter and agent.md both teach
// `tl.from("#id", {...}, <data-start>)`). Moving or left-trimming the clip
// rewrites `data-start` but not the tween's position, so the entrance has
// already finished by the time the clip mounts and it hard-pops in with no
// animation. Shifting the tween position by the same delta keeps the entrance
// playing when the clip appears.
//
// This is a deliberately NARROW source rewrite, not a GSAP parser: it only
// touches `.from/.to/.fromTo("#id", …, <number>)` calls whose target is
// EXACTLY the moved clip's id and whose position is a plain numeric literal.
// Anything ambiguous (a relative "+=1" / "<" position, a label, a class or
// multi-target selector, an omitted position) is left untouched, so the worst
// case is the current pop-in — never a corrupted script.

/** Return the index of the ')' that closes the '(' at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level comma-separated argument ranges [start, end) within a call body. */
function topLevelArgRanges(s: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, s.length]);
  return ranges;
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Round to 4 decimals so a shift never leaves float noise (2.3, not 2.3000001). */
function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Shift the position of every tween that targets `#id` with a numeric position,
 * by `delta` seconds. Returns the script unchanged when there is nothing safe
 * to shift.
 */
export function shiftTweenPositions(script: string, id: string, delta: number): string {
  if (!id || !Number.isFinite(delta) || delta === 0) return script;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `.from` / `.to` / `.fromTo` whose first argument is exactly "#id" or '#id'.
  const head = new RegExp(`\\.(?:fromTo|from|to)\\s*\\(\\s*(['"])#${esc}\\1`, "g");
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = head.exec(script)) !== null) {
    const open = script.indexOf("(", m.index);
    const close = matchParen(script, open);
    if (close < 0) break;
    const inner = script.slice(open + 1, close);
    const ranges = topLevelArgRanges(inner);
    const [aStart, aEnd] = ranges[ranges.length - 1];
    const seg = inner.slice(aStart, aEnd);
    const token = seg.trim();
    if (ranges.length >= 3 && NUMERIC.test(token)) {
      const lead = seg.length - seg.trimStart().length;
      const trail = seg.length - seg.trimEnd().length;
      const shifted = seg.slice(0, lead) + String(round(parseFloat(token) + delta)) + seg.slice(seg.length - trail);
      const newInner = inner.slice(0, aStart) + shifted + inner.slice(aEnd);
      result += script.slice(last, open + 1) + newInner;
      last = close;
    }
    head.lastIndex = close;
  }
  result += script.slice(last);
  return result;
}
