import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Copy text to the clipboard, resolving to whether it succeeded. Prefers the
 * async Clipboard API but falls back to a hidden <textarea> +
 * document.execCommand("copy"). The async API only exists in a secure context,
 * and this tool is served over plain HTTP (http://e2e-explorer.gateway.pilot-1),
 * so the fallback is the normal path in production - not an edge case.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Secure-context API present but rejected (permissions, not focused, …) -
      // fall through to the execCommand path, which works without it.
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
