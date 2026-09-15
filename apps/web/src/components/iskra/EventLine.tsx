import type { SparkState } from "@iskra/client-runtime/card-face";
import type { ReactNode } from "react";

import { SparkGlyph } from "./SparkGlyph";

/**
 * A centered line for something that happened, such as Iskra's note that a card started. The
 * spark never wraps away from its text; keep a time and link in a `whitespace-nowrap` span so only
 * the sentence wraps.
 */
export function EventLine(props: { readonly spark?: SparkState; readonly children: ReactNode }) {
  return (
    <div className="flex flex-nowrap items-center justify-center gap-1.5 py-1 text-center text-xs text-muted-foreground">
      <SparkGlyph state={props.spark ?? "idle"} size={12} className="shrink-0" />
      <span className="min-w-0 break-words">{props.children}</span>
    </div>
  );
}
