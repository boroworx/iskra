import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SparkGlyph } from "./SparkGlyph";

const COLUMN_CLASS = {
  // Chat, settings, forms: a 720px text column plus 24px padding each side.
  reading: "mx-auto w-full max-w-[768px] px-6",
  // Needs You, Usage, Pull Requests, Diagnostics.
  wide: "mx-auto w-full max-w-[1008px] px-6",
  // Board and attempts run edge to edge.
  canvas: "w-full px-5",
} as const;

export type PageColumnWidth = keyof typeof COLUMN_CLASS;

/**
 * The content column every page sits in (see the page grammar): reading and wide columns are
 * centered in the pane, canvas pages run edge to edge. Use it for a chat's messages and its
 * composer alike so both share the same edges.
 */
export function PageColumn(props: {
  readonly width?: PageColumnWidth;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn(COLUMN_CLASS[props.width ?? "reading"], props.className)}>
      {props.children}
    </div>
  );
}

/** A page's large title: 28/700, 32px below the toolbar row and 24px above the first section. */
export function PageLargeTitle(props: {
  readonly children: ReactNode;
  readonly accessory?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("mt-8 mb-6 flex min-w-0 items-center gap-2.5", props.className)}>
      <h1 className="min-w-0 truncate text-[28px] leading-tight font-bold tracking-[-0.02em] text-foreground">
        {props.children}
      </h1>
      {props.accessory}
    </div>
  );
}

/**
 * The one empty state: centered in the pane a little above the middle, a 32px glyph (the idle
 * spark by default), a 22/700 title, one line of 15px body, and at most two buttons.
 */
export function EmptyState(props: {
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-[8vh] text-center",
        props.className,
      )}
    >
      <div className="text-muted-foreground" aria-hidden>
        {props.icon ?? <SparkGlyph state="idle" size={32} />}
      </div>
      <h2 className="mt-4 text-[22px] leading-tight font-bold tracking-[-0.01em] text-foreground">
        {props.title}
      </h2>
      {props.body ? (
        <p className="mt-2 max-w-[440px] text-[15px] leading-snug text-muted-foreground">
          {props.body}
        </p>
      ) : null}
      {props.actions ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{props.actions}</div>
      ) : null}
    </div>
  );
}
