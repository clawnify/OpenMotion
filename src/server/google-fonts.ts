// Does Google Fonts serve a family under exactly this name? The renderer
// fetches every font that is not bundled from the same css2 endpoint by the
// name the composition gives, so this is the question that decides whether a
// font shows up in the video. css2 answers 400 for an unknown name and for a
// mis-cased one ("inter"), 200 for a family that lacks some of the weights.

import { googleFontsHref } from "../shared/brand.ts";

// An answer, once known, holds for the isolate's life; a failed request is
// not remembered, so the next lint asks again.
const known = new Map<string, boolean>();

/** true or false from Google; null when it could not be reached. */
export async function googleFontExists(family: string): Promise<boolean | null> {
  const cached = known.get(family);
  if (cached !== undefined) return cached;
  try {
    const r = await fetch(googleFontsHref(family));
    const answer = r.ok ? true : r.status === 400 ? false : null;
    if (answer !== null) known.set(family, answer);
    return answer;
  } catch {
    return null;
  }
}
