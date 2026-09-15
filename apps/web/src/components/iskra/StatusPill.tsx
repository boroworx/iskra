import type { PillTone } from "@iskra/client-runtime/card-face";

import { cn } from "~/lib/utils";

const TONE_CLASS: Record<PillTone, string> = {
  gray: "bg-muted-foreground/15 text-muted-foreground",
  blue: "bg-primary/15 text-info-foreground",
  orange: "bg-warning/16 text-warning-foreground",
  green: "bg-success/15 text-success-foreground",
  red: "bg-destructive/15 text-destructive-foreground",
};

/** A capsule naming a status, colored by what it means. */
export function StatusPill(props: {
  readonly label: string;
  readonly tone: PillTone;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold",
        TONE_CLASS[props.tone],
        props.className,
      )}
    >
      {props.label}
    </span>
  );
}
