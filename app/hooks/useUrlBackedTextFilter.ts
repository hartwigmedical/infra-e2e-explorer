import { useDeferredValue, useEffect, useRef, useState } from "react";

/** How long typing has to settle before the filter is written to the URL. Long
 *  enough that a burst of typing is one navigation, short enough that the URL
 *  is shareable by the time anyone reaches for it. */
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * A text filter that lives in the URL but types at native speed.
 *
 * Binding an input straight to a search param makes every keystroke a
 * navigation - and, unless the route opts out via `shouldRevalidate`, a server
 * round-trip. Worse, a controlled input whose value comes from the URL cannot
 * echo a character until that navigation commits, so keys typed in between are
 * read against a stale value and lost. (Typing "sample" into such a box left it
 * reading "pe".)
 *
 * So the input is local state (echoes immediately), the URL is written on a
 * debounce (deep links, Back and `?param=` sharing all still work), and the
 * caller filters off a DEFERRED copy - letting an expensive list re-render at
 * low priority behind the keystroke instead of blocking it.
 *
 * `urlValue` is the param's current value and `writeToUrl` the (stable) writer;
 * returns `[value, setValue, deferredValue]` - bind `value`/`setValue` to the
 * input, filter on `deferredValue`.
 */
export function useUrlBackedTextFilter(
  urlValue: string,
  writeToUrl: (value: string) => void,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): [string, (next: string) => void, string] {
  const [value, setValue] = useState(urlValue);
  const deferred = useDeferredValue(value);
  // The last value this hook itself put in the URL. Lets the sync below tell an
  // EXTERNAL change (Back/Forward, a deep link, a "clear filters" button) -
  // which should adopt the URL - from our own debounced write landing, which
  // must not clobber anything typed since it was scheduled.
  const pushed = useRef(urlValue);

  useEffect(() => {
    if (urlValue === pushed.current) return;
    pushed.current = urlValue;
    setValue(urlValue);
  }, [urlValue]);

  useEffect(() => {
    if (value === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = value;
      writeToUrl(value);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [value, writeToUrl, debounceMs]);

  return [value, setValue, deferred];
}
