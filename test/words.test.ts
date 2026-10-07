// Run: pnpm test (Node 22+, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupWords, parseWords, wordsFromAlignment, wordsFromTranscript } from "../src/shared/words.ts";

/** Characters with evenly spaced times, as ElevenLabs returns them. */
function alignment(text: string, step = 0.05) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * step),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
  };
}

test("characters become words, timed from first to last letter", () => {
  assert.deepEqual(wordsFromAlignment(alignment("Hi there.")), [
    { text: "Hi", start: 0, end: 0.1 },
    { text: "there.", start: 0.15, end: 0.45 },
  ]);
});

test("runs of spaces and line breaks separate words and are never words", () => {
  const words = wordsFromAlignment(alignment("  One\n\ntwo  "));
  assert.deepEqual(words.map((w) => w.text), ["One", "two"]);
});

test("no alignment, no words", () => {
  assert.deepEqual(wordsFromAlignment(null), []);
});

test("a transcript keeps spoken words only", () => {
  const words = wordsFromTranscript([
    { text: "Hello", start: 0.1, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.5, type: "spacing" },
    { text: "(laughs)", start: 0.5, end: 0.9, type: "audio_event" },
    { text: "world", start: 1, end: 1.3, type: "word" },
    { text: "lost", start: null, end: null, type: "word" },
  ]);
  assert.deepEqual(words, [
    { text: "Hello", start: 0.1, end: 0.4 },
    { text: "world", start: 1, end: 1.3 },
  ]);
});

/** Words spoken back to back, 0.2 s apart (no pauses). */
const spoken = (line: string) => line.split(" ").map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.18 }));

test("a phrase over the word limit is split into lines of even length", () => {
  assert.deepEqual(groupWords(spoken("a b c d e"), 2).map((g) => g.text), ["a b", "c d", "e"]);
  assert.deepEqual(groupWords(spoken("Captions should land on the words."), 4).map((g) => g.text), [
    "Captions should land",
    "on the words.",
  ]);
  assert.deepEqual(groupWords(spoken("and every word knows when it is spoken"), 4).map((g) => g.text), [
    "and every word knows",
    "when it is spoken",
  ]);
});

test("a line never runs across a comma", () => {
  assert.deepEqual(groupWords(spoken("This voice costs $5 a month, and every word"), 4).map((g) => g.text), [
    "This voice costs",
    "$5 a month,",
    "and every word",
  ]);
});

test("lines break at a sentence end and at a pause", () => {
  const words = [
    { text: "Ship", start: 0, end: 0.2 },
    { text: "it.", start: 0.22, end: 0.4 },
    { text: "Then", start: 0.45, end: 0.6 },
    { text: "wait", start: 0.62, end: 0.8 },
    { text: "now", start: 1.2, end: 1.4 },
  ];
  assert.deepEqual(groupWords(words, 5).map((g) => g.text), ["Ship it.", "Then wait", "now"]);
});

test("a line spans its words, moved by where the clip starts", () => {
  const [line] = groupWords([{ text: "Go", start: 0.5, end: 0.8 }, { text: "now", start: 0.85, end: 1.1 }], 4, 2.5);
  assert.deepEqual(line, {
    text: "Go now",
    start: 3,
    end: 3.6,
    words: [
      { text: "Go", start: 3, end: 3.3 },
      { text: "now", start: 3.35, end: 3.6 },
    ],
  });
});

test("stored words read back, and anything else reads as none", () => {
  assert.deepEqual(parseWords('[{"text":"a","start":0,"end":1}]'), [{ text: "a", start: 0, end: 1 }]);
  assert.equal(parseWords(null), null);
  assert.equal(parseWords("{"), null);
  assert.equal(parseWords('{"text":"a"}'), null);
});
