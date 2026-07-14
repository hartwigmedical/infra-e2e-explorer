/**
 * Shared status vocabulary + Tailwind class helpers for the e2e explorer.
 *
 * Two things map into this kind:
 *  - scenario/step status from the cucumber reports: 'passed' | 'failed' | 'skipped'
 *  - run-level status_token from v_runs/runs: 'ok' | 'failed' | 'unknown'
 *
 * Everything else funnels to 'unknown' so callers never have to guard against
 * unrecognised strings.
 */

export type StatusKind = "passed" | "failed" | "skipped" | "unknown";

/** Normalise a scenario/step status string ('passed' | 'failed' | 'skipped' | ...). */
export function statusKindFromScenario(status: string | null | undefined): StatusKind {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "unknown";
}

/** Normalise a run-level status_token ('ok' | 'failed' | 'unknown'). */
export function statusKindFromRunToken(token: string | null | undefined): StatusKind {
  if (token === "ok") return "passed";
  if (token === "failed") return "failed";
  return "unknown";
}

/** bg + text classes for a filled badge/chip, per status kind. Dark-mode-aware. */
export function statusClasses(kind: StatusKind): string {
  switch (kind) {
    case "passed":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "bg-red-500/15 text-red-600 dark:text-red-400";
    case "skipped":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    case "unknown":
    default:
      return "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
  }
}

/** Solid dot color class (e.g. for a small status indicator), per status kind. */
export function statusDotClass(kind: StatusKind): string {
  switch (kind) {
    case "passed":
      return "bg-emerald-500";
    case "failed":
      return "bg-red-500";
    case "skipped":
      return "bg-amber-500";
    case "unknown":
    default:
      // "No data" — deliberately faint so present-but-empty cells recede.
      return "bg-zinc-200 dark:bg-zinc-700";
  }
}

/**
 * Colour-blind-safe glyph for a status kind, meant to be overlaid on the
 * fill colour from `statusDotClass`/`statusClasses` (see StatusMark). Status
 * must never be conveyed by hue alone:
 *  - passed  -> solid fill, no glyph
 *  - failed  -> a centered dash/minus ("–")
 *  - skipped -> a centered dot ("·"), distinct from the failed dash
 *  - unknown -> empty/muted, no glyph
 */
export function statusGlyph(kind: StatusKind): string {
  switch (kind) {
    case "failed":
      return "–";
    case "skipped":
      return "·";
    case "passed":
    case "unknown":
    default:
      return "";
  }
}

/** Human label for a status kind, title-cased. */
export function statusLabel(kind: StatusKind): string {
  switch (kind) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "unknown":
    default:
      return "Unknown";
  }
}
