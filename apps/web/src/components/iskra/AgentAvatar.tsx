import type { SparkState } from "@iskra/client-runtime/card-face";

import { cn } from "~/lib/utils";
import { SparkGlyph } from "./SparkGlyph";

// Identity hues only: none reuses the colors that mean work, a person, verified or failed.
const GRADIENTS = [
  "from-[#8e8cff] to-[#5e5ce6]",
  "from-[#70d7e0] to-[#30b0c7]",
  "from-[#da8fff] to-[#bf5af2]",
];

const SIZE_CLASS = {
  sm: "size-5 text-[10px]",
  md: "size-6 text-[11px]",
  lg: "size-8 text-[13px]",
};

/** An agent as a round gradient initial, the same hue everywhere, with its spark as a badge. */
export function AgentAvatar(props: {
  readonly name: string;
  readonly spark?: SparkState | undefined;
  readonly size?: keyof typeof SIZE_CLASS;
  readonly className?: string;
}) {
  const size = props.size ?? "sm";
  let hash = 0;
  for (const character of props.name) hash += character.charCodeAt(0);
  return (
    <span
      role="img"
      aria-label={`@${props.name}`}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full bg-linear-to-b font-semibold uppercase text-white",
        SIZE_CLASS[size],
        GRADIENTS[hash % GRADIENTS.length],
        props.className,
      )}
    >
      {props.name.charAt(0)}
      {props.spark !== undefined ? (
        <span className="absolute -right-1.5 -bottom-1 flex rounded-full bg-card p-px">
          <SparkGlyph state={props.spark} size={size === "lg" ? 12 : 9} />
        </span>
      ) : null}
    </span>
  );
}
