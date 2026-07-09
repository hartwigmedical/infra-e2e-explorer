import { cn } from "~/lib/utils";
import { statusDotClass, statusLabel, type StatusKind } from "~/lib/status";

export interface StatusMarkProps {
  kind: StatusKind;
  /** "dot" for per-step/per-scenario indicators, "square" for grid/strip cells. */
  shape?: "dot" | "square";
  /** Edge length in px. Defaults to ~14. */
  size?: number;
  /** Native tooltip. Defaults to the status label. */
  title?: string;
  className?: string;
}

/**
 * Colour-blind-safe status indicator: the status colour plus a distinct,
 * perfectly-centered CSS-shape glyph so passed/failed/skipped read apart
 * without relying on hue — passed = solid, failed = horizontal dash, skipped =
 * centered dot, unknown/no-data = empty. Glyphs are drawn as flex-centered
 * <span>s (not text characters, whose font metrics rendered off-centre). This
 * is the single place status colour + glyph are painted; the history strip,
 * step-history grid, and per-step/scenario dots all go through it.
 */
export default function StatusMark({ kind, shape = "dot", size = 14, title, className }: StatusMarkProps) {
  return (
    <span
      title={title ?? statusLabel(kind)}
      className={cn(
        // align-middle: keep empty (passed) and glyph-bearing (failed/skipped)
        // marks on the same line — inline-flex boxes otherwise baseline
        // differently depending on whether they contain content.
        "inline-flex shrink-0 items-center justify-center align-middle select-none",
        shape === "dot" ? "rounded-full" : "rounded-sm",
        statusDotClass(kind),
        className
      )}
      style={{ width: size, height: size }}
    >
      {kind === "failed" && (
        <span
          aria-hidden="true"
          className="block rounded-full bg-white/95"
          style={{ width: Math.max(6, Math.round(size * 0.55)), height: Math.max(2, Math.round(size * 0.16)) }}
        />
      )}
      {kind === "skipped" && (
        <span
          aria-hidden="true"
          className="block rounded-full bg-white/95"
          style={{ width: Math.max(3, Math.round(size * 0.32)), height: Math.max(3, Math.round(size * 0.32)) }}
        />
      )}
      {/* passed: solid fill, no glyph. unknown/no-data: empty. */}
    </span>
  );
}
