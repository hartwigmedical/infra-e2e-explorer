import { cn } from "~/lib/utils";

export interface SparklineProps {
  /** Data points, oldest first. Rendered left-to-right in that order. */
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  strokeWidth?: number;
  className?: string;
  /** Fill under the line, e.g. "currentColor" at low opacity. Omit for no fill. */
  fillOpacity?: number;
}

/**
 * Dependency-free inline-SVG sparkline. No axes/labels - just the trend line,
 * scaled to fit the given width/height. Renders nothing (null) for < 2 points.
 */
export default function Sparkline({
  values,
  width = 120,
  height = 28,
  stroke = "currentColor",
  strokeWidth = 1.5,
  className,
  fillOpacity = 0.12,
}: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = strokeWidth;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 2 * pad) + pad;
    const y = height - pad - ((v - min) / range) * (height - 2 * pad);
    return [x, y] as const;
  });

  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(2)},${height} L${points[0][0].toFixed(2)},${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label="Trend sparkline"
    >
      {fillOpacity > 0 && <path d={areaPath} fill={stroke} fillOpacity={fillOpacity} stroke="none" />}
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
