import { resolveEnvironmentMachineKind } from "@iskra/contracts";
import { LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

export interface SettingsScopeBreadcrumbProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly onChange: (next: SettingsScopeSearch) => void;
}

/**
 * `Environment / Project`: the targets a change applies to, a quiet control in
 * the toolbar while the page's large title names the section. Each crumb reads
 * like the usage page's filter: muted at "all", foreground once narrowed. A
 * project is the same project on every environment, so the environment crumb
 * alone decides where a project override is written.
 */
export function SettingsBreadcrumb({
  scope,
}: {
  scope?: SettingsScopeBreadcrumbProps | undefined;
}) {
  // Pages whose rows are saved on this client have no scope to pick.
  if (!scope) {
    return (
      <WorkspaceBreadcrumb ariaLabel="Settings scope" className="[&_ol]:text-[13px]">
        <WorkspaceBreadcrumbItem className="font-normal">This device</WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    );
  }
  return (
    <WorkspaceBreadcrumb
      ariaLabel="Settings scope"
      className="[&_li]:font-normal [&_ol]:gap-1.5 [&_ol]:text-[13px] sm:[&_ol]:gap-2"
    >
      <WorkspaceBreadcrumbItem className="min-w-0 shrink">
        <EnvironmentScopeMenu {...scope} />
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <WorkspaceBreadcrumbItem className="min-w-0 shrink">
        <ProjectScopeMenu {...scope} />
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  narrowed,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  narrowed: boolean;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex min-w-0 max-w-56 cursor-pointer items-center gap-1.5 rounded-sm text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          narrowed ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        {children}
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
}: SettingsScopeBreadcrumbProps) {
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  return (
    <ScopeMenu
      ariaLabel="Environment scope"
      narrowed={environmentValue !== ALL_ENVIRONMENTS_VALUE}
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? "Unavailable environment"
            : "All environments"
      }
    >
      <MenuRadioGroup
        value={environmentValue}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectEnvironmentAxis(value, next));
        }}
      >
        <MenuRadioItem value={ALL_ENVIRONMENTS_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <LayersIcon aria-hidden className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">All environments</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
        <MenuSeparator />
        {environments.map((environment) => (
          <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                className="size-3.5"
              />
              <span className="min-w-0 flex-1 truncate">
                {settingsScopeEnvironmentLabel(environment, environments)}
              </span>
              {environment.connection.phase === "connected" ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
              )}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </ScopeMenu>
  );
}

function ProjectScopeMenu({ value, groups, onChange }: SettingsScopeBreadcrumbProps) {
  const selected = groups.find((group) => group.projectKey === value.project);
  return (
    <ScopeMenu
      ariaLabel="Project scope"
      narrowed={value.project !== undefined}
      icon={
        selected ? (
          // Automatic project glyphs carry a hue; chrome keeps them neutral.
          <span className="inline-flex shrink-0 [&_*]:text-muted-foreground!">
            <ProjectFavicon project={selected} className="size-3.5 shrink-0" />
          </span>
        ) : null
      }
      label={selected?.displayName ?? (value.project ? "Unavailable project" : "All projects")}
    >
      <MenuRadioGroup
        value={projectAxisValue(value)}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(selectProjectAxis(value, next));
        }}
      >
        <MenuRadioItem value={ALL_PROJECTS_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">All projects</span>
            <MenuRadioItemIndicator />
          </span>
        </MenuRadioItem>
        <MenuSeparator />
        {groups.map((group) => (
          <MenuRadioItem key={group.projectKey} value={group.projectKey}>
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={group} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </ScopeMenu>
  );
}
