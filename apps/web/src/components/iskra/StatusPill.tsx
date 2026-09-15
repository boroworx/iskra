import type { PillTone } from "@iskra/client-runtime/card-face";

import { cn } from "~/lib/utils";

const TONE_CLASS: Record<PillTone, string> = {
  gray: "bg-secondary text-muted-foreground",
  blue: "bg-primary/11 text-info-foreground dark:bg-primary/16",
  orange: "bg-warning/15 text-warning-foreground dark:bg-warning/16",
  green: "bg-success/15 text-success-foreground dark:bg-success/14",
  red: "bg-destructive/14 text-destructive-foreground dark:bg-destructive/16",
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
