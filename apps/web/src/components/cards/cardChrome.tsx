import { ChevronRightIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

// The card screens' grouped-list language: titled inset groups on #2c2c2e, 46px rows with inset
// hairlines, round verdict glyphs, and 28px buttons. Local to cards until it earns a ui primitive.

const ACTION_TONE = {
  primary: "",
  plain: "",
  tinted:
    "border-transparent bg-primary/18 text-info-foreground [:hover,[data-pressed]]:bg-primary/26",
  destructive:
    "bg-secondary text-destructive-foreground [:hover,[data-pressed]]:bg-destructive/16",
} as const;

/** A 28px action: blue filled primary, gray plain, blue tinted for a recommended answer. */
export function ActionButton({
  tone = "plain",
  className,
  ...props
}: ComponentProps<typeof Button> & { readonly tone?: keyof typeof ACTION_TONE }) {
  return (
    <Button
      size="sm"
      variant={tone === "primary" ? "default" : "secondary"}
      className={cn(
        "h-7 rounded-[7px] px-3.5 text-[13px] font-medium sm:h-7 sm:text-[13px]",
        ACTION_TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

/** A titled group of rows: 13px secondary title, then the rows on one rounded surface. */
export function Section(props: {
  readonly label: string;
  readonly trailing?: ReactNode;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={props.id} aria-label={props.label} className="flex flex-col gap-2">
      <div className="flex min-h-5 items-center gap-2 px-1">
        <h3 className="text-[13px] font-semibold text-muted-foreground">{props.label}</h3>
        {props.trailing !== undefined ? (
          <div className="ms-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground/55">
            {props.trailing}
          </div>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

export const GROUP_CLASS =
  "flex flex-col overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)]";

/** One inset surface; its rows draw their own hairlines. */
export function Group(props: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn(GROUP_CLASS, props.className)}>{props.children}</div>;
}

/** A row's hairline starts past its 18px glyph, as grouped lists inset them. */
export const ROW_CLASS =
  "relative flex min-h-[46px] min-w-0 items-center gap-3 px-3.5 text-[13px] before:absolute before:top-0 before:right-0 before:left-11 before:border-t-[0.5px] before:border-border before:content-[''] first:before:hidden";

export function Row(props: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn(ROW_CLASS, props.className)}>{props.children}</div>;
}

/** Pushes what follows to the row's trailing edge. */
export function Trail(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <span className={cn("ms-auto flex shrink-0 items-center gap-2.5", props.className)}>
      {props.children}
    </span>
  );
}

/**
 * A row that opens to show its detail below, with a chevron that turns. The detail mounts only
 * while open.
 */
export function DisclosureRow(props: {
  readonly leading?: ReactNode;
  readonly label: ReactNode;
  readonly trailing?: ReactNode;
  readonly children?: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const expandable = props.children !== undefined && props.children !== null;
  const head = (
    <>
      {props.leading}
      <span className="min-w-0 flex-1 py-3 text-start">{props.label}</span>
      <Trail>
        {props.trailing}
        {expandable ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 text-muted-foreground/55 transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        ) : null}
      </Trail>
    </>
  );
  return (
    <div className={cn(ROW_CLASS, "flex-col items-stretch gap-0")}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-[46px] w-full cursor-pointer items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
        >
          {head}
        </button>
      ) : (
        <div className="flex min-h-[46px] w-full items-center gap-3">{head}</div>
      )}
      {expandable && open ? (
        <div className="flex min-w-0 flex-col gap-2 pb-3 ps-[30px] text-xs">{props.children}</div>
      ) : null}
    </div>
  );
}

export type VerdictGlyphState = "passed" | "failed" | "pending" | "neutral";

/** Filled green check, red cross, an orange ring for waiting on a person or CI, gray for neither. */
export function VerdictGlyph(props: {
  readonly state: VerdictGlyphState;
  readonly size?: number;
  readonly label?: string;
}) {
  const size = props.size ?? 18;
  const a11y =
    props.label === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": props.label } as const);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0" {...a11y}>
      {props.state === "passed" ? (
        <>
          <circle cx="12" cy="12" r="10" className="fill-success" />
          <path
            d="M7.5 12.5l3 3 6-6.5"
            fill="none"
            stroke="white"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : props.state === "failed" ? (
        <>
          <circle cx="12" cy="12" r="10" className="fill-destructive" />
          <path
            d="M8.5 8.5l7 7M15.5 8.5l-7 7"
            fill="none"
            stroke="white"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            strokeWidth="2"
            className={props.state === "pending" ? "stroke-warning" : "stroke-muted-foreground/45"}
          />
          <circle
            cx="12"
            cy="12"
            r="3"
            className={props.state === "pending" ? "fill-warning" : "fill-muted-foreground/45"}
          />
        </>
      )}
    </svg>
  );
}

const CLAIM_SEGMENTS = { low: 1, medium: 2, high: 3 } as const;
const CLAIM_COLOR = { low: "bg-success", medium: "bg-warning", high: "bg-destructive" } as const;

/** A claimed risk as three segments: one green for low, two orange for medium, three red for high. */
export function ClaimMarks(props: {
  readonly label: string;
  readonly level: keyof typeof CLAIM_SEGMENTS;
}) {
  return (
    <span role="img" aria-label={`${props.label} ${props.level}`} className="flex gap-[3px]">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "h-1 w-3.5 rounded-full",
            index < CLAIM_SEGMENTS[props.level]
              ? CLAIM_COLOR[props.level]
              : "bg-muted-foreground/30",
          )}
        />
      ))}
    </span>
  );
}

/** The canvas's branch mark, for a card's branch in the review footer. */
export function BranchGlyph(props: { readonly className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className={props.className}>
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="8" r="2" />
        <path d="M6 7v10M18 10c0 4-4 5-10 7" />
      </g>
    </svg>
  );
}

/** A blue text action at a row's trailing edge, such as Acknowledge. */
export function RowLink(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center rounded-sm px-1 text-[13px] font-medium text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
        props.className,
      )}
    />
  );
}
