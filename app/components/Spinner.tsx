import { Loader2 } from "lucide-react";
import { cn } from "~/lib/utils";

export interface SpinnerProps {
  className?: string;
  size?: number;
}

/** Small spinning loader icon, dependency-free (just lucide-react + Tailwind). */
export default function Spinner({ className, size = 14 }: SpinnerProps) {
  return (
    <Loader2
      className={cn("animate-spin text-muted-foreground", className)}
      size={size}
      aria-label="Loading"
    />
  );
}
