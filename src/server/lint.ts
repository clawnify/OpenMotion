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
 */
const NOT_HERE = new Set(["timeline_track_too_dense"]);

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

/** null when there is nothing to lint, or the linter itself failed: a lint
 *  must never be the reason a save or a read does not go through. */
export async function lintComposition(html: string): Promise<Lint | null> {
  if (!html.trim()) return null;
  try {
    const { lintHyperframeHtml } = await import("@hyperframes/lint/browser");
    const result = await lintHyperframeHtml(asRendered(html));
    // "info" findings are advice about fonts and the like, not problems.
    // NOT_HERE are rules whose fix cannot be made in this app (see below).
    const real = byImportance(result.findings.filter((f) => f.severity !== "info" && !NOT_HERE.has(f.code)));
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
