import {
  MessageId,
  type ChannelId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationChannelMessage,
  type OrchestrationChannelShell,
} from "@t3tools/contracts";
import { AtSignIcon, HashIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentAgents, useEnvironmentChannels, useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  channelMemberEntries,
  channelMessageRows,
  deliveryNotes,
  dmTimelineEntries,
  presenceDotClassName,
  presenceLabel,
  type ChannelMemberEntry,
  type ChannelMessageRow,
  type DmTimelineEntry,
} from "./channels.logic";
import { RunBlock } from "./RunBlock";

/** One channel or DM: its messages, a composer, and who is in it. A DM also shows the agent's runs. */
export function ChannelView(props: {
  readonly environmentId: EnvironmentId;
  readonly channelId: ChannelId;
}) {
  const channels = useEnvironmentChannels(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const projects = useProjects();
  const channel = channels.find((entry) => entry.id === props.channelId) ?? null;
  const project =
    channel === null
      ? null
      : (projects.find(
          (entry) => entry.environmentId === props.environmentId && entry.id === channel.projectId,
        ) ?? null);
  const messages = useEnvironmentQuery(
    channelEnvironment.messages({
      environmentId: props.environmentId,
      input: { channelId: props.channelId },
    }),
  );
  const members = useMemo(
    () => (channel === null ? [] : channelMemberEntries(channel, agents)),
    [channel, agents],
  );
  const dmAgent = channel?.kind === "dm" ? (members[0] ?? null) : null;
  const title = dmAgent?.name ?? channel?.name ?? "";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <SidebarTrigger className="md:hidden" />
          {channel === null ? null : (
            <div className="flex min-w-0 items-center gap-2">
              {channel.kind === "dm" ? (
                <AtSignIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <HashIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <h1 className="truncate text-sm font-semibold">{title}</h1>
              {dmAgent !== null ? <PresenceBadge presence={dmAgent.presence} /> : null}
              {channel.topic.length > 0 ? (
                <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                  {channel.topic}
                </span>
              ) : null}
            </div>
          )}
        </WorkspacePageHeader>
        {channel === null ? (
          channels.length > 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              This channel is archived or no longer exists.
            </p>
          ) : null
        ) : (
          <div className="flex min-h-0 flex-1">
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {dmAgent !== null ? (
                <DmTimeline
                  agent={dmAgent}
                  messages={messages.data ?? EMPTY_MESSAGES}
                  error={messages.error}
                  agents={agents}
                  channels={channels}
                  cwd={project?.workspaceRoot}
                  environmentId={props.environmentId}
                />
              ) : (
                <ChannelTimeline
                  messages={messages.data ?? EMPTY_MESSAGES}
                  error={messages.error}
                  agents={agents}
                  channels={channels}
                  cwd={project?.workspaceRoot}
                  environmentId={props.environmentId}
                />
              )}
              <ChannelComposer
                key={props.channelId}
                environmentId={props.environmentId}
                channelId={props.channelId}
                placeholder={dmAgent !== null ? `Message @${title}` : `Message #${title}`}
              />
            </main>
            {channel.kind === "channel" ? <ChannelMemberList members={members} /> : null}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationChannelMessage> = [];

interface TimelineSource {
  readonly messages: ReadonlyArray<OrchestrationChannelMessage>;
  readonly error: string | null;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly channels: ReadonlyArray<OrchestrationChannelShell>;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
}

function ChannelTimeline(props: TimelineSource) {
  const entries = useMemo(
    () =>
      channelMessageRows(props.messages, props.agents).map((row): DmTimelineEntry => ({
        kind: "message",
        row,
      })),
    [props.messages, props.agents],
  );
  return <Timeline {...props} entries={entries} />;
}

/** A DM: its messages and the agent's runs, wherever they ran. */
function DmTimeline(props: TimelineSource & { readonly agent: ChannelMemberEntry }) {
  const runs = useEnvironmentQuery(
    channelEnvironment.agentRuns({
      environmentId: props.environmentId,
      input: { agentId: props.agent.id },
    }),
  );
  const { refresh } = runs;
  const presence = props.agent.presence;
  // A run starting or ending moves the agent between idle and running: refetch its runs then.
  useEffect(() => {
    if (presence !== "blocked") {
      refresh();
    }
  }, [presence, refresh]);

  const entries = useMemo(
    () => dmTimelineEntries(props.messages, runs.data?.runs ?? [], props.agents),
    [props.messages, runs.data, props.agents],
  );
  return <Timeline {...props} entries={entries} />;
}

const messageTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const Timeline = memo(function Timeline(
  props: TimelineSource & { readonly entries: ReadonlyArray<DmTimelineEntry> },
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const newest = props.entries.at(-1);
  const newestKey =
    newest === undefined
      ? undefined
      : newest.kind === "run"
        ? newest.run.threadId
        : newest.row.message.id;
  // Keep the newest entry in view as entries arrive.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && newestKey !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  }, [newestKey]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {props.error !== null ? <p className="text-sm text-destructive">{props.error}</p> : null}
      <ol className="flex flex-col">
        {props.entries.map((entry) =>
          entry.kind === "run" ? (
            <li key={entry.run.threadId} className="mt-4 first:mt-0">
              <RunBlock
                run={entry.run}
                channels={props.channels}
                cwd={props.cwd}
                environmentId={props.environmentId}
              />
            </li>
          ) : (
            <MessageRow
              key={entry.row.message.id}
              row={entry.row}
              agents={props.agents}
              cwd={props.cwd}
              environmentId={props.environmentId}
            />
          ),
        )}
      </ol>
    </div>
  );
});

function MessageRow(props: {
  readonly row: ChannelMessageRow;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const { message, authorName, showHeader } = props.row;
  const notes = message.authorKind === "human" ? deliveryNotes(message, props.agents) : [];
  return (
    <li className={cn("flex min-w-0 flex-col", showHeader ? "mt-4 first:mt-0" : "mt-1")}>
      {showHeader ? (
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-sm font-semibold",
              message.authorKind === "system" && "text-muted-foreground",
            )}
          >
            {authorName}
          </span>
          <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
            {messageTimeFormat.format(new Date(message.createdAt))}
          </time>
        </div>
      ) : null}
      {message.authorKind === "agent" ? (
        <ChatMarkdown text={message.body} cwd={props.cwd} environmentId={props.environmentId} />
      ) : (
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-sm",
            message.authorKind === "system" && "text-muted-foreground",
          )}
        >
          {message.body}
        </p>
      )}
      {notes.length > 0 ? (
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
          {notes.map((note) => (
            <span
              key={note.agentId}
              className={note.undelivered ? "text-destructive-foreground" : "text-muted-foreground"}
            >
              {note.text}
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}

function ChannelComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly channelId: ChannelId;
  readonly placeholder: string;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const postMessage = useAtomCommand(channelEnvironment.postMessage);

  const send = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    const result = await postMessage({
      environmentId: props.environmentId,
      input: { channelId: props.channelId, messageId: MessageId.make(randomUUID()), body: trimmed },
    });
    setSending(false);
    if (result._tag === "Success") {
      setBody("");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="shrink-0 px-5 pb-5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        rows={1}
        size="sm"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </form>
  );
}

const ChannelMemberList = memo(function ChannelMemberList(props: {
  readonly members: ReadonlyArray<ChannelMemberEntry>;
}) {
  return (
    <aside
      aria-label="Members"
      className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-l border-border px-3 py-4 lg:flex"
    >
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        Members {props.members.length}
      </h2>
      <ul role="list" className="flex flex-col gap-px">
        {props.members.map((member) => (
          <li key={member.id} className="flex h-8 min-w-0 items-center gap-2 px-2 text-sm">
            <span className="truncate">{member.name}</span>
            <PresenceBadge presence={member.presence} className="ml-auto" />
          </li>
        ))}
      </ul>
    </aside>
  );
});

/** Static presence dot and label: no continuously repainting animation. */
function PresenceBadge(props: {
  readonly presence: ChannelMemberEntry["presence"];
  readonly className?: string;
}) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", props.className)}>
      <span
        aria-hidden
        className={cn("size-2 rounded-full", presenceDotClassName(props.presence))}
      />
      <span className={cn("text-xs text-muted-foreground", props.presence === "idle" && "sr-only")}>
        {presenceLabel(props.presence)}
      </span>
    </span>
  );
}
