import { cardOwnerSessions, needsYouItems } from "@iskra/client-runtime/cards";
import { metricsLine, templateMetrics } from "@iskra/client-runtime/metrics";
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
import { InfoIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import {
  useEnvironmentAgents,
  useEnvironmentCards,
  useEnvironmentChannels,
  useProjects,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { EmptyState, PageColumn } from "../iskra/Page";
import { SparkGlyph } from "../iskra/SparkGlyph";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  AgentSettingsDialog,
  useAgentDefinitions,
  useSaveAgentDefinition,
} from "./AgentSettingsDialog";
import { MessageComposer, Timeline, useStickToNewest } from "./ChannelView";
import { agentDmChannel, dmTargets, liveInstances, presenceSpark } from "./channels.logic";
import { RunBlock } from "./RunBlock";

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationChannelMessage> = [];
/** The "Write to" picker's value for the DM, which has no session thread. */
const DM_TARGET = "dm";
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
              <AgentAvatar
                name={agent.name}
                size="md"
                spark={agent.presence === "idle" ? undefined : presenceSpark(agent.presence)}
              />
              <h1 className="truncate text-[15px] font-semibold">{agent.name}</h1>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <div
                  role="group"
                  aria-label="View"
                  className="mr-1 flex h-7 items-center rounded-lg bg-secondary p-0.5"
                >
                  {(["messages", "sessions"] as const).map((entry) => (
                    <button
                      key={entry}
                      type="button"
                      aria-pressed={view === entry}
                      onClick={() => setView(entry)}
                      className={cn(
                        "h-6 rounded-md px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        view === entry
                          ? "bg-card text-foreground shadow-[0_0_0_0.5px_rgb(0_0_0/6%),0_1px_2px_rgb(0_0_0/12%)] dark:bg-[rgb(120_120_128/36%)]"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {entry === "messages" ? "Messages" : "Sessions"}
                    </button>
                  ))}
                </div>
                <AgentStats
                  agent={agent}
                  cards={cards}
                  projects={projects.filter(
                    (project) => project.environmentId === props.environmentId,
                  )}
                />
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
                className="max-h-32 shrink-0 overflow-y-auto py-2.5 shadow-[inset_0_-0.5px_var(--border)]"
              >
                <PageColumn>
                  <h2 className="pb-1 text-[13px] font-semibold text-muted-foreground">
                    Live now <span className="tabular-nums">{live.length}</span>
                  </h2>
                  <ul className="flex flex-col">
                    {live.map((instance) => (
                      <li
                        key={instance.threadId}
                        className="flex h-7 min-w-0 items-center gap-2 text-[13px]"
                      >
                        <SparkGlyph state="working" size={12} />
                        <span className="min-w-0 truncate">
                          {instance.doing}{" "}
                          <span className="text-muted-foreground">{instance.where}</span>
                        </span>
                        <time
                          dateTime={instance.since}
                          className="ms-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/55"
                        >
                          since {sinceFormat.format(new Date(instance.since))}
                        </time>
                      </li>
                    ))}
                  </ul>
                </PageColumn>
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
                <EmptyState
                  icon={<AgentAvatar name={agent.name} size="lg" />}
                  title={`Message @${agent.name}`}
                  body="It can read the project but not change it; changes need a card."
                />
              )
            ) : runs.error === null && runs.data !== null && sessions.length === 0 ? (
              <EmptyState
                title="No sessions yet"
                body={`Message @${agent.name}, mention it in a channel or assign it a card.`}
              />
            ) : (
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pt-7 pb-4">
                <PageColumn>
                  {runs.error !== null ? (
                    <p className="text-sm text-destructive">{runs.error}</p>
                  ) : null}
                  <ol className="flex flex-col gap-2.5">
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
                </PageColumn>
              </div>
            )}
            {targets.length > 1 ? (
              <PageColumn className="-mb-2 flex shrink-0 items-center gap-2 pt-2 text-[13px] text-muted-foreground">
                <span aria-hidden>Write to</span>
                <Select
                  value={target?.threadId ?? DM_TARGET}
                  onValueChange={(value) =>
                    setChosenThreadId(
                      value === null || value === DM_TARGET ? null : (value as ThreadId),
                    )
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Write to"
                    className="w-auto max-w-72 min-w-0"
                  >
                    <SelectValue>
                      {(value: string | null) =>
                        targets.find((entry) => (entry.threadId ?? DM_TARGET) === value)?.label ??
                        ""
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {targets.map((entry) => (
                      <SelectItem
                        key={entry.threadId ?? DM_TARGET}
                        value={entry.threadId ?? DM_TARGET}
                      >
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </PageColumn>
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
  // The same record the pre-start preview shows as a routing hint, over the last 30 days.
  const recent = templateMetrics(own, now).get(props.agent.id);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`@${props.agent.name} record`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <InfoIcon aria-hidden className="size-4" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-72 tabular-nums">
        ${(props.agent.spentUsd ?? 0).toFixed(2)} spent · {landed} landed · {returns} sent back ·{" "}
        {waiting} waiting on you
        {recent === undefined
          ? ""
          : ` · last 30 days: ${metricsLine(props.agent.name, recent).replace(`@${props.agent.name}: `, "")}`}
      </TooltipPopup>
    </Tooltip>
  );
}
