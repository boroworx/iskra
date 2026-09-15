import type { SparkState } from "@iskra/client-runtime/card-face";
import type { ReactNode } from "react";

import { SparkGlyph } from "./SparkGlyph";

/** A centered line for something that happened, such as Iskra's note that a card started. */
export function EventLine(props: { readonly spark?: SparkState; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 py-1 text-center text-xs text-muted-foreground/75">
      <SparkGlyph state={props.spark ?? "idle"} size={12} />
      {props.children}
    </div>
  );
}
