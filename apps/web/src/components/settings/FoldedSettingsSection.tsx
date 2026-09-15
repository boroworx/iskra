import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  SETTINGS_GROUP_CLASSNAME,
  SETTINGS_GROUP_ROWS_CLASSNAME,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "./settingsLayout";

/**
 * A grouped settings section that starts closed. The header carries the title,
 * a one line summary of what is set inside, and an optional control such as
 * the section's own switch. A settings search that targets the section opens it.
 */
export function FoldedSettingsSection({
  id,
  title,
  summary,
  control,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly control?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  // A search jump lands inside the fold, so open it before the scroll runs.
  const [openedForTarget, setOpenedForTarget] = useState<string | null>(null);
  if (searchTargetId === id && openedForTarget !== id) {
    setOpenedForTarget(id);
    if (!open) setOpen(true);
  }

  return (
    <section id={id} ref={targetRef} tabIndex={-1} className="outline-none">
      <Collapsible open={open} onOpenChange={setOpen} className={SETTINGS_GROUP_CLASSNAME}>
        <div className="flex items-center gap-4 px-4">
          <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="shrink-0 text-[13px]">{title}</span>
            {summary ? (
              <span className="ms-auto min-w-0 truncate text-[13px] text-muted-foreground">
                {summary}
              </span>
            ) : null}
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150 motion-reduce:transition-none",
                !summary && "ms-auto",
                open && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          {control ? <div className="flex shrink-0 items-center">{control}</div> : null}
        </div>
        <CollapsiblePanel>
          <div className={SETTINGS_GROUP_ROWS_CLASSNAME}>{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
