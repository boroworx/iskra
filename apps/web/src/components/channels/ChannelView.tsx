import {
  AgentId,
  MessageId,
  type ThreadId,
  type ChannelId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationChannelMessage,
  type OrchestrationChannelShell,
} from "@iskra/contracts";
import { HashIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentAgents, useEnvironmentChannels, useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { ComposerSurface } from "../chat/ComposerSurface";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  channelMemberEntries,
  channelMessageRows,
  deliveryNotes,
  presenceDotClassName,
  presenceLabel,
  type AgentEntry,
  type ChannelMessageRow,
} from "./channels.logic";
import { RunBlock } from "./RunBlock";

/** One channel: its messages, a composer, and who is in it. */
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
  const title = channel?.name ?? "";
  const postMessage = useAtomCommand(channelEnvironment.postMessage);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          {channel === null ? null : (
            <div className="flex min-w-0 items-center gap-2">
              <HashIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-sm font-semibold">{title}</h1>
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
              <Timeline
                messages={messages.data ?? EMPTY_MESSAGES}
                error={messages.error}
                agents={agents}
                channels={channels}
                cwd={project?.workspaceRoot}
                environmentId={props.environmentId}
              />
              <MessageComposer
                key={props.channelId}
                placeholder={`Message #${title}`}
                onSend={async (body) => {
                  const result = await postMessage({
                    environmentId: props.environmentId,
                    input: {
                      channelId: props.channelId,
                      messageId: MessageId.make(randomUUID()),
                      body,
                    },
                  });
                  return result._tag === "Success";
                }}
              />
            </main>
            {channel.kind === "channel" ? (
              <ChannelMemberList
                members={members}
                channel={channel}
                agents={agents}
                environmentId={props.environmentId}
              />
            ) : null}
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
  /** Agent id to the `#channel` it is busy in, for queued DM deliveries. */
  readonly busyChannels?: ReadonlyMap<string, string> | undefined;
}

/** A scroll container's ref that jumps to the bottom whenever the newest item changes. */
export function useStickToNewest(newestId: string | undefined) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && newestId !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  }, [newestId]);
  return scrollRef;
}

const messageTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** A channel's or DM's messages, oldest first, kept scrolled to the newest. */
export const Timeline = memo(function Timeline(props: TimelineSource) {
  const rows = useMemo(
    () => channelMessageRows(props.messages, props.agents),
    [props.messages, props.agents],
  );
  // Keep the newest message in view as messages arrive.
  const scrollRef = useStickToNewest(rows.at(-1)?.message.id);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {props.error !== null ? <p className="text-sm text-destructive">{props.error}</p> : null}
      <ol className="flex flex-col">
        {rows.map((row) => (
          <MessageRow
            key={row.message.id}
            row={row}
            agents={props.agents}
            channels={props.channels}
            cwd={props.cwd}
            environmentId={props.environmentId}
            busyChannels={props.busyChannels}
          />
        ))}
      </ol>
    </div>
  );
});

function MessageRow(props: {
  readonly row: ChannelMessageRow;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly channels: ReadonlyArray<OrchestrationChannelShell>;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly busyChannels: ReadonlyMap<string, string> | undefined;
}) {
  const { message, authorName, showHeader } = props.row;
  const notes =
    message.authorKind === "human"
      ? deliveryNotes(message, props.agents, props.busyChannels)
      : [];
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
        <>
          <ChatMarkdown text={message.body} cwd={props.cwd} environmentId={props.environmentId} />
          {message.runThreadId !== undefined ? (
            <RunWork
              agentId={AgentId.make(message.authorId)}
              runThreadId={message.runThreadId}
              channels={props.channels}
              cwd={props.cwd}
              environmentId={props.environmentId}
            />
          ) : null}
        </>
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

interface RunWorkProps {
  readonly agentId: AgentId;
  readonly runThreadId: ThreadId;
  readonly channels: ReadonlyArray<OrchestrationChannelShell>;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
}

/** Under an agent's reply: the run behind it, its work and the context it was given. */
function RunWork(props: RunWorkProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      <Button
        className="-ml-2 self-start"
        size="sm"
        variant="ghost-muted"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Hide work" : "Show work"}
      </Button>
      {open ? <RunWorkDetail {...props} /> : null}
    </div>
  );
}

// ponytail: fetches every run of the agent to show one; add a getRun RPC when agents have many runs.
function RunWorkDetail(props: RunWorkProps) {
  const runs = useEnvironmentQuery(
    channelEnvironment.agentRuns({
      environmentId: props.environmentId,
      input: { agentId: props.agentId },
    }),
  );
  const run = runs.data?.runs.find((candidate) => candidate.threadId === props.runThreadId);
  if (run === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        {runs.error ?? (runs.data ? "This run is no longer available." : "Loading work…")}
      </p>
    );
  }
  return (
    <RunBlock
      run={run}
      channels={props.channels}
      cwd={props.cwd}
      environmentId={props.environmentId}
    />
  );
}

/**
 * The thread composer's surface, editor and send button without its session
 * controls: a channel or DM message has no model or access to pick. `onSend`
 * resolves true once the message is accepted, which clears the editor.
 */
export function MessageComposer(props: {
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onSend: (body: string) => Promise<boolean>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [body, setBody] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sending, setSending] = useState(false);
  const disabled = props.disabled === true;
  const trimmed = body.trim();

  const send = async () => {
    if (trimmed.length === 0 || sending || disabled) {
      return;
    }
    setSending(true);
    const accepted = await props.onSend(trimmed);
    setSending(false);
    if (accepted) {
      setBody("");
      setCursor(0);
      editorRef.current?.focus();
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
      <ComposerSurface.Shell className="max-w-none">
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="rounded-[20px]">
              <div className="px-3 pt-3.5 sm:px-4 sm:pt-4">
                <ComposerPromptEditor
                  editorRef={editorRef}
                  value={body}
                  cursor={cursor}
                  contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
                  skills={EMPTY_SKILLS}
                  disabled={disabled}
                  placeholder={props.placeholder}
                  onChange={(nextValue, nextCursor) => {
                    setBody(nextValue);
                    setCursor(nextCursor);
                  }}
                  onCommandKeyDown={(key, event) => {
                    if (key !== "Enter" || event.shiftKey) {
                      return false;
                    }
                    void send();
                    return true;
                  }}
                  onPaste={noop}
                />
              </div>
              <div className="flex items-center justify-end px-3 pb-3 sm:px-4 sm:pb-4">
                <ComposerPrimaryActions
                  compact={false}
                  pendingAction={null}
                  isRunning={false}
                  showPlanFollowUpPrompt={false}
                  promptHasText={trimmed.length > 0 && !disabled}
                  isSendBusy={sending}
                  sendDisabledReason={null}
                  isConnecting={false}
                  isEnvironmentUnavailable={false}
                  isPreparingWorktree={false}
                  hasSendableContent={trimmed.length > 0 && !disabled}
                  onPreviousPendingQuestion={noop}
                  onInterrupt={noop}
                  onImplementPlanInNewThread={noop}
                />
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}

const EMPTY_SKILLS: ReadonlyArray<never> = [];

function noop() {}

const NO_LEAD = "none";

const ChannelMemberList = memo(function ChannelMemberList(props: {
  readonly members: ReadonlyArray<AgentEntry>;
  readonly channel: OrchestrationChannelShell;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly environmentId: EnvironmentId;
}) {
  const updateChannel = useAtomCommand(channelEnvironment.update);
  // A lead is an agent of the project that is not a member of the channel.
  const leadOptions = props.agents.filter(
    (agent) =>
      agent.projectId === props.channel.projectId &&
      !props.channel.memberAgentIds.includes(agent.id),
  );
  const leadName = (agentId: string | null) =>
    agentId === null || agentId === NO_LEAD
      ? "No lead"
      : `@${props.agents.find((agent) => agent.id === agentId)?.name ?? agentId}`;
  return (
    <aside
      aria-label="Members"
      className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-l border-border px-3 py-4 lg:flex"
    >
      <h2 className="px-2 text-xs font-medium text-muted-foreground">Lead</h2>
      <div className="px-2 pb-3">
        <Select
          value={props.channel.leadAgentId ?? NO_LEAD}
          onValueChange={(value) =>
            void updateChannel({
              environmentId: props.environmentId,
              input: {
                channelId: props.channel.id,
                leadAgentId: value === null || value === NO_LEAD ? null : AgentId.make(value),
              },
            })
          }
        >
          <SelectTrigger aria-label="Channel lead">
            <SelectValue>{leadName}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_LEAD}>No lead</SelectItem>
            {leadOptions.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                @{agent.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Reads messages that mention no one and proposes cards from them.
        </p>
      </div>
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
export function PresenceBadge(props: {
  readonly presence: AgentEntry["presence"];
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
