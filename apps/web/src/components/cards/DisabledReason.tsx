import type { ReactElement } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Wraps a control that may be disabled so hovering it says why; with no reason it renders as is. */
export function DisabledReason(props: {
  readonly reason: string | null;
  readonly children: ReactElement;
  /** Layout for the wrapper (self-end, ms-auto…), which is the flex child while a reason shows. */
  readonly className?: string;
}) {
  if (props.reason === null) {
    return props.children;
  }
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the wrapper carries the hover. */}
      <TooltipTrigger render={<span className={cn("inline-flex", props.className)} />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {props.reason}
      </TooltipPopup>
    </Tooltip>
  );
}
