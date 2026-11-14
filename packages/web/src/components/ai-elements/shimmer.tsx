"use client";
// Derived from AI Elements (Apache-2.0, Copyright 2023 Vercel, Inc.), modified; see THIRD_PARTY_NOTICES.md.
// The sweep is a CSS keyframe (`shimmer-sweep` in index.css) instead of `motion`: motion-dom and framer-motion were 450 KB of the entry chunk for this one effect.

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo, useMemo, useSyncExternalStore } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  const q = window.matchMedia?.(REDUCED);
  q?.addEventListener?.("change", cb);
  return () => q?.removeEventListener?.("change", cb);
};
const reducedNow = () => window.matchMedia?.(REDUCED).matches ?? false;
/** True while the user asks the system for reduced motion (live: it follows a change of the setting). */
const useReducedMotion = () => useSyncExternalStore(subscribeReduced, reducedNow, () => false);

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  if (useReducedMotion()) {
    return <Component className={cn("text-muted-foreground", className)}>{children}</Component>;
  }

  return (
    <Component
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
          animation: `shimmer-sweep ${duration}s linear infinite`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
