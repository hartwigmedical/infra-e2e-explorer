import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "~/lib/utils";

export interface TagFilterProps {
  /** All selectable tags (e.g. "@report"), typically sorted. */
  allTags: string[];
  /** Currently-selected tags. */
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

/**
 * Compact multi-select tag filter behind a dropdown button, so the (often
 * long) tag list doesn't dominate the toolbar. Selecting tags filters by
 * union. Dependency-free popover (button + click-outside), styled with the
 * shared design tokens.
 */
export default function TagFilter({ allTags, selected, onChange, className }: TagFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(tag: string) {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  }

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground",
          selected.length > 0 && "border-primary/40 bg-accent"
        )}
      >
        <span>Tags</span>
        {selected.length > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
            {selected.length}
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-72 w-60 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mb-1 flex w-full items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              <X className="size-3" /> Clear {selected.length} selected
            </button>
          )}
          {allTags.length === 0 && (
            <div className="px-2 py-1 text-sm text-muted-foreground">No tags</div>
          )}
          {allTags.map((tag) => {
            const on = selected.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggle(tag)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent",
                  on && "font-medium"
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-input"
                  )}
                >
                  {on ? "✓" : ""}
                </span>
                <span className="truncate">{tag}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
