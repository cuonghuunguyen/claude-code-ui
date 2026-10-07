import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Loading placeholder (shadcn Skeleton as a span: valid inside buttons). Decorative. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="skeleton" aria-hidden className={cn("block animate-pulse rounded-md bg-foreground/10 motion-reduce:animate-none", className)} {...props} />;
}

/** A title that is still a placeholder (GH-133): a skeleton bar, with the placeholder text kept for screen readers. */
export function TitleSkeleton({ title, className }: { title: string; className?: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center">
      <Skeleton className={cn("h-3 w-24 max-w-full", className)} data-testid="title-skeleton" />
      <span className="sr-only">{title}</span>
    </span>
  );
}
