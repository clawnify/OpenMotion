// Word timings for a voice, and the caption lines made from them.
//
// A voice asset carries `words`: each spoken word with when it starts and ends,
// in seconds into the file. Speech made here gets them from ElevenLabs with the
// audio (character times, joined into words); a recording or video gets them by
// transcription. Captions are then a matter of grouping words into short lines
// and placing each line where the clip plays, which is what `groupWords` does.
//
// The grouping follows HyperFrames' caption rules: break at the end of a
// sentence, at a pause of 150 ms or more, or at the word limit.

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface CaptionGroup extends Word {
  words: Word[];
}

/** ElevenLabs' character alignment (text-to-speech `/with-timestamps`). */
export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

const ms = (n: number) => Math.round(n * 1000) / 1000;

/** Characters with times -> words with times. Punctuation stays on its word, as it is read. */
export function wordsFromAlignment(a: CharacterAlignment | null | undefined): Word[] {
  if (!a) return [];
  const words: Word[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  const n = Math.min(a.characters.length, a.character_start_times_seconds.length, a.character_end_times_seconds.length);
  for (let i = 0; i <= n; i++) {
    const ch = i < n ? a.characters[i] : " ";
    if (/^\s*$/.test(ch)) {
      if (text) words.push({ text, start: ms(start), end: ms(end) });
      text = "";
      continue;
    }
    if (!text) start = a.character_start_times_seconds[i];
    text += ch;
    end = a.character_end_times_seconds[i];
  }
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
export const PAUSE = 0.15;

/**
 * Words -> caption lines: at most `maxWords` each, broken at a sentence end or
 * a pause. `offset` moves every time by where the clip starts in the video,
 * so the lines can be placed as they are.
 */
export function groupWords(words: Word[], maxWords = 4, offset = 0): CaptionGroup[] {
  const max = Math.max(1, Math.floor(maxWords));
  const groups: CaptionGroup[] = [];
  let line: Word[] = [];
  const close = () => {
    if (!line.length) return;
    const shifted = line.map((w) => ({ text: w.text, start: ms(w.start + offset), end: ms(w.end + offset) }));
    groups.push({
      text: shifted.map((w) => w.text).join(" "),
      start: shifted[0].start,
      end: shifted[shifted.length - 1].end,
      words: shifted,
    });
    line = [];
  };
  words.forEach((w, i) => {
    line.push(w);
    const next = words[i + 1];
    if (line.length >= max || SENTENCE_END.test(w.text) || (next && next.start - w.end >= PAUSE)) close();
  });
  close();
  return groups;
}
