import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentAgents, useEnvironmentChannels } from "~/state/entities";
import {
  presenceDotClassName,
  presenceLabel,
  sidebarAgentEntries,
  sidebarChannelEntries,
} from "./SidebarAgentChannels.logic";

/**
 * A project's channels and agents, with each agent's presence. Each project
 * reads the shell itself, so agent updates never re-render the sidebar root.
 * Renders nothing for projects without agents or channels.
 */
export const SidebarAgentChannels = memo(function SidebarAgentChannels(props: {
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}) {
  return props.projectRefs.map((ref) => (
    <ProjectAgentChannels
      key={`${ref.environmentId}:${ref.projectId}`}
      environmentId={ref.environmentId}
      projectId={ref.projectId}
    />
  ));
});

const ProjectAgentChannels = memo(function ProjectAgentChannels(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const channels = useEnvironmentChannels(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const channelEntries = useMemo(
    () => sidebarChannelEntries(channels, agents, props.projectId),
    [channels, agents, props.projectId],
  );
  const agentEntries = useMemo(
    () => sidebarAgentEntries(agents, props.projectId),
    [agents, props.projectId],
  );

  if (channelEntries.length === 0 && agentEntries.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1 text-xs" data-testid="sidebar-agent-channels">
      {channelEntries.length > 0 ? (
        <section aria-label="Channels" className="flex flex-col gap-px">
          <h3 className="px-2 pt-1 font-medium text-sidebar-muted-foreground/60">Channels</h3>
          <ul role="list" className="flex flex-col gap-px">
            {channelEntries.map((entry) => (
              <li
                key={entry.key}
                className="flex h-7 items-center rounded-md px-2 text-sidebar-muted-foreground"
              >
                <span className="truncate">{entry.label}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {agentEntries.length > 0 ? (
        <section aria-label="Agents" className="flex flex-col gap-px">
          <h3 className="px-2 pt-1 font-medium text-sidebar-muted-foreground/60">Agents</h3>
          <ul role="list" className="flex flex-col gap-px">
            {agentEntries.map((entry) => (
              <li
                key={entry.key}
                className="flex h-7 items-center gap-2 rounded-md px-2 text-sidebar-muted-foreground"
              >
                {/* Static dot: the sidebar never runs a continuously repainting animation. */}
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    presenceDotClassName(entry.presence),
                  )}
                />
                <span className="truncate">@{entry.name}</span>
                <span
                  className={cn(
                    "ml-auto shrink-0 text-sidebar-muted-foreground/60",
                    entry.presence === "idle" && "sr-only",
                  )}
                >
                  {presenceLabel(entry.presence)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
});
