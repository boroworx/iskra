import { Button } from "../ui/button";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { ChevronRightIcon, InfoIcon } from "lucide-react";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments } from "../../state/environments";
import type { SettingsScopeSearch } from "./settingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@iskra/contracts";

/** Offer an explicit target change when a category has no settings at this scope. */
export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "all" | "project" | "checkout";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const groups = useSettingsProjectGroups();
  const choices: { label: string; search: SettingsScopeSearch }[] =
    target === "checkout"
      ? groups
          .filter((group) => !search.project || group.projectKey === search.project)
          .flatMap((group) =>
            group.memberProjects.map((member) => ({
              label: `${group.displayName} · ${member.environmentLabel ?? "Environment"} · ${member.workspaceRoot}`,
              search: {
                project: group.projectKey,
                machine: member.environmentId,
                checkout: member.physicalProjectKey,
              },
            })),
          )
      : target === "project"
        ? groups.map((group) => ({
            label: group.displayName,
            search: { project: group.projectKey },
          }))
        : target === "environment"
          ? environments
              .filter(
                (entry) =>
                  eligibleEnvironmentIds === undefined ||
                  eligibleEnvironmentIds.includes(entry.environmentId),
              )
              .map((entry) => ({
                label: environments.some(
                  (other) =>
                    other.environmentId !== entry.environmentId && other.label === entry.label,
                )
                  ? `${entry.label} · ${entry.displayUrl || entry.environmentId}`
                  : entry.label,
                search: { machine: entry.environmentId },
              }))
          : [{ label: "Open all environments", search: {} }];
  const choose = (choice: (typeof choices)[number]) => {
    if (targetId) void navigate({ to: pathname, search: () => choice.search, hash: targetId });
    else selectScope(choice.search);
  };
  // Choosing a project is the way into the Projects page, so it reads as a list, not a warning.
  if (target === "project" && choices.length > 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection
          title="Choose a project"
          headerAction={
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <Button size="icon-sm" variant="ghost-muted" aria-label="About projects">
                    <InfoIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top" className="max-w-72">
                {children}
              </TooltipPopup>
            </Tooltip>
          }
        >
          {groups.map((group) => (
            <button
              key={group.projectKey}
              type="button"
              className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-[13px] outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() =>
                choose({ label: group.displayName, search: { project: group.projectKey } })
              }
            >
              <ProjectFavicon project={group} className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60"
              />
            </button>
          ))}
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <Alert role="status">
        <AlertDescription>
          <p>{children}</p>
          <AlertAction className="flex-wrap gap-2">
            {choices.map((choice) => (
              <Button
                key={JSON.stringify(choice.search)}
                size="sm-multiline"
                variant="outline"
                className="max-w-full break-all text-left"
                onClick={() => choose(choice)}
              >
                {choice.label}
              </Button>
            ))}
          </AlertAction>
        </AlertDescription>
      </Alert>
    </SettingsPageContainer>
  );
}
