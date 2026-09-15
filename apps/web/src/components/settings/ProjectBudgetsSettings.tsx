import { reasonLabel } from "@iskra/client-runtime/cards";
import { projectSpendOf, type ProjectOrchestration } from "@iskra/contracts";
import { useMemo, useState } from "react";

import { useEnvironmentAgents, useEnvironmentCards } from "~/state/entities";
import type { Project } from "~/types";
import { SpendBar } from "../iskra/Marks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const BUDGET_CODES = new Set([
  "budgetCap",
  "agentBudgetCap",
  "environmentBudgetCap",
  "budgetBreaker",
]);

/** Dollars, or null for blank; undefined when the text isn't a positive amount. */
function dollars(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * A project's monthly budgets: what it spent this month by agent, its caps, and the cards a cap
 * holds. At the cap new turns wait; a turn well past it is interrupted and its card paused.
 */
export function ProjectBudgetsSettings(props: {
  readonly project: Project;
  readonly current: ProjectOrchestration;
  readonly saving: boolean;
  readonly onSave: (policy: ProjectOrchestration) => Promise<void>;
}) {
  const { project, current } = props;
  const budgets = current.budgets;
  const agents = useEnvironmentAgents(project.environmentId);
  const cards = useEnvironmentCards(project.environmentId);
  const [projectUsd, setProjectUsd] = useState(
    budgets.projectUsd === null ? "" : String(budgets.projectUsd),
  );
  const [perAgentUsd, setPerAgentUsd] = useState(
    budgets.perAgentUsd === null ? "" : String(budgets.perAgentUsd),
  );
  const [cardDefaultUsd, setCardDefaultUsd] = useState(String(budgets.cardDefaultUsd));
  const spend = projectSpendOf(project, new Date().toISOString());
  const held = useMemo(
    () =>
      cards.filter(
        (card) =>
          card.projectId === project.id &&
          ((card.waitReason !== null && BUDGET_CODES.has(card.waitReason.code)) ||
            (card.paused !== null && BUDGET_CODES.has(card.paused.reason.code))),
      ),
    [cards, project.id],
  );
  const nextProject = dollars(projectUsd);
  const nextPerAgent = dollars(perAgentUsd);
  const nextCard = dollars(cardDefaultUsd);
  const valid =
    nextProject !== undefined && nextPerAgent !== undefined && typeof nextCard === "number";
  const next =
    valid && typeof nextCard === "number"
      ? { projectUsd: nextProject, perAgentUsd: nextPerAgent, cardDefaultUsd: nextCard }
      : null;
  const edited = next !== null && JSON.stringify(next) !== JSON.stringify(budgets);

  return (
    <SettingsSection id="project-budgets" title="Budgets">
      <SettingsRow
        title={`${usd(spend.totalUsd)} spent this month`}
        description="Every agent run in this project counts: cards, channel leads and conversations. A new month starts from zero."
        control={
          budgets.projectUsd === null ? null : (
            <SpendBar spentUsd={spend.totalUsd} capUsd={budgets.projectUsd} className="w-28" />
          )
        }
      >
        {spend.byAgent.length > 0 ? (
          <ul className="flex flex-col gap-0.5 px-4 pb-3 text-xs text-muted-foreground">
            {spend.byAgent.map((entry) => (
              <li key={entry.agentId} className="flex gap-2 tabular-nums">
                <span className="min-w-0 flex-1 truncate">
                  @{agents.find((agent) => agent.id === entry.agentId)?.name ?? "archived agent"}
                </span>
                {usd(entry.usd)}
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Monthly caps"
        description="At the project cap, or an agent's, new work waits and channel messages to agents are refused until you raise it or the month turns. Blank sets no cap."
        control={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Project $
            <Input
              size="sm"
              className="w-20"
              inputMode="decimal"
              aria-label="Project monthly budget in dollars"
              placeholder="None"
              value={projectUsd}
              onChange={(event) => setProjectUsd(event.target.value)}
            />
            Each agent $
            <Input
              size="sm"
              className="w-20"
              inputMode="decimal"
              aria-label="Per-agent monthly budget in dollars"
              placeholder="None"
              value={perAgentUsd}
              onChange={(event) => setPerAgentUsd(event.target.value)}
            />
          </div>
        }
      />
      <SettingsRow
        title="Card budget"
        description="The cap a new card starts with, including cards a trigger starts."
        control={
          <Input
            size="sm"
            className="w-20"
            inputMode="decimal"
            aria-label="Default card budget in dollars"
            value={cardDefaultUsd}
            onChange={(event) => setCardDefaultUsd(event.target.value)}
          />
        }
      />
      {held.length > 0 ? (
        <SettingsRow title={`${held.length} card${held.length === 1 ? "" : "s"} held by a budget`}>
          <ul className="flex flex-col gap-0.5 px-4 pb-3 text-xs text-muted-foreground">
            {held.map((card) => {
              const reason = card.paused?.reason ?? card.waitReason;
              return (
                <li key={card.id} className="truncate">
                  {card.title}
                  {reason === null ? "" : ` · ${reasonLabel(reason).label}`}
                </li>
              );
            })}
          </ul>
        </SettingsRow>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button
          size="sm"
          disabled={!edited || props.saving}
          onClick={() => {
            if (next !== null) void props.onSave({ ...current, budgets: next });
          }}
        >
          Save budgets
        </Button>
        {!valid ? (
          <span className="text-xs text-destructive-foreground">
            Budgets are dollar amounts above 0; caps may be blank.
          </span>
        ) : null}
      </div>
    </SettingsSection>
  );
}
