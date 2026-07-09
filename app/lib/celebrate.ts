/**
 * Over-the-top (but self-clearing) confetti celebration for a freshly-passed
 * run. Call site (app/routes/runs.$runId.tsx) guards against firing more than
 * once per component mount via a `useRef`; this module has no memory of its
 * own, so calling it again (e.g. after a page refresh) celebrates again.
 *
 * Sequence (~2.7s total): one big center burst, then repeated left/right
 * "cannon" volleys for the duration, plus a handful of randomly-placed
 * "firework" pops. All particles are left to fall/fade away on their own -
 * canvas-confetti tears down its own canvas once every particle has finished
 * animating, so there's nothing to clean up here beyond the timers we set.
 */
import confetti from "canvas-confetti";

const FESTIVE_COLORS = [
  "#22c55e", // emerald
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#ef4444", // red
  "#a855f7", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
];

const DURATION_MS = 2700;
const Z_INDEX = 2000;

function randomInRange(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** A single small burst - used both for the reduced-motion fallback and as a
 *  building block for the "firework" pops in the full sequence. */
function fireworkBurst(originX: number, originY: number) {
  void confetti({
    particleCount: 60,
    spread: 70,
    startVelocity: 35,
    origin: { x: originX, y: originY },
    colors: FESTIVE_COLORS,
    zIndex: Z_INDEX,
    disableForReducedMotion: true,
  });
}

/**
 * Fire the full celebratory confetti sequence. Client-only (guards for
 * SSR/no-window even though this app is `ssr:false` and always runs in the
 * browser) and safe to call eagerly - it schedules its own timers and never
 * blocks the main thread with a long synchronous loop.
 *
 * Respects `prefers-reduced-motion`: when set, this fires a single small,
 * short burst instead of the full sequence (and still passes
 * `disableForReducedMotion: true` to every canvas-confetti call as a second
 * line of defense).
 */
export function fireCelebration(): void {
  if (typeof window === "undefined") return;

  const prefersReducedMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (prefersReducedMotion) {
    void confetti({
      particleCount: 40,
      spread: 60,
      origin: { y: 0.6 },
      colors: FESTIVE_COLORS,
      zIndex: Z_INDEX,
      disableForReducedMotion: true,
    });
    return;
  }

  const timers: ReturnType<typeof setTimeout>[] = [];
  const end = Date.now() + DURATION_MS;

  // 1) Big initial burst from center stage.
  void confetti({
    particleCount: 160,
    spread: 100,
    startVelocity: 45,
    origin: { x: 0.5, y: 0.4 },
    colors: FESTIVE_COLORS,
    zIndex: Z_INDEX,
    disableForReducedMotion: true,
  });

  // 2) Left/right cannons, firing repeatedly across the whole duration.
  (function cannons() {
    if (Date.now() > end) return;

    void confetti({
      particleCount: 45,
      angle: 60,
      spread: 55,
      startVelocity: 55,
      origin: { x: 0, y: 0.85 },
      colors: FESTIVE_COLORS,
      zIndex: Z_INDEX,
      disableForReducedMotion: true,
    });
    void confetti({
      particleCount: 45,
      angle: 120,
      spread: 55,
      startVelocity: 55,
      origin: { x: 1, y: 0.85 },
      colors: FESTIVE_COLORS,
      zIndex: Z_INDEX,
      disableForReducedMotion: true,
    });

    timers.push(setTimeout(cannons, 220));
  })();

  // 3) A few random "firework" pops scattered across the upper portion of the
  // page, spaced out through the sequence.
  const fireworkCount = 5;
  for (let i = 0; i < fireworkCount; i++) {
    const delay = randomInRange(300, DURATION_MS - 300);
    timers.push(
      setTimeout(() => {
        fireworkBurst(randomInRange(0.15, 0.85), randomInRange(0.2, 0.5));
      }, delay),
    );
  }

  // Nothing else to tear down: canvas-confetti manages its own canvas
  // lifecycle and removes it once every particle has finished falling.
  // The `timers` array exists purely to document/scope the scheduled work
  // above; there's no external cancellation path since this always runs to
  // completion once triggered.
  void timers;
}
