import { scopeThreadRef } from "@iskra/client-runtime/environment";
import { derivePendingRequests } from "@iskra/client-runtime/pending-requests";
import {
  runSessionState,
  type EnvironmentId,
  type OrchestrationAgentRun,
  type OrchestrationChannelShell,
  type RunSessionState,
} from "@iskra/contracts";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadDetail } from "~/state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
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
  const state = useMemo(() => {
    const pending = thread === null ? null : derivePendingRequests(thread.activities);
    return runSessionState({
      endedAt: props.run.endedAt,
      session: thread?.session ?? null,
      awaitingInput: pending !== null && pending.approvals.length + pending.userInputs.length > 0,
    });
  }, [props.run.endedAt, thread]);
  const where = sessionWhere(props.run, props.channels);
  const heading =
    props.run.role === "owner"
      ? `Building ${where}`
      : props.run.role === "helper"
        ? `Helping on ${where}`
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
      <RunContextDialog run={props.run} open={inspecting} onOpenChange={setInspecting} />
    </section>
  );
});

/** The context inspector: exactly what the session was given, as sent. */
function RunContextDialog(props: {
  readonly run: OrchestrationAgentRun;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const isCardSession = props.run.role !== "conversation";
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
