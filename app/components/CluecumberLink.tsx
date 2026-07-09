import { ExternalLink } from "lucide-react";
import { cn } from "~/lib/utils";
import { cluecumberRunUrl } from "~/lib/format";

export interface CluecumberLinkProps {
  runId: string;
  /** Optional label after the icon. Omit for an icon-only link. */
  label?: string;
  className?: string;
}

/**
 * External link to a run's Cluecumber HTML report. Run-level only - see
 * ~/lib/format.ts (cluecumberRunUrl) for why we don't deep-link into a
 * specific feature/scenario page.
 *
 * Icon is always rendered; `label` is optional so this works both icon-only
 * (dashboard rows) and icon+label (run detail header).
 */
export default function CluecumberLink({ runId, label, className }: CluecumberLinkProps) {
  return (
    <a
      href={cluecumberRunUrl(runId)}
      target="_blank"
      rel="noreferrer"
      title="Open Cluecumber report"
      className={cn("inline-flex items-center gap-1.5 text-sky-600 hover:underline dark:text-sky-400", className)}
    >
      <ExternalLink size={13} className="shrink-0" />
      {label}
    </a>
  );
}
