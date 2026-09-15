import { cardOwnerSessions, needsYouItems } from "@iskra/client-runtime/cards";
import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import {
  MessageId,
  type AgentId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationChannelMessage,
  type ThreadId,
} from "@iskra/contracts";
import { AtSignIcon, SettingsIcon } from "lucide-react";
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
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  AgentSettingsDialog,
  useAgentDefinitions,
  useSaveAgentDefinition,
} from "./AgentSettingsDialog";
import { MessageComposer, PresenceBadge, Timeline, useStickToNewest } from "./ChannelView";
import { agentDmChannel, dmTargets, liveInstances } from "./channels.logic";
import { RunBlock } from "./RunBlock";

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationChannelMessage> = [];
const sinceFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * An agent's page. Messages is its DM, a private read-only conversation opened by
 * the first direct message; Sessions lists every session it has run, labelled by
 * the channel it talks in or the card it works on. The composer writes into the
 * DM, or into one of the agent's live sessions under that session's delivery rules.
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
  // The DM channel arrives through the shell once the first direct message opens it.
  const dmChannel = useMemo(
    () => agentDmChannel(channels, props.agentId),
    [channels, props.agentId],
  );
  const dmMessages = useEnvironmentQuery(
    dmChannel === null
      ? null
      : channelEnvironment.messages({
          environmentId: props.environmentId,
          input: { channelId: dmChannel.id },
        }),
  );
  const sendToSession = useAtomCommand(channelEnvironment.sessionMessage);
  const postDm = useAtomCommand(channelEnvironment.dmPost);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<"messages" | "sessions">("messages");

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
  // Every wake is its own run, so an agent can be live in several places at once.
  const live = useMemo(() => liveInstances(runs.data?.runs ?? [], channels), [runs.data, channels]);
  const [chosenThreadId, setChosenThreadId] = useState<ThreadId | null>(null);
  const target = targets.find((entry) => entry.threadId === chosenThreadId) ?? targets[0];

  const scrollRef = useStickToNewest(view === "sessions" ? sessions.at(-1)?.threadId : undefined);
  const messages = dmMessages.data ?? EMPTY_MESSAGES;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          {agent === null ? null : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <AtSignIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
              <PresenceBadge presence={agent.presence} />
              <AgentStats
                agent={agent}
                cards={cards}
                projects={projects.filter(
                  (project) => project.environmentId === props.environmentId,
                )}
              />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant={view === "messages" ? "secondary" : "ghost-muted"}
                  aria-pressed={view === "messages"}
                  onClick={() => setView("messages")}
                >
                  Messages
                </Button>
                <Button
                  size="sm"
                  variant={view === "sessions" ? "secondary" : "ghost-muted"}
                  aria-pressed={view === "sessions"}
                  onClick={() => setView("sessions")}
                >
                  Sessions
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`@${agent.name} settings`}
                  onClick={() => setSettingsOpen(true)}
                >
                  <SettingsIcon />
                </Button>
              </div>
              <AgentSettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                environmentId={props.environmentId}
                projectId={agent.projectId}
                agentId={agent.id}
              />
            </div>
          )}
        </WorkspacePageHeader>
        {agent === null ? (
          agents.length > 0 ? (
            <div className="flex flex-col gap-3 px-5 py-4 text-sm text-muted-foreground">
              <p>This agent is archived or no longer exists.</p>
              {projects
                .filter((entry) => entry.environmentId === props.environmentId)
                .map((entry) => (
                  <ArchivedAgentUnarchive key={entry.id} project={entry} agentId={props.agentId} />
                ))}
            </div>
          ) : null
        ) : (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {live.length > 0 ? (
              <section
                aria-label="Live now"
                className="flex max-h-32 shrink-0 flex-col gap-0.5 overflow-y-auto border-b border-border px-5 py-2"
              >
                <h2 className="text-xs font-medium text-muted-foreground">
                  Live now <span className="tabular-nums">{live.length}</span>
                </h2>
                <ul className="flex flex-col">
                  {live.map((instance) => (
                    <li key={instance.threadId} className="flex min-w-0 items-baseline gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        {instance.doing} <span className="text-muted-foreground">{instance.where}</span>
                      </span>
                      <time
                        dateTime={instance.since}
                        className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground"
                      >
                        since {sinceFormat.format(new Date(instance.since))}
                      </time>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {view === "messages" ? (
              dmChannel !== null && (messages.length > 0 || dmMessages.error !== null) ? (
                <Timeline
                  messages={messages}
                  error={dmMessages.error}
                  agents={agents}
                  channels={channels}
                  cwd={project?.workspaceRoot}
                  environmentId={props.environmentId}
                />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  <p className="text-sm text-muted-foreground">
                    Message @{agent.name}. It can read the project but not change it; changes need
                    a card.
                  </p>
                </div>
              )
            ) : (
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {runs.error !== null ? (
                  <p className="text-sm text-destructive">{runs.error}</p>
                ) : null}
                {runs.data !== null && sessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    @{agent.name} has no sessions yet. Message it, mention it in a channel or assign
                    it a card.
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
            )}
            {targets.length > 1 ? (
              <label className="flex shrink-0 items-center gap-2 px-5 pb-2 text-xs text-muted-foreground">
                Write to
                <select
                  className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={target?.threadId ?? ""}
                  onChange={(event) =>
                    setChosenThreadId(
                      event.target.value === "" ? null : (event.target.value as ThreadId),
                    )
                  }
                >
                  {targets.map((entry) => (
                    <option key={entry.threadId ?? ""} value={entry.threadId ?? ""}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <MessageComposer
              key={props.agentId}
              placeholder={
                target === undefined || target.threadId === null
                  ? `Message @${agent.name}`
                  : `Message @${agent.name} in ${target.label}`
              }
              onSend={async (body) => {
                const messageId = MessageId.make(randomUUID());
                if (target === undefined || target.threadId === null) {
                  const result = await postDm({
                    environmentId: props.environmentId,
                    input: { agentId: props.agentId, messageId, body },
                  });
                  if (result._tag === "Success") {
                    setView("messages");
                  }
                  return result._tag === "Success";
                }
                const result = await sendToSession({
                  environmentId: props.environmentId,
                  input: { threadId: target.threadId, messageId, body },
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

/** Unarchive for an agent archived in this project; nothing when it is not one of the project's. */
function ArchivedAgentUnarchive(props: {
  readonly project: EnvironmentProject;
  readonly agentId: AgentId;
}) {
  const definitions = useAgentDefinitions(props.project.environmentId, props.project.id);
  const saveDefinition = useSaveAgentDefinition(props.project.environmentId, props.project.id);
  const [busy, setBusy] = useState(false);
  const entry = definitions.data?.agents.find(
    (agent) => agent.archived && agent.definition.id === props.agentId,
  );
  if (entry === undefined) {
    return null;
  }
  return (
    <Button
      className="self-start"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await saveDefinition(entry.definition, "Agent not unarchived");
        setBusy(false);
      }}
    >
      Unarchive @{entry.definition.name}
    </Button>
  );
}

/** What the agent has cost and done on its cards: spend, landings, returns, and what waits on a person. */
function AgentStats(props: {
  readonly agent: OrchestrationAgentShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  /** The environment's projects, so an unacknowledged side-effect guard counts as waiting. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const [now] = useState(() => Date.now());
  const own = props.cards.filter((card) => card.delegateAgentId === props.agent.id);
  const landed = own.filter((card) => card.status === "landed").length;
  const returns = own.reduce((total, card) => total + card.reviewReturns, 0);
  const waiting = needsYouItems({
    cards: own,
    sessions: cardOwnerSessions(own),
    projects: props.projects,
    now,
  }).length;
  return (
    <span className="hidden truncate text-xs tabular-nums text-muted-foreground sm:inline">
      ${(props.agent.spentUsd ?? 0).toFixed(2)} spent · {landed} landed · {returns} sent back ·{" "}
      {waiting} waiting on you
    </span>
  );
}
