import type { CriterionMark } from "@iskra/client-runtime/card-face";

import { cn } from "~/lib/utils";

const MARK_CLASS: Record<CriterionMark, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  needsYou: "bg-warning",
  pending: "bg-[rgb(120_120_128/18%)] dark:bg-[rgb(120_120_128/32%)]",
};

/** One short segment per acceptance criterion: green passed, red failed, orange for a person. */
export function CriteriaMarks(props: {
  readonly marks: ReadonlyArray<CriterionMark>;
  readonly className?: string;
}) {
  if (props.marks.length === 0) return null;
  const passed = props.marks.filter((mark) => mark === "passed").length;
  return (
    <span
      role="img"
      aria-label={`${passed} of ${props.marks.length} criteria passed`}
      className={cn("flex gap-[3px]", props.className)}
    >
      {props.marks.map((mark, index) => (
        // The marks are positional: criterion order is the card's.
        // oxlint-disable-next-line react/no-array-index-key
        <span key={index} className={cn("h-1 w-3 rounded-full", MARK_CLASS[mark])} />
      ))}
    </span>
  );
}

/** Spend against the card's cap as a thin bar; red once the cap is reached. */
export function SpendBar(props: {
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly className?: string;
}) {
  const ratio = props.capUsd <= 0 ? 1 : Math.min(1, props.spentUsd / props.capUsd);
  return (
    <span
      role="img"
      aria-label={`$${props.spentUsd.toFixed(2)} of $${props.capUsd.toFixed(0)} spent`}
      className={cn(
        "relative h-1 w-11 shrink-0 overflow-hidden rounded-full bg-[rgb(120_120_128/18%)] dark:bg-[rgb(120_120_128/32%)]",
        props.className,
      )}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          ratio >= 1 ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </span>
  );
}

/** Fix rounds used of the project's cap: filled orange dots for used rounds, rings for the rest. */
export function RoundDots(props: {
  readonly used: number;
  readonly cap: number;
  readonly label: string;
}) {
  if (props.cap <= 0) return null;
  const used = Math.min(props.used, props.cap);
  return (
    <span
      role="img"
      aria-label={`${props.label}: ${used} of ${props.cap} used`}
      className="inline-flex gap-1"
    >
      {Array.from({ length: props.cap }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-2 rounded-full",
            index < used ? "bg-warning" : "ring-[1.5px] ring-inset ring-foreground/32",
          )}
        />
      ))}
    </span>
  );
}
