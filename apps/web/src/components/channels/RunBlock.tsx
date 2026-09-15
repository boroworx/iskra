import { scopeThreadRef } from "@iskra/client-runtime/environment";
import { derivePendingRequests, type PendingUserInput } from "@iskra/client-runtime/pending-requests";
import {
  runSessionState,
  type EnvironmentId,
  type OrchestrationAgentRun,
  type OrchestrationChannelShell,
  type RunSessionState,
  type ThreadId,
} from "@iskra/contracts";
import { memo, useMemo, useState, type ReactElement } from "react";

import { cn } from "~/lib/utils";
import { useThreadDetail } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastCommandFailure } from "../toastCommandFailure";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { runOutputItems, sessionWhere } from "./channels.logic";

/** A short explanation on hover or focus; the element alone when there is none. */
function Hint(props: { readonly text: string | undefined; readonly children: ReactElement }) {
  if (props.text === undefined) {
    return props.children;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup className="max-w-64">{props.text}</TooltipPopup>
    </Tooltip>
  );
}

const runTimeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const SESSION_STATE_LABEL: Record<RunSessionState, string> = {
  pending: "Starting",
  active: "Working",
  awaitingInput: "Waiting for you",
  complete: "Idle",
  error: "Failed",
  stale: "Lost in a restart",
  ended: "Ended",
};

const SESSION_STATE_HINT: Partial<Record<RunSessionState, string>> = {
  awaitingInput: "It asked a question or needs an approval before it can go on.",
  complete: "Its turn is done. The session stays open for the next message until it is stopped.",
  stale: "The session did not survive a server restart. Send a new message to continue.",
};

const ROLE_HEADING: Record<OrchestrationAgentRun["role"], string> = {
  owner: "Building",
  helper: "Helping on",
  critic: "Reviewing",
  lead: "Leading",
  conversation: "In",
  verifier: "Verifying",
};

const ROLE_HINT: Record<OrchestrationAgentRun["role"], string> = {
  owner: "Owner: the agent that builds this card on its own branch.",
  helper: "Helper: answers a question the card's owner asked, read-only.",
  critic: "Critic: reviews the card's changes before you do.",
  lead: "Lead: reads channel messages that mention no one and proposes cards from them.",
  conversation: "Conversation: replies where it was mentioned or messaged, read-only.",
  verifier: "Verifier: checks the card's latest commit against its criteria, read-only.",
};

/**
 * One session of an agent, as its page shows it: the channel or card it works on,
 * where it stands, its work in grey and what it says to people in full white,
 * and the context it started from. A live conversation or card build can be stopped.
 */
export const RunBlock = memo(function RunBlock(props: {
  readonly run: OrchestrationAgentRun;
  readonly environmentId: EnvironmentId;
  readonly channels: ReadonlyArray<OrchestrationChannelShell>;
  readonly cwd: string | undefined;
}) {
  const [inspecting, setInspecting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.run.threadId),
    [props.environmentId, props.run.threadId],
  );
  const thread = useThreadDetail(threadRef);
  const items = useMemo(() => (thread === null ? [] : runOutputItems(thread)), [thread]);
  const pending = useMemo(
    () => (thread === null ? null : derivePendingRequests(thread.activities)),
    [thread],
  );
  const state = runSessionState({
    endedAt: props.run.endedAt,
    session: thread?.session ?? null,
    awaitingInput: pending !== null && pending.approvals.length + pending.userInputs.length > 0,
  });
  const where = sessionWhere(props.run, props.channels);
  const heading = `${ROLE_HEADING[props.run.role]} ${where}`;
  const isCardSession = props.run.role !== "conversation" && props.run.role !== "lead";
  const stoppable =
    state !== "ended" && (props.run.role === "conversation" || props.run.role === "owner");

  const stop = async () => {
    setStopping(true);
    const result = await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.run.threadId },
    });
    setStopping(false);
    toastCommandFailure(result, "The session was not stopped", "Try again.");
  };

  return (
    <section aria-label={heading} className="min-w-0 border-l-2 border-border pl-3">
      <header className="flex h-7 items-center gap-2 text-xs text-muted-foreground">
        <Hint text={ROLE_HINT[props.run.role]}>
          <span className="truncate">{heading}</span>
        </Hint>
        <time dateTime={props.run.startedAt} className="shrink-0">
          {runTimeFormat.format(new Date(props.run.startedAt))}
        </time>
        <Hint text={SESSION_STATE_HINT[state]}>
          <span
            className={cn(
              "shrink-0",
              (state === "awaitingInput" || state === "error") && "text-destructive-foreground",
            )}
          >
            {SESSION_STATE_LABEL[state]}
          </span>
        </Hint>
        <span className="ml-auto flex shrink-0 items-center">
          {stoppable ? (
            <Hint text="End this session. A new message or assignment starts a fresh one.">
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={stopping}
                onClick={() => void stop()}
              >
                Stop
              </Button>
            </Hint>
          ) : null}
          <Hint
            text={
              isCardSession
                ? "Handoff brief: the card, decisions and diff this session started from."
                : "What this session was told when it started."
            }
          >
            <Button size="sm" variant="ghost-muted" onClick={() => setInspecting(true)}>
              {isCardSession ? "Handoff brief" : "Context"}
            </Button>
          </Hint>
        </span>
      </header>
      <ol className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            {item.addressedToUser ? (
              <ChatMarkdown text={item.text} cwd={props.cwd} environmentId={props.environmentId} />
            ) : (
              <p className="truncate text-xs text-muted-foreground">{item.text}</p>
            )}
          </li>
        ))}
      </ol>
      {pending?.userInputs
        .filter((request) => request.dismissible)
        .map((request) => (
          <RunQuestion
            key={request.requestId}
            environmentId={props.environmentId}
            threadId={props.run.threadId}
            request={request}
          />
        ))}
      <RunContextDialog
        run={props.run}
        isCardSession={isCardSession}
        open={inspecting}
        onOpenChange={setInspecting}
      />
    </section>
  );
});

/** A question the session asked by message; the answer becomes its next message. */
function RunQuestion(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: PendingUserInput;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const complete = props.request.questions.every(
    (question) => (answers[question.id] ?? "").trim().length > 0,
  );

  const send = async () => {
    setSending(true);
    const result = await respond({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, requestId: props.request.requestId, answers },
    });
    setSending(false);
    toastCommandFailure(result, "The answer was not sent", "Try again.");
  };

  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {props.request.questions.map((question) => (
        <label key={question.id} className="flex flex-col gap-1.5 text-sm">
          <span>{question.question}</span>
          {question.options.length > 0 && (
            <span className="flex flex-wrap gap-1.5">
              {question.options.map((option) => (
                <Button
                  key={option.label}
                  type="button"
                  size="compact"
                  variant={answers[question.id] === option.label ? "secondary" : "outline"}
                  onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                >
                  {option.label}
                </Button>
              ))}
            </span>
          )}
          <Textarea
            value={answers[question.id] ?? ""}
            onChange={(event) =>
              setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
            }
          />
        </label>
      ))}
      <Button type="submit" size="sm" className="self-end" disabled={!complete || sending}>
        Answer
      </Button>
    </form>
  );
}

/** The context inspector: exactly what the session was given, as sent. */
function RunContextDialog(props: {
  readonly run: OrchestrationAgentRun;
  readonly isCardSession: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{props.isCardSession ? "Handoff brief" : "Run context"}</DialogTitle>
          <DialogDescription>
            {props.isCardSession
              ? "What the session started from: the card, its decisions and diff, rendered into the instructions and first message it was sent."
              : "The instructions and first message the session was sent when it started."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ContextText title="Instructions (system prompt)" text={props.run.rendered.systemPrompt} />
          <ContextText title="First message" text={props.run.rendered.firstMessage} />
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Raw data these were built from
            </summary>
            <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
              {JSON.stringify(props.run.context, null, 2)}
            </pre>
          </details>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ContextText(props: { readonly title: string; readonly text: string }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
        {props.text}
      </pre>
    </section>
  );
}
