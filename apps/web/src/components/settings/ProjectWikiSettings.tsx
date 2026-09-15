import { Link } from "@tanstack/react-router";

import type { Project } from "~/types";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The project's wiki lives in the sidebar; settings only points at it. */
export function ProjectWikiSettings(props: { readonly project: Project }) {
  return (
    <SettingsSection id="project-wiki" title="Wiki">
      <SettingsRow
        title="Project wiki"
        description="What agents wrote down about this project as they worked, and the briefs of cards touching a page's paths carry it. Agents write it freely; you watch the changes there, and can revert an edit or lock a page."
        control={
          <Button
            size="sm"
            variant="secondary"
            render={
              <Link
                to="/board/$environmentId/$projectId"
                params={{
                  environmentId: props.project.environmentId,
                  projectId: props.project.id,
                }}
                search={{ view: "wiki" as const }}
              />
            }
          >
            Open the wiki
          </Button>
        }
      />
    </SettingsSection>
  );
}
