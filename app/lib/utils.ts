import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Whether the browser can programmatically write to the clipboard. The async
 * Clipboard API (and `navigator.clipboard` itself) only exists in a secure
 * context — HTTPS or localhost — which `window.isSecureContext` reports. This
 * tool is often served over plain HTTP (http://e2e-explorer.gateway.pilot-1),
 * where this is false and callers should fall back to a manual select-to-copy
 * affordance instead of a one-click copy that can't work.
 */
export function canCopyToClipboard(): boolean {
  return typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;
}

/**
 * Copy text to the clipboard, resolving to whether it succeeded. Requires a
 * secure context (see canCopyToClipboard); resolves false when unavailable or
 * rejected, so callers can fall back to letting the user copy manually.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!canCopyToClipboard()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Secure-context API present but rejected (permissions, not focused, …).
    return false;
  }
}

/**
 * Select an element's text contents on-screen so the user can copy it manually
 * (⌘C / Ctrl+C). Used on insecure origins where copyText can't write. Returns
 * whether a selection was made.
 */
export function selectElementText(el: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** The manual-copy keyboard hint for the current platform, e.g. "⌘C" or "Ctrl+C". */
export function copyShortcutLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl+C";
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘C" : "Ctrl+C";
}
