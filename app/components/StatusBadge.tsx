import { cn } from "~/lib/utils";
import { statusClasses, statusLabel, type StatusKind } from "~/lib/status";
import StatusMark from "~/components/StatusMark";

export interface StatusBadgeProps {
  kind: StatusKind;
  /** Override the default label (e.g. show the raw status_token). */
  label?: string;
  className?: string;
}

/** Small pill showing a colour+glyph mark plus a label for a run/scenario/step status. */
export default function StatusBadge({ kind, label, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        statusClasses(kind),
        className
      )}
    >
      <StatusMark kind={kind} shape="dot" size={12} />
      {label ?? statusLabel(kind)}
    </span>
  );
}
