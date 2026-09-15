import { PlusIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { EmptyState } from "./iskra/Page";
import { SparkGlyph } from "./iskra/SparkGlyph";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} />
      <EmptyState
        icon={<SparkGlyph state="working" size={32} />}
        title="What should we work on?"
        body="Add a project, then give it agents and a channel."
        actions={
          <Button onClick={openAddProject}>
            <PlusIcon />
            Add project
          </Button>
        }
      />
    </SidebarInset>
  );
}
