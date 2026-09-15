import type { SparkState } from "@iskra/client-runtime/card-face";
import { useState } from "react";

import { cn } from "~/lib/utils";

const SPARK = "M12 2.5l2.1 7.4 7.4 2.1-7.4 2.1-2.1 7.4-2.1-7.4-7.4-2.1 7.4-2.1z";
const SPARK_INSET = "M12 5l1.5 5.5 5.5 1.5-5.5 1.5-1.5 5.5-1.5-5.5-5.5-1.5 5.5-1.5z";

const STATE_LABEL: Record<SparkState, string> = {
  idle: "Idle",
  working: "Working",
  needsYou: "Needs you",
  landed: "Landed",
};

const STATE_CLASS: Record<SparkState, string> = {
  idle: "text-muted-foreground",
  working: "text-primary",
  needsYou: "text-warning",
  landed: "text-success",
};

/**
 * Iskra's spark: an outline at rest, filled blue while working, orange when a person is needed,
 * and green in a disc once landed. It flashes once when it turns landed while shown; it never loops.
 */
export function SparkGlyph(props: {
  readonly state: SparkState;
  readonly size?: number;
  readonly className?: string;
}) {
  const { state } = props;
  const size = props.size ?? 16;
  // The state last rendered: a change to landed while shown flashes once; mounting landed doesn't.
  const [shown, setShown] = useState(state);
  const [justLanded, setJustLanded] = useState(false);
  if (shown !== state) {
    setShown(state);
    setJustLanded(state === "landed");
  }
  return (
    <svg
      role="img"
      aria-label={STATE_LABEL[state]}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(
        "shrink-0 origin-center [transform-box:fill-box]",
        STATE_CLASS[state],
        justLanded && "animate-spark-land motion-reduce:animate-none",
        props.className,
      )}
    >
      {state === "landed" ? (
        <>
          <circle cx="12" cy="12" r="11" fill="currentColor" fillOpacity={0.18} />
          <path
            d={SPARK_INSET}
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={1}
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d={SPARK}
          fill={state === "idle" ? "none" : "currentColor"}
          stroke="currentColor"
          strokeWidth={state === "idle" ? 1.3 : 1.2}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
