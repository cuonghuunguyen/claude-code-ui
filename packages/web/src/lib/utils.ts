import { useRef } from "react";

export { cn } from "cn"

type Fn = (...args: unknown[]) => unknown;

/**
 * `props` with each function swapped for a stable one that calls the latest version: a memo child skips the render when only the
 * parent's closures changed (a tab switch re-renders App with new closures for every session tab and sidebar row).
 */
export function useStableProps<P extends object>(props: P): P {
  const latest = useRef<Record<string, unknown>>({});
  latest.current = props as Record<string, unknown>;
  const stable = useRef<Record<string, Fn>>({});
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === "function" ? (stable.current[k] ??= (...args) => (latest.current[k] as Fn)(...args)) : v]),
  ) as P;
}
