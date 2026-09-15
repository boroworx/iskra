import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** A titled inset group of rows in a sheet, as in Apple's grouped lists: rows split by hairlines. */
export function SheetGroup(props: {
  readonly title?: string;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-1.5", props.className)}>
      {props.title === undefined ? null : (
        <h3 className="px-4 text-[13px] font-semibold text-muted-foreground">{props.title}</h3>
      )}
      <div className="flex flex-col overflow-hidden rounded-[10px] bg-muted [&>*+*]:shadow-[inset_0_0.5px_var(--border)]">
        {props.children}
      </div>
      {props.footer === undefined ? null : (
        <div className="px-4 text-xs text-muted-foreground">{props.footer}</div>
      )}
    </section>
  );
}

/**
 * One row of a group: its label (and an optional hint under it) on the left, its control on the
 * right. Render it `as="label"` when the control is a single input, so the whole row focuses it.
 */
export function SheetRow(props: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly as?: "label" | "div";
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const Row = props.as ?? "div";
  return (
    <Row
      className={cn(
        "flex min-h-11 items-center gap-3 px-4 py-1.5 text-[13px] focus-within:bg-accent/40",
        props.className,
      )}
    >
      <span className="flex min-w-0 shrink-0 flex-col">
        <span>{props.label}</span>
        {props.hint === undefined ? null : (
          <span className="text-xs text-muted-foreground">{props.hint}</span>
        )}
      </span>
      {props.children === undefined ? null : (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-2">{props.children}</span>
      )}
    </Row>
  );
}

/** The class for an unstyled input that sits inside a row, right-aligned like a value. */
export const SHEET_INPUT_CLASS = "min-w-0 flex-1 text-[13px] [&_input]:text-right";

/** The class for an unstyled textarea that fills a group on its own. */
export const SHEET_TEXTAREA_CLASS =
  "block w-full text-[13px] [&_textarea]:min-h-12 [&_textarea]:resize-none [&_textarea]:px-0 [&_textarea]:py-0.5";
