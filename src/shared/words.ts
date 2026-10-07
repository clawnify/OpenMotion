// Word timings for a voice, and the caption lines made from them.
//
// A voice asset carries `words`: each spoken word with when it starts and ends,
// in seconds into the file. Speech made here gets them from ElevenLabs with the
// audio (character times, joined into words); a recording or video gets them by
// transcription. Captions are then a matter of grouping words into short lines
// and placing each line where the clip plays, which is what `groupWords` does.
//
// The grouping follows HyperFrames' caption rules: break at the end of a
// sentence, at a pause of 150 ms or more, or at the word limit; and also at a
// comma, with a long phrase spread evenly over its lines.

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface CaptionGroup extends Word {
  /** When the line leaves the screen: the next line's start after a short gap, else shortly after it ends. */
  until: number;
  words: Word[];
}

/** ElevenLabs' character alignment (text-to-speech `/with-timestamps`). */
export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

const ms = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Scripts written without spaces between words (Chinese, Japanese, Thai, ...).
 * A run of them is split into words by the runtime's own word segmenter, and
 * their words are joined back without a space.
 */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Characters with times -> words with times. Punctuation stays on its word, as it is read. */
export function wordsFromAlignment(a: CharacterAlignment | null | undefined): Word[] {
  if (!a) return [];
  const n = Math.min(a.characters.length, a.character_start_times_seconds.length, a.character_end_times_seconds.length);
  const words: Word[] = [];
  // A run of non-space characters, as indexes into the alignment.
  let run: number[] = [];
  const word = (from: number, to: number) => {
    words.push({
      text: run.slice(from, to).map((i) => a.characters[i]).join(""),
      start: ms(a.character_start_times_seconds[run[from]]),
      end: ms(a.character_end_times_seconds[run[to - 1]]),
    });
  };
  const flush = () => {
    if (!run.length) return;
    const text = run.map((i) => a.characters[i]).join("");
    if (!UNSPACED.test(text)) {
      word(0, run.length);
    } else {
      // Where each segment of the run starts, as a position in `run`.
      const at: number[] = [];
      run.forEach((i, k) => {
        for (let u = 0; u < a.characters[i].length; u++) at.push(k);
      });
      let from = 0;
      let open = false; // the current word has its letters (not only leading punctuation)
      for (const seg of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
        const k = at[seg.index];
        if (seg.isWordLike && open) {
          word(from, k);
          from = k;
        }
        if (seg.isWordLike) open = true;
      }
      word(from, run.length);
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    if (/^\s*$/.test(a.characters[i])) flush();
    else run.push(i);
  }
  flush();
  return words;
}

/** ElevenLabs speech-to-text words -> spoken words (spacing and sound events dropped). */
export function wordsFromTranscript(
  items: Array<{ text?: string; start?: number | null; end?: number | null; type?: string }> | null | undefined,
): Word[] {
  const words: Word[] = [];
  for (const w of items ?? []) {
    if (w.type && w.type !== "word") continue;
    const text = (w.text ?? "").trim();
    if (!text || typeof w.start !== "number" || typeof w.end !== "number") continue;
    words.push({ text, start: ms(w.start), end: ms(Math.max(w.end, w.start)) });
  }
  return words;
}

/** A stored `words` column -> words, or null when there are none or it is not ours. */
export function parseWords(raw: string | null | undefined): Word[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Word[]) : null;
  } catch {
    return null;
  }
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const CLAUSE_END = /[,;:，、；：–—]["'”’)\]]*$/;
export const PAUSE = 0.15;
/** A gap shorter than this keeps the line up until the next one. */
const HOLD = 0.5;
/** Otherwise a line stays this long after its last word. */
const LINGER = 0.2;

/**
 * Words -> caption lines of at most `maxWords`. A line never runs across a
 * sentence end, a comma or similar, or a pause; a phrase longer than the limit
 * is split into lines of even length ("Captions should land / on the words.",
 * not "Captions should land on / the words."). `offset` moves every time by
 * where the clip starts in the video, so the lines can be placed as they are;
 * `until` says when each leaves the screen.
 */
export function groupWords(words: Word[], maxWords = 4, offset = 0): CaptionGroup[] {
  const max = Math.max(1, Math.floor(maxWords));
  const phrases: Word[][] = [];
  let phrase: Word[] = [];
  words.forEach((w, i) => {
    phrase.push(w);
    const next = words[i + 1];
    if (!next || SENTENCE_END.test(w.text) || CLAUSE_END.test(w.text) || next.start - w.end >= PAUSE) {
      phrases.push(phrase);
      phrase = [];
    }
  });

  const groups: CaptionGroup[] = [];
  for (const p of phrases) {
    const lines = Math.ceil(p.length / max);
    let at = 0;
    for (let l = 0; l < lines; l++) {
      const size = Math.floor(p.length / lines) + (l < p.length % lines ? 1 : 0);
      const shifted = p.slice(at, at + size).map((w) => ({ text: w.text, start: ms(w.start + offset), end: ms(w.end + offset) }));
      at += size;
      const last = shifted[shifted.length - 1];
      groups.push({ text: joinWords(shifted), start: shifted[0].start, end: last.end, until: ms(last.end + LINGER), words: shifted });
    }
  }
  // Hold a line until the next one when the gap is short, so captions don't blink.
  groups.forEach((g, i) => {
    const next = groups[i + 1];
    if (next && next.start - g.end < HOLD) g.until = next.start;
  });
  return groups;
}

/** Words as a line: spaced, except between words of a script written without spaces. */
function joinWords(words: Word[]): string {
  return words.reduce((line, w, i) => {
    if (i === 0) return w.text;
    return line + (UNSPACED.test(words[i - 1].text) && UNSPACED.test(w.text) ? "" : " ") + w.text;
  }, "");
}
