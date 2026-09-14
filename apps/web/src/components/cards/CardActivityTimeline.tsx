import { filterCardActivities, type CardActivityFilter } from "@iskra/client-runtime/cards";
import type { CardActivity, CardActivityKind, OrchestrationAgentShell } from "@iskra/contracts";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * How many entries show before "Show older". The subscription itself carries only the card's
 * newest 200 activities (CARD_SUBSCRIBE_ACTIVITY_LIMIT); anything older isn't reachable from the
 * client until the server pages past that.
 */
const PAGE_SIZE = 30;

const FILTERS: ReadonlyArray<{ readonly value: CardActivityFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "people", label: "People" },
  { value: "agents", label: "Agents" },
];

const KIND_LABEL: Record<CardActivityKind, string> = {
  message: "Message",
  decision: "Decision",
  plan: "Plan",
  elicitation: "Question",
  response: "Answer",
  status: "Status",
  evidence: "Evidence",
  landing: "Landing",
  error: "Error",
  critique: "Critique",
  help: "Help",
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A card's activity, newest first, filtered to people or agents and paged in the sheet. */
export function CardActivityTimeline(props: {
  readonly activities: ReadonlyArray<CardActivity>;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly error: string | null;
}) {
  const [filter, setFilter] = useState<CardActivityFilter>("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const newestFirst = useMemo(
    () => filterCardActivities(props.activities, filter).toReversed(),
    [props.activities, filter],
  );
  const agentNames = useMemo(
    () => new Map(props.agents.map((agent) => [agent.id as string, agent.name])),
    [props.agents],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1" role="group" aria-label="Show activity from">
        {FILTERS.map((entry) => (
          <Button
            key={entry.value}
            size="compact"
            variant={filter === entry.value ? "outline" : "ghost-muted"}
            aria-pressed={filter === entry.value}
            onClick={() => {
              setFilter(entry.value);
              setShown(PAGE_SIZE);
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {props.error !== null ? <p className="text-xs text-destructive">{props.error}</p> : null}
      {newestFirst.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border">
          {newestFirst.slice(0, shown).map((activity) => (
            <ActivityRow
              key={activity.activityId}
              activity={activity}
              authorName={authorName(activity, agentNames)}
            />
          ))}
        </ol>
      )}
      {newestFirst.length > shown ? (
        <Button
          size="sm"
          variant="ghost-muted"
          className="self-start"
          onClick={() => setShown((current) => current + PAGE_SIZE)}
        >
          Show older ({newestFirst.length - shown})
        </Button>
      ) : null}
    </div>
  );
}

function authorName(activity: CardActivity, agentNames: ReadonlyMap<string, string>): string {
  switch (activity.author.kind) {
    case "agent":
      return `@${agentNames.get(activity.author.id) ?? "agent"}`;
    case "human":
      return "You";
    case "system":
      return "Iskra";
    case "linear":
      return "Linear";
    case "github":
      return "GitHub";
  }
}

const ActivityRow = memo(function ActivityRow(props: {
  readonly activity: CardActivity;
  readonly authorName: string;
}) {
  const { activity } = props;
  const undelivered = activity.deliverTo !== null && activity.delivery === "undelivered";
  return (
    <li className="flex min-w-0 flex-col gap-0.5 py-2">
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{props.authorName}</span>
        <span>{KIND_LABEL[activity.kind]}</span>
        <time dateTime={activity.createdAt} className="ms-auto shrink-0 tabular-nums">
          {timeFormat.format(new Date(activity.createdAt))}
        </time>
      </div>
      {activity.body.trim().length > 0 ? (
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-sm",
            activity.kind === "error" && "text-destructive-foreground",
          )}
        >
          {activity.body}
        </p>
      ) : null}
      {activity.elicitation !== null ? (
        <p className="text-xs text-muted-foreground">
          {activity.elicitation.options.map((option) => option.label).join(" · ")}
        </p>
      ) : null}
      {activity.reason !== null ? (
        <p className="text-xs text-muted-foreground">Why: {activity.reason.text}</p>
      ) : null}
      {undelivered ? (
        <p className="text-xs text-destructive-foreground">Not delivered to its agent</p>
      ) : null}
    </li>
  );
});
