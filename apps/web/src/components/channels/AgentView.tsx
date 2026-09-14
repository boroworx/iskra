import { cardOwnerSessions, needsYouItems } from "@iskra/client-runtime/cards";
import {
  MessageId,
  type AgentId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type ThreadId,
} from "@iskra/contracts";
import { AtSignIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import {
  useEnvironmentAgents,
  useEnvironmentCards,
  useEnvironmentChannels,
  useProjects,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { MessageComposer, PresenceBadge, useStickToNewest } from "./ChannelView";
import { dmTargets } from "./channels.logic";
import { RunBlock } from "./RunBlock";

/**
 * An agent's DM: a window onto its sessions, each labelled by the channel it
 * talks in or the card it works on, with its work and the context it started
 * from. The composer writes into one of the agent's live sessions, under that
 * session's delivery rules, and never starts one.
 */
export function AgentView(props: {
  readonly environmentId: EnvironmentId;
  readonly agentId: AgentId;
}) {
  const agents = useEnvironmentAgents(props.environmentId);
  const channels = useEnvironmentChannels(props.environmentId);
  const cards = useEnvironmentCards(props.environmentId);
  const projects = useProjects();
  const agent = agents.find((entry) => entry.id === props.agentId) ?? null;
  const project =
    agent === null
      ? null
      : (projects.find(
          (entry) => entry.environmentId === props.environmentId && entry.id === agent.projectId,
        ) ?? null);
  const runs = useEnvironmentQuery(
    channelEnvironment.agentRuns({
      environmentId: props.environmentId,
      input: { agentId: props.agentId },
    }),
  );
  const sendToSession = useAtomCommand(channelEnvironment.sessionMessage);

  // Sessions start and end as the agent's presence changes: refetch the list then.
  const refreshRuns = runs.refresh;
  const presence = agent?.presence;
  const seenPresence = useRef(presence);
  useEffect(() => {
    if (seenPresence.current !== presence) {
      seenPresence.current = presence;
      refreshRuns();
    }
  }, [presence, refreshRuns]);

  const sessions = useMemo(() => (runs.data?.runs ?? []).toReversed(), [runs.data]);
  const targets = useMemo(() => dmTargets(runs.data?.runs ?? [], channels), [runs.data, channels]);
  const [chosenThreadId, setChosenThreadId] = useState<ThreadId | null>(null);
  const target = targets.find((entry) => entry.threadId === chosenThreadId) ?? targets[0] ?? null;

  const scrollRef = useStickToNewest(sessions.at(-1)?.threadId);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          {agent === null ? null : (
            <div className="flex min-w-0 items-center gap-2">
              <AtSignIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
              <PresenceBadge presence={agent.presence} />
              <AgentStats agent={agent} cards={cards} />
            </div>
          )}
        </WorkspacePageHeader>
        {agent === null ? (
          agents.length > 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              This agent is archived or no longer exists.
            </p>
          ) : null
        ) : (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {runs.error !== null ? (
                <p className="text-sm text-destructive">{runs.error}</p>
              ) : null}
              {runs.data !== null && sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  @{agent.name} has no sessions yet. Mention it in a channel or assign it a card.
                </p>
              ) : null}
              <ol className="flex flex-col gap-5">
                {sessions.map((run) => (
                  <li key={run.threadId} className="min-w-0">
                    <RunBlock
                      run={run}
                      channels={channels}
                      cwd={project?.workspaceRoot}
                      environmentId={props.environmentId}
                    />
                  </li>
                ))}
              </ol>
            </div>
            {targets.length > 1 ? (
              <label className="flex shrink-0 items-center gap-2 px-5 pb-2 text-xs text-muted-foreground">
                Write to
                <select
                  className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={target?.threadId ?? ""}
                  onChange={(event) => setChosenThreadId(event.target.value as ThreadId)}
                >
                  {targets.map((entry) => (
                    <option key={entry.threadId} value={entry.threadId}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <MessageComposer
              key={props.agentId}
              disabled={target === null}
              placeholder={
                target === null
                  ? `@${agent.name} has no live session to write into`
                  : `Message @${agent.name} in ${target.label}`
              }
              onSend={async (body) => {
                if (target === null) {
                  return false;
                }
                const result = await sendToSession({
                  environmentId: props.environmentId,
                  input: {
                    threadId: target.threadId,
                    messageId: MessageId.make(randomUUID()),
                    body,
                  },
                });
                return result._tag === "Success";
              }}
            />
          </main>
        )}
      </div>
    </SidebarInset>
  );
}

/** What the agent has cost and done on its cards: spend, landings, returns, and what waits on a person. */
function AgentStats(props: {
  readonly agent: OrchestrationAgentShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
}) {
  const [now] = useState(() => Date.now());
  const own = props.cards.filter((card) => card.delegateAgentId === props.agent.id);
  const landed = own.filter((card) => card.status === "landed").length;
  const returns = own.reduce((total, card) => total + card.reviewReturns, 0);
  const waiting = needsYouItems({ cards: own, sessions: cardOwnerSessions(own), now }).length;
  return (
    <span className="hidden truncate text-xs tabular-nums text-muted-foreground sm:inline">
      ${(props.agent.spentUsd ?? 0).toFixed(2)} spent · {landed} landed · {returns} sent back ·{" "}
      {waiting} waiting on you
    </span>
  );
}
