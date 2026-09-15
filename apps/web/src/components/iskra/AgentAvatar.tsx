import type { SparkState } from "@iskra/client-runtime/card-face";

import { cn } from "~/lib/utils";
import { SparkGlyph } from "./SparkGlyph";

// Identity hues only: none reuses the colors that mean work, a person, verified or failed.
const GRADIENTS = [
  "from-[#8e8cff] to-[#5e5ce6]",
  "from-[#70d7e0] to-[#30b0c7]",
  "from-[#da8fff] to-[#bf5af2]",
];

// A person is neutral gray, so no agent hue is mistaken for them.
const PERSON_GRADIENT = "from-[#a1a1a6] to-[#6e6e73]";

const SIZE_CLASS = {
  xs: "size-4 text-[9px]",
  sm: "size-5 text-[10px]",
  md: "size-6 text-[11px]",
  lg: "size-8 text-[13px]",
  xl: "size-10 text-[17px]",
};

// The badge sits on the surface behind the avatar (bg-card), cut out by its padding.
const BADGE = {
  xs: { className: "-right-1.5 -bottom-[5px] p-[1.5px]", size: 9 },
  sm: { className: "-right-[5px] -bottom-1 p-[1.5px]", size: 10 },
  md: { className: "-right-[5px] -bottom-1 p-[1.5px]", size: 10 },
  lg: { className: "-right-1 -bottom-[3px] p-0.5", size: 12 },
  xl: { className: "-right-1 -bottom-[3px] p-0.5", size: 13 },
};

/**
 * An agent as a round gradient initial, the same hue everywhere, with its spark as a badge.
 * `person` draws a person instead: gray, labelled by name without the @.
 */
export function AgentAvatar(props: {
  readonly name: string;
  readonly spark?: SparkState | undefined;
  readonly size?: keyof typeof SIZE_CLASS;
  readonly person?: boolean;
  readonly className?: string;
}) {
  const size = props.size ?? "sm";
  let hash = 0;
  for (const character of props.name) hash += character.charCodeAt(0);
  return (
    <span
      role="img"
      aria-label={props.person === true ? props.name : `@${props.name}`}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full bg-linear-to-b font-semibold uppercase text-white",
        SIZE_CLASS[size],
        props.person === true ? PERSON_GRADIENT : GRADIENTS[hash % GRADIENTS.length],
        props.className,
      )}
    >
      {props.name.charAt(0)}
      {props.spark !== undefined ? (
        <span className={cn("absolute flex rounded-full bg-card", BADGE[size].className)}>
          <SparkGlyph state={props.spark} size={BADGE[size].size} />
        </span>
      ) : null}
    </span>
  );
}
