import {
  AgentId,
  MessageId,
  type ThreadId,
  type ChannelId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationChannelMessage,
  type OrchestrationChannelShell,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, ChevronsUpDownIcon, InfoIcon, PlusIcon } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";

import { collapseExpandedComposerCursor, replaceTextRange } from "~/composer-logic";
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
import ChatMarkdown from "../ChatMarkdown";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { EventLine } from "../iskra/EventLine";
import { SparkGlyph } from "../iskra/SparkGlyph";
import {
  agentListEntries,
  cardNoteOf,
  channelMemberEntries,
  channelMessageRows,
  deliveryNotes,
  mentionCandidates,
  mentionQueryAt,
  presenceDotClassName,
  presenceLabel,
  presenceSpark,
  proposalAnchors,
  type AgentEntry,
  type ChannelMessageRow,
} from "./channels.logic";
import { ChannelQuestion } from "../cards/CardContract";
import { CardProposal } from "./CardProposal";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { RunBlock } from "./RunBlock";

/** One channel: its messages, a composer, and who is in it. */
export function ChannelView(props: {
  readonly environmentId: EnvironmentId;
  readonly channelId: ChannelId;
}) {
  const channels = useEnvironmentChannels(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const cards = useEnvironmentCards(props.environmentId);
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
  // Any active agent of the project can be mentioned or lead, member or not.
  const projectId = channel?.projectId ?? null;
  const projectAgents = useMemo(
    () => (projectId === null ? [] : agentListEntries(agents, projectId)),
    [agents, projectId],
  );
  // The lead's proposals show under their messages, derived from the card shells already held.
  const proposals = useMemo(
    () => ({ channelId: props.channelId, cards, agents: projectAgents }),
    [props.channelId, cards, projectAgents],
  );
  const title = channel?.name ?? "";
  const postMessage = useAtomCommand(channelEnvironment.postMessage);
  const unarchive = useAtomCommand(channelEnvironment.unarchive);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          {channel === null ? null : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span aria-hidden className="text-[15px] font-semibold text-muted-foreground/75">
                #
              </span>
              <h1 className="truncate text-[15px] font-semibold">{title}</h1>
              {channel.topic.length > 0 ? (
                <span className="ml-1.5 hidden truncate text-[13px] text-muted-foreground/55 sm:inline">
                  {channel.topic}
                </span>
              ) : null}
              {channel.kind === "channel" ? (
                <>
                  {/* Below lg the members panel is hidden: its members and lead live in settings. */}
                  <Button
                    size="compact"
                    variant="ghost-muted"
                    className="ml-auto lg:hidden"
                    onClick={() => setSettingsOpen(true)}
                  >
                    {members.length} {members.length === 1 ? "member" : "members"}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    className="lg:ml-auto"
                    aria-label="Channel settings"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <InfoIcon />
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </WorkspacePageHeader>
        {channel !== null && settingsOpen ? (
          <ChannelSettingsDialog
            open
            onOpenChange={setSettingsOpen}
            environmentId={props.environmentId}
            channel={channel}
          />
        ) : null}
        {channel === null ? (
          channels.length > 0 ? (
            // Archived channels leave the shell, so the page is where one comes back.
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <p className="text-sm text-muted-foreground">
                This channel is archived or no longer exists.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void unarchive({
                    environmentId: props.environmentId,
                    input: { channelId: props.channelId },
                  })
                }
              >
                Unarchive
              </Button>
            </div>
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
                proposals={proposals}
              />
              <MessageComposer
                key={props.channelId}
                placeholder={`Message #${title}`}
                mentionAgents={projectAgents}
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
                leadOptions={projectAgents}
                channel={channel}
                agents={agents}
                environmentId={props.environmentId}
                onEditMembers={() => setSettingsOpen(true)}
              />
            ) : null}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationChannelMessage> = [];
const NO_ANCHORS: ReadonlyMap<string, ReadonlyArray<OrchestrationCardShell>> = new Map();
const NO_AGENTS: ReadonlyArray<AgentEntry> = [];

interface TimelineSource {
  readonly messages: ReadonlyArray<OrchestrationChannelMessage>;
  readonly error: string | null;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly channels: ReadonlyArray<OrchestrationChannelShell>;
  readonly cwd: string | undefined;
  readonly environmentId: EnvironmentId;
  /** A channel's cards and its project's agents, to show the lead's proposals under their messages. */
  readonly proposals?:
    | {
        readonly channelId: ChannelId;
        readonly cards: ReadonlyArray<OrchestrationCardShell>;
        readonly agents: ReadonlyArray<AgentEntry>;
      }
    | undefined;
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
  const { proposals } = props;
  const anchors = useMemo(
    () =>
      proposals === undefined
        ? NO_ANCHORS
        : proposalAnchors(props.messages, proposals.cards, proposals.channelId),
    [props.messages, proposals],
  );
  const cardById = useMemo(
    () =>
      new Map<string, OrchestrationCardShell>(
        (proposals?.cards ?? []).map((card) => [card.id, card]),
      ),
    [proposals],
  );
  // Keep the newest message in view as messages arrive.
  const scrollRef = useStickToNewest(rows.at(-1)?.message.id);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-7 pb-4 sm:px-8">
      {props.error !== null ? <p className="text-sm text-destructive">{props.error}</p> : null}
      <ol className="flex max-w-[716px] flex-col">
        {rows.map((row) => (
          <MessageRow
            key={row.message.id}
            row={row}
            agents={props.agents}
            channels={props.channels}
            cwd={props.cwd}
            environmentId={props.environmentId}
            proposals={anchors.get(row.message.id)}
            proposalAgents={proposals?.agents ?? NO_AGENTS}
            cardById={cardById}
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
  readonly proposals: ReadonlyArray<OrchestrationCardShell> | undefined;
  readonly proposalAgents: ReadonlyArray<AgentEntry>;
  readonly cardById: ReadonlyMap<string, OrchestrationCardShell>;
}) {
  const { message, authorName, showHeader } = props.row;
  const notes = message.authorKind === "human" ? deliveryNotes(message, props.agents) : [];
  // Iskra's own notes, such as a card starting or asking something, read as centered events.
  if (message.authorKind === "system") {
    const note = cardNoteOf(message);
    return (
      <li className="mt-4 flex min-w-0 flex-col first:mt-0">
        <EventLine spark={note === null ? "idle" : note.question ? "needsYou" : "working"}>
          <span className="whitespace-pre-wrap break-words">{message.body}</span>
          <time dateTime={message.createdAt} className="tabular-nums">
            · {messageTimeFormat.format(new Date(message.createdAt))}
          </time>
          <CardNoteLink
            message={message}
            cardById={props.cardById}
            environmentId={props.environmentId}
          />
        </EventLine>
      </li>
    );
  }
  return (
    <li
      className={cn(
        "grid min-w-0 grid-cols-[32px_minmax(0,1fr)] gap-x-3 text-[14px] leading-[1.45]",
        showHeader ? "mt-[22px] first:mt-0" : "mt-1",
      )}
    >
      {showHeader ? (
        <AgentAvatar name={authorName} size="lg" person={message.authorKind !== "agent"} />
      ) : (
        <span aria-hidden />
      )}
      <div className="flex min-w-0 flex-col">
        {showHeader ? (
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{authorName}</span>
            <time
              dateTime={message.createdAt}
              className="text-[11px] tabular-nums text-muted-foreground/55"
            >
              {messageTimeFormat.format(new Date(message.createdAt))}
            </time>
          </div>
        ) : null}
        {message.authorKind === "agent" ? (
          <>
            <ChatMarkdown text={message.body} cwd={props.cwd} environmentId={props.environmentId} />
            {message.elicitation !== undefined ? (
              <ChannelQuestion
                message={{ ...message, elicitation: message.elicitation }}
                environmentId={props.environmentId}
              />
            ) : null}
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
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}
        {notes.length > 0 ? (
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
            {notes.map((note) => (
              <span
                key={note.agentId}
                className={
                  note.undelivered ? "text-destructive-foreground" : "text-muted-foreground/55"
                }
              >
                {note.text}
              </span>
            ))}
          </p>
        ) : null}
        {props.proposals?.map((card) => (
          <CardProposal
            key={card.id}
            card={card}
            agents={props.proposalAgents}
            environmentId={props.environmentId}
          />
        ))}
      </div>
    </li>
  );
}

/** Under Iskra's note on a card's progress: where to open the card, or answer its owner's question. */
function CardNoteLink(props: {
  readonly message: OrchestrationChannelMessage;
  readonly cardById: ReadonlyMap<string, OrchestrationCardShell>;
  readonly environmentId: EnvironmentId;
}) {
  const note = cardNoteOf(props.message);
  const card = note === null ? undefined : props.cardById.get(note.cardId);
  if (note === null || card === undefined) {
    return null;
  }
  return (
    <Link
      to="/board/$environmentId/$projectId"
      params={{ environmentId: props.environmentId, projectId: card.projectId }}
      search={{ card: card.id }}
      className="font-medium text-info-foreground hover:underline"
    >
      {note.question ? "Answer on the card" : "Open card"}
    </Link>
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
    <div className="mt-0.5 flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className="-ml-1 inline-flex h-7 items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")}
        />
        {open ? "Hide work" : "Show work"}
      </button>
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
 * resolves true once the message is accepted, which clears the editor. With
 * `mentionAgents`, typing `@` offers those agents.
 */
export function MessageComposer(props: {
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly mentionAgents?: ReadonlyArray<AgentEntry>;
  readonly onSend: (body: string) => Promise<boolean>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [body, setBody] = useState("");
  const [cursor, setCursor] = useState(0);
  // The cursor as an offset into `body`; `cursor` counts a mention chip as one character.
  const [textCursor, setTextCursor] = useState(0);
  const [inMentionChip, setInMentionChip] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const disabled = props.disabled === true;
  const trimmed = body.trim();
  const listboxId = useId();

  const mentionAgents = props.mentionAgents;
  const mention =
    mentionAgents === undefined || inMentionChip ? null : mentionQueryAt(body, textCursor);
  const candidates =
    mention === null || mentionAgents === undefined
      ? []
      : mentionCandidates(mentionAgents, mention.query);
  const menuOpen =
    mention !== null && candidates.length > 0 && dismissedMentionStart !== mention.start;
  const activeIndex = Math.min(highlighted, candidates.length - 1);

  const pickMention = (agent: AgentEntry) => {
    if (mention === null) {
      return;
    }
    const next = replaceTextRange(body, mention.start, textCursor, `@${agent.name} `);
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    setBody(next.text);
    setCursor(nextCursor);
    setTextCursor(next.cursor);
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

  // The + button starts a mention at the cursor, which opens the agent menu.
  const startMention = () => {
    const before = body.slice(0, textCursor);
    const next = replaceTextRange(
      body,
      textCursor,
      textCursor,
      before.length === 0 || /\s$/.test(before) ? "@" : " @",
    );
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    setBody(next.text);
    setCursor(nextCursor);
    setTextCursor(next.cursor);
    setInMentionChip(false);
    setDismissedMentionStart(null);
    setHighlighted(0);
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

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
      setTextCursor(0);
      editorRef.current?.focus();
    }
  };

  return (
    <form
      className="relative shrink-0 px-5 pt-4 pb-6 sm:px-8"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen && mention !== null) {
          event.preventDefault();
          setDismissedMentionStart(mention.start);
        }
      }}
    >
      {menuOpen ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Mention an agent"
          className="dropdown-glass absolute bottom-full left-5 z-10 -mb-2 flex w-60 sm:left-8 flex-col rounded-lg p-1 text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
        >
          {candidates.map((agent, index) => (
            <li
              key={agent.id}
              role="option"
              aria-selected={index === activeIndex}
              // Keep focus in the editor: pick on mouse down, before it blurs.
              onMouseDown={(event) => {
                event.preventDefault();
                pickMention(agent);
              }}
              onMouseEnter={() => setHighlighted(index)}
              className={cn(
                "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              <span className="truncate">@{agent.name}</span>
              <PresenceBadge presence={agent.presence} className="ml-auto" />
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={cn(
          "flex max-w-[716px] items-end gap-2.5 rounded-[19px] bg-[rgb(120_120_128/12%)] py-1.5 pr-1.5 pl-2.5 shadow-[inset_0_0_0_0.5px_rgb(0_0_0/8%)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--ring)] dark:bg-[rgb(120_120_128/16%)] dark:shadow-[inset_0_0_0_0.5px_rgb(255_255_255/8%)]",
          mentionAgents === undefined && "pl-4",
        )}
      >
        {mentionAgents !== undefined ? (
          <button
            type="button"
            aria-label="Mention an agent"
            disabled={disabled}
            // Keep the editor's selection: act on mouse down, before it blurs.
            onMouseDown={(event) => event.preventDefault()}
            onClick={startMention}
            className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <svg aria-hidden width="20" height="20" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M12 8v8M8 12h8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
        <ComposerPromptEditor
          editorRef={editorRef}
          value={body}
          cursor={cursor}
          contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
          skills={EMPTY_SKILLS}
          disabled={disabled}
          placeholder={props.placeholder}
          containerClassName="min-w-0 flex-1 self-center [font-size:14px]"
          className="max-h-50 min-h-[26px] py-[3px] leading-5"
          placeholderClassName="py-[3px] leading-5 text-placeholder/60"
          onChange={(nextValue, nextCursor, expandedCursor, adjacentToMention) => {
            setBody(nextValue);
            setCursor(nextCursor);
            setTextCursor(expandedCursor);
            setInMentionChip(adjacentToMention);
            setHighlighted(0);
          }}
          onCommandKeyDown={(key, event) => {
            if (menuOpen) {
              if (key === "ArrowDown" || key === "ArrowUp") {
                const step = key === "ArrowDown" ? 1 : -1;
                setHighlighted((activeIndex + step + candidates.length) % candidates.length);
                return true;
              }
              const picked = candidates[activeIndex];
              if (picked !== undefined) {
                pickMention(picked);
                return true;
              }
            }
            if (key !== "Enter" || event.shiftKey) {
              return false;
            }
            void send();
            return true;
          }}
          onPaste={noop}
        />
        <button
          type="submit"
          aria-label={sending ? "Sending" : "Send message"}
          disabled={sending || disabled || trimmed.length === 0}
          className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-[rgb(120_120_128/40%)] disabled:text-background"
        >
          {sending ? (
            <Spinner className="size-3.5" aria-hidden="true" />
          ) : (
            <svg aria-hidden width="26" height="26" viewBox="0 0 24 24">
              <path
                d="M12 16.5V8m-3.8 3.6L12 7.8l3.8 3.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}

const EMPTY_SKILLS: ReadonlyArray<never> = [];

function noop() {}

const NO_LEAD = "none";

const ChannelMemberList = memo(function ChannelMemberList(props: {
  readonly members: ReadonlyArray<AgentEntry>;
  readonly leadOptions: ReadonlyArray<AgentEntry>;
  readonly channel: OrchestrationChannelShell;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly environmentId: EnvironmentId;
  /** Opens channel settings, where members are added and removed. */
  readonly onEditMembers: () => void;
}) {
  const updateChannel = useAtomCommand(channelEnvironment.update);
  const leadId = props.channel.leadAgentId;
  const leadName =
    leadId === null ? null : (props.agents.find((agent) => agent.id === leadId)?.name ?? leadId);
  return (
    <aside
      aria-label="Members"
      className="hidden w-[260px] shrink-0 flex-col overflow-y-auto bg-sidebar px-3 py-5 shadow-[inset_0.5px_0_var(--border)] lg:flex"
    >
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <h2 className={INSPECTOR_HEAD}>Lead</h2>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="What the lead does"
                className="-my-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/55 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <InfoIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup className="max-w-60">
            The lead reads messages that mention no one, asks what is unclear, and proposes cards
            you start from the channel.
          </TooltipPopup>
        </Tooltip>
      </div>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Channel lead: ${leadName === null ? "No lead" : `@${leadName}`}`}
              className="group mb-[18px] flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
            />
          }
        >
          {leadName === null ? (
            <>
              <span
                aria-hidden
                className="size-6 shrink-0 rounded-full border border-dashed border-muted-foreground/40"
              />
              <span className="truncate text-muted-foreground">No lead</span>
            </>
          ) : (
            <>
              <AgentAvatar name={leadName} size="md" />
              <span className="truncate">{leadName}</span>
            </>
          )}
          <ChevronsUpDownIcon
            aria-hidden
            className="ml-auto size-3.5 shrink-0 text-muted-foreground/55 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-popup-open:opacity-100"
          />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-52">
          <MenuRadioGroup
            value={leadId ?? NO_LEAD}
            onValueChange={(value: string) =>
              void updateChannel({
                environmentId: props.environmentId,
                input: {
                  channelId: props.channel.id,
                  leadAgentId: value === NO_LEAD ? null : AgentId.make(value),
                },
              })
            }
          >
            <MenuRadioItem value={NO_LEAD}>No lead</MenuRadioItem>
            {props.leadOptions.map((agent) => (
              <MenuRadioItem key={agent.id} value={agent.id}>
                @{agent.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <div className="flex items-center px-2 pb-1.5">
        <h2 className={INSPECTOR_HEAD}>Members</h2>
        <button
          type="button"
          aria-label="Add members"
          onClick={props.onEditMembers}
          className="-my-2 ml-auto inline-flex size-7 items-center justify-center rounded-md text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PlusIcon aria-hidden className="size-4" />
        </button>
      </div>
      {props.members.length === 0 ? (
        <p className="px-2 text-[13px] text-muted-foreground/55">No members yet</p>
      ) : null}
      <ul role="list" className="flex flex-col">
        {props.members.map((member) => (
          <li key={member.id} className="flex h-9 min-w-0 items-center gap-2.5 px-2 text-[13px]">
            <AgentAvatar name={member.name} size="md" />
            <span className="truncate">{member.name}</span>
            {member.presence === "idle" ? null : (
              <SparkGlyph state={presenceSpark(member.presence)} size={12} className="ml-auto" />
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
});

const INSPECTOR_HEAD = "text-[11px] font-semibold text-muted-foreground/55";

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
