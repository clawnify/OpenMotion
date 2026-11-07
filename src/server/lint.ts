// HyperFrames' own linter, run on every composition the app hands out.
//
// The rules catch what renders wrong without failing: a CSS transform that a
// GSAP tween silently throws away (the title is no longer centred), a timeline
// that is never registered (nothing moves), Math.random() (frames differ from
// run to run). None of these stop a render, so without a lint the first sign
// is a finished MP4 that looks off. Each finding carries the fix, which is
// what lets the agent repair its own work before it reports back.
//
// The `browser` entry has no Node dependencies, so this runs in the Worker.
// It is loaded on first use: it is most of the Worker's code, and loading it
// at startup would slow every cold start, including routes that never lint.

import type { HyperframeLintFinding } from "@hyperframes/lint/browser";
import { fontFamiliesIn, genericFirstFonts, offBrandColors, paletteText, type Brand } from "../shared/brand.ts";
import { googleFontExists } from "./google-fonts.ts";

export interface LintFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** How to fix it, in HyperFrames' words. */
  fix?: string;
  /** One-based line in the composition HTML as stored. */
  line?: number;
}

export interface Lint {
  errors: number;
  warnings: number;
  /** At most MAX_FINDINGS, most important first; the counts cover all. */
  findings: LintFinding[];
}

const MAX_FINDINGS = 10;

/**
 * Rules whose fix this app has no way to make. timeline_track_too_dense says
 * to move scenes into separate .html files under compositions/; a composition
 * here is one HTML document, so the badge would point at a fix nobody can
 * apply (every product demo has a still per step and would carry it).
 * nested_structure_needs_subcomposition says the same about any scene wrapper
 * with an inner layout (<div id="s1"><div id="s1i">…). It is only a warning
 * outside HyperFrames Studio and the scene renders fine; the one in-document
 * way to silence it, data-composition-id on the scene, changes how the runtime
 * times the scene's children, so an agent chasing the badge breaks working
 * animation.
 */
const NOT_HERE = new Set(["timeline_track_too_dense", "nested_structure_needs_subcomposition"]);

/**
 * audio_volume_tween_overrides_gain warns that a tween on `volume` replaces a
 * clip's data-volume. On a clip at data-volume="0" whose level the timeline
 * sets (agent.md: music faded in from silence) that is the intent, and its fix,
 * "reset data-volume to 1", makes the render's first frame play at full level,
 * a pop. So it stays only where it means something: a gain the tween drops.
 */
function intendedSilentBase(html: string, f: HyperframeLintFinding): boolean {
  if (f.code !== "audio_volume_tween_overrides_gain" || !f.elementId) return false;
  const id = f.elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(new RegExp(`<(?:audio|video)\\b[^>]*\\sid="${id}"[^>]*>`))?.[0];
  return !!tag && /\bdata-volume="0(?:\.0*)?"/.test(tag);
}

/**
 * The document the renderer actually loads. The render service wraps a bare
 * root <div> in a page (apps/services `toIndexHtml`) and leaves a full
 * document alone, so lint the same thing, or the linter flags the missing
 * wrapper that the render adds. The wrapper opens on the composition's first
 * line, so the linter's line numbers are the stored HTML's line numbers.
 */
function asRendered(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style></head><body>${html}\n</body></html>`;
}

/** Errors before warnings, and within each, every distinct problem once
 *  before any repeat: ten copies of one rule would hide the eleventh rule. */
function byImportance(findings: HyperframeLintFinding[]): HyperframeLintFinding[] {
  const seen = new Map<string, number>();
  return findings
    .map((f) => {
      const nth = seen.get(f.code) ?? 0;
      seen.set(f.code, nth + 1);
      return { f, key: [f.severity === "error" ? 0 : 1, nth] };
    })
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
    .map((x) => x.f);
}

/**
 * The app's own rule beside HyperFrames' rules: a colour with a hue that is
 * not one of the brand's (shared/brand.ts says which colours count). One
 * finding per colour, at its first use. A warning: a video can mean to step
 * outside the brand, and the user can still say so.
 */
function brandFindings(html: string, brand: Brand | null | undefined): HyperframeLintFinding[] {
  if (!brand) return [];
  return offBrandColors(html, brand).map((c): HyperframeLintFinding => ({
    severity: "warning",
    code: "off_brand_color",
    message: `${c.raw} is not one of the brand's colors.`,
    fixHint: `Use a brand color (${paletteText(brand)}): as it is, lighter or darker, or at an opacity. Greys, black and white are always fine.`,
    line: c.line,
  }));
}

/**
 * font_family_without_font_face says a family that is not bundled with the
 * renderer, and not loaded by a <link>, cannot be supplied. The renderer does
 * supply it: it fetches any family Google Fonts serves under that exact name.
 * So the finding stays only for names Google does not know (a typo, the wrong
 * case), which do fall back, and as it was when Google could not be asked.
 * The rule reads <style> blocks only, never a style attribute.
 */
async function withoutGoogleFonts(html: string, f: HyperframeLintFinding): Promise<HyperframeLintFinding | null> {
  if (f.code !== "font_family_without_font_face") return f;
  const listed = f.message.match(/declaration: (.+?)\. These/)?.[1];
  if (!listed) return f;
  // The rule lowercases the names; Google answers only to the name as written.
  const asWritten = new Map(fontFamiliesIn(html).map((n) => [n.toLowerCase(), n]));
  const names = listed.split(", ").map((n) => asWritten.get(n) ?? n);
  const answers = await Promise.all(names.map(googleFontExists));
  if (answers.includes(null)) return f;
  const missing = names.filter((_, i) => !answers[i]);
  if (!missing.length) return null;
  return {
    ...f,
    message: `Google Fonts has no ${missing.length === 1 ? "family" : "families"} named exactly ${missing.join(", ")}, so the video falls back to another font.`,
    fixHint: `Check the name on fonts.google.com: names are case sensitive ("Roboto Mono", not "roboto mono"). Or use a font the renderer bundles, such as Inter or JetBrains Mono.`,
  };
}

const NAMED_FIRST: Record<string, string> = {
  monospace: "'JetBrains Mono', monospace",
  "ui-monospace": "'JetBrains Mono', ui-monospace",
  serif: "'EB Garamond', serif",
  "ui-serif": "'EB Garamond', ui-serif",
};

/**
 * The app's own font rule: a font list that starts with monospace or serif
 * comes out in Inter (shared/brand.ts genericFirstFonts says why), while the
 * preview shows the browser's own. A warning per family, at its first use.
 */
function genericFontFindings(html: string): HyperframeLintFinding[] {
  return genericFirstFonts(html).map((g): HyperframeLintFinding => {
    const example = NAMED_FIRST[g.generic.toLowerCase()];
    return {
      severity: "warning",
      code: "generic_font_first",
      message: `A font list that starts with ${g.generic} comes out in Inter in the video: the renderer puts Inter in front of a list that starts with a generic family. The preview shows the browser's ${g.generic} font instead.`,
      fixHint: `Name a font first and keep ${g.generic} as the fallback${example ? `: font-family: ${example}` : ""}. Any Google Fonts family works by its exact name.`,
      line: g.line,
    };
  });
}

/** null when there is nothing to lint, or the linter itself failed: a lint
 *  must never be the reason a save or a read does not go through. With a
 *  brand, colours outside it are reported too. */
export async function lintComposition(html: string, brand?: Brand | null): Promise<Lint | null> {
  if (!html.trim()) return null;
  try {
    const { lintHyperframeHtml } = await import("@hyperframes/lint/browser");
    const result = await lintHyperframeHtml(asRendered(html));
    // "info" findings are advice about fonts and the like, not problems.
    // NOT_HERE are rules whose fix cannot be made in this app (see above).
    const upstream = result.findings.filter((f) => f.severity !== "info" && !NOT_HERE.has(f.code) && !intendedSilentBase(html, f));
    const checked = (await Promise.all(upstream.map((f) => withoutGoogleFonts(html, f)))).filter((f) => f !== null);
    const real = byImportance([...checked, ...genericFontFindings(html), ...brandFindings(html, brand)]);
    return {
      errors: real.filter((f) => f.severity === "error").length,
      warnings: real.filter((f) => f.severity === "warning").length,
      findings: real.slice(0, MAX_FINDINGS).map((f) => ({
        severity: f.severity as LintFinding["severity"],
        code: f.code,
        message: f.message,
        ...(f.fixHint ? { fix: f.fixHint } : {}),
        ...(f.line ? { line: f.line } : {}),
      })),
    };
  } catch (err) {
    console.error("lint failed", err);
    return null;
  }
}
