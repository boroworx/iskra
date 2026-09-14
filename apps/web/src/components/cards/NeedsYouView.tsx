import {
  NEEDS_YOU_LABEL,
  isCardSnoozed,
  needsYouItems,
  waitingLabel,
} from "@iskra/client-runtime/cards";
import type { CardId, EnvironmentId } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { cardEnvironment } from "~/state/cards";
import { useEnvironmentCards, useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const HOUR_MS = 60 * 60_000;

/**
 * Everything across projects waiting on a person, longest waiting first, with
 * how long each has waited. Snoozed cards come back at their time or on their
 * next activity, and can be woken early.
 */
export function NeedsYouView() {
  const environmentId = usePrimaryEnvironmentId();
  const cards = useEnvironmentCards(environmentId);
  const projects = useProjects();
  const snooze = useAtomCommand(cardEnvironment.snooze);
  const unsnooze = useAtomCommand(cardEnvironment.unsnooze);
  // Waiting times read in minutes, so a minute's tick keeps them honest without animating.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const items = useMemo(
    () =>
      needsYouItems({
        cards,
        sessions: cards.flatMap((card) =>
          card.ownerSession === null
            ? []
            : [{ cardId: card.id, state: card.ownerSession.state, since: card.ownerSession.since }],
        ),
        now,
      }),
    [cards, now],
  );
  const snoozed = useMemo(() => cards.filter((card) => isCardSnoozed(card, now)), [cards, now]);
  const projectTitle = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "";

  const snoozeCard = (id: CardId, snoozedUntil: string | null) => {
    if (environmentId !== null) {
      void snooze({ environmentId, input: { cardId: id, snoozedUntil } });
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <h1 className="truncate text-sm font-semibold">Needs you</h1>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border">
              {items.map((item) => (
                <li key={item.key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <BoardLink environmentId={environmentId} projectId={item.projectId}>
                      {item.title}
                    </BoardLink>
                    <span className="truncate text-xs text-muted-foreground">
                      {NEEDS_YOU_LABEL[item.kind]} · {projectTitle(item.projectId)}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    waiting {waitingLabel(item.since, now)}
                  </span>
                  {item.snoozable ? (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        onClick={() => snoozeCard(item.cardId, new Date(now + HOUR_MS).toISOString())}
                      >
                        1 hour
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        onClick={() => snoozeCard(item.cardId, new Date(now + 24 * HOUR_MS).toISOString())}
                      >
                        Tomorrow
                      </Button>
                      <Button size="sm" variant="ghost-muted" onClick={() => snoozeCard(item.cardId, null)}>
                        Until it changes
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {snoozed.length > 0 ? (
            <section aria-label="Snoozed" className="mt-6">
              <h2 className="text-xs font-medium text-muted-foreground">Snoozed {snoozed.length}</h2>
              <ul className="mt-1 flex flex-col divide-y divide-border">
                {snoozed.map((card) => (
                  <li key={card.id} className="flex min-w-0 items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {card.title}
                      {card.snoozedUntil === null
                        ? " · until it changes"
                        : ` · until ${new Date(card.snoozedUntil).toLocaleString()}`}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost-muted"
                      onClick={() => {
                        if (environmentId !== null) {
                          void unsnooze({ environmentId, input: { cardId: card.id } });
                        }
                      }}
                    >
                      Wake
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </main>
      </div>
    </SidebarInset>
  );
}

function BoardLink(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string;
  readonly children: string;
}) {
  if (props.environmentId === null) {
    return <span className="truncate text-sm font-medium">{props.children}</span>;
  }
  return (
    <Link
      to="/board/$environmentId/$projectId"
      params={{ environmentId: props.environmentId, projectId: props.projectId }}
      className="truncate text-sm font-medium hover:underline"
    >
      {props.children}
    </Link>
  );
}
