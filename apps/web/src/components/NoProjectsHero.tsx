import { PlusIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { SparkGlyph } from "./iskra/SparkGlyph";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

export function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="flex w-full max-w-md flex-col items-center px-8 py-12">
            <SparkGlyph state="working" size={32} className="mb-5" />
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-[28px] font-bold tracking-[-0.02em] text-foreground">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-[15px] text-muted-foreground">
                Add a project, then give it agents and a channel to talk to them in.
              </EmptyDescription>
            </EmptyHeader>
            <Button size="sm" className="mt-6 text-[13px]" onClick={openAddProject}>
              <PlusIcon className="size-3" />
              Add Project
            </Button>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
