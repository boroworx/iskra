import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { PageColumn } from "./iskra/Page";

/** `readable` and `expanded` are the old names for `reading` and `wide`; callers are moving off them. */
export type WorkspacePageWidth = "reading" | "wide" | "readable" | "expanded";

/**
 * The frame of a large-title page (settings, Usage, Pull Requests, Diagnostics): a centered
 * reading (720) or wide (960) column that owns the 32px inset under the toolbar row, so every
 * large title starts at the same y. Callers pass no top padding or max width.
 */
export function WorkspacePageContainer(props: {
  readonly width?: WorkspacePageWidth;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const width = props.width === "wide" || props.width === "expanded" ? "wide" : "reading";
  return (
    <PageColumn
      width={width}
      className={cn(
        "flex flex-col gap-6 pb-12",
        props.className,
        // Last, so a caller's padding can't move the title; the frame's inset replaces the title's own margin.
        "pt-8 *:data-[slot=page-large-title]:my-0",
      )}
    >
      {props.children}
    </PageColumn>
  );
}
