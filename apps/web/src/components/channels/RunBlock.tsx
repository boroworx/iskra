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
import { memo, useMemo, useState } from "react";

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
import { runOutputItems, sessionWhere } from "./channels.logic";

const runTimeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const SESSION_STATE_LABEL: Record<RunSessionState, string> = {
  pending: "Starting",
  active: "Working",
  awaitingInput: "Needs you",
  complete: "Waiting",
  error: "Failed",
  stale: "Stale",
  ended: "Ended",
};

/**
 * One session of an agent, as its DM shows it: the channel or card it works on,
 * where it stands, its work in grey and what it says to people in full white,
 * and the context it started from.
 */
export const RunBlock = memo(function RunBlock(props: {
  readonly run: OrchestrationAgentRun;
  readonly environmentId: EnvironmentId;
  readonly channels: ReadonlyArray<OrchestrationChannelShell>;
  readonly cwd: string | undefined;
}) {
  const [inspecting, setInspecting] = useState(false);
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
  const heading =
    props.run.role === "owner"
      ? `Building ${where}`
      : props.run.role === "helper"
        ? `Helping on ${where}`
        : props.run.role === "critic"
          ? `Reviewing ${where}`
          : props.run.role === "lead"
            ? `Leading ${where}`
            : `In ${where}`;

  return (
    <section aria-label={heading} className="min-w-0 border-l-2 border-border pl-3">
      <header className="flex h-7 items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{heading}</span>
        <time dateTime={props.run.startedAt} className="shrink-0">
          {runTimeFormat.format(new Date(props.run.startedAt))}
        </time>
        <span
          className={cn(
            "shrink-0",
            (state === "awaitingInput" || state === "error") && "text-destructive-foreground",
          )}
        >
          {SESSION_STATE_LABEL[state]}
        </span>
        <Button
          className="ml-auto"
          size="sm"
          variant="ghost-muted"
          onClick={() => setInspecting(true)}
        >
          Context
        </Button>
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
      <RunContextDialog run={props.run} open={inspecting} onOpenChange={setInspecting} />
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
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const isCardSession = props.run.role !== "conversation" && props.run.role !== "lead";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isCardSession ? "Handoff brief" : "Run context"}</DialogTitle>
          <DialogDescription>
            The system prompt and first message sent to the provider, and the record they were
            rendered from.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ContextText title="System prompt" text={props.run.rendered.systemPrompt} />
          <ContextText title="First message" text={props.run.rendered.firstMessage} />
          <ContextText title="Context record" text={JSON.stringify(props.run.context, null, 2)} />
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
