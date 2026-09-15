import type { PillTone } from "@iskra/client-runtime/card-face";
import { triggerConfigRefusal } from "@iskra/client-runtime/cards";
import {
  AgentId,
  type ProjectOrchestration,
  type ProjectTrigger,
  type ProjectTriggerFire,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useEnvironmentAgents, useEnvironmentCards } from "~/state/entities";
import type { Project } from "~/types";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const KIND_LABEL: Record<ProjectTrigger["kind"], string> = {
  ciFailure: "CI fails on a branch",
  prComment: "A pull request comment mentions @iskra",
  schedule: "On a schedule",
};

const FIRE_PILL: Record<
  ProjectTriggerFire["outcome"],
  { readonly label: string; readonly tone: PillTone }
> = {
  created: { label: "Created", tone: "green" },
  refused: { label: "Refused", tone: "orange" },
  duplicate: { label: "Duplicate", tone: "gray" },
};

const NO_AGENT = "none";
const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

interface TriggerDraft {
  readonly original: string | null;
  readonly id: string;
  readonly kind: ProjectTrigger["kind"];
  readonly enabled: boolean;
  readonly agentId: string;
  readonly title: string;
  readonly spec: string;
  readonly criteria: string;
  readonly intake: ProjectTrigger["intake"];
  readonly cron: string;
  readonly timezone: string;
  readonly branch: string;
}

const draftOf = (trigger: ProjectTrigger): TriggerDraft => ({
  original: trigger.id,
  id: trigger.id,
  kind: trigger.kind,
  enabled: trigger.enabled,
  agentId: trigger.agentId ?? NO_AGENT,
  title: trigger.template.title,
  spec: trigger.template.spec,
  criteria: trigger.template.criteria.map((criterion) => criterion.text).join("\n"),
  intake: trigger.intake,
  cron: trigger.schedule?.cron ?? "",
  timezone: trigger.schedule?.timezone ?? "",
  branch: trigger.branch ?? "",
});

const NEW_DRAFT: TriggerDraft = {
  original: null,
  id: "",
  kind: "schedule",
  enabled: true,
  agentId: NO_AGENT,
  title: "",
  spec: "",
  criteria: "",
  intake: "triage",
  cron: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  branch: "",
};

/** The trigger a draft describes, or why it can't be saved. */
function triggerOf(
  draft: TriggerDraft,
  others: ReadonlyArray<ProjectTrigger>,
): ProjectTrigger | string {
  const id = draft.id.trim();
  if (id.length === 0) return "Give the trigger an id.";
  if (others.some((trigger) => trigger.id === id))
    return "Each trigger in a project needs its own id.";
  if (draft.title.trim().length === 0) return "Give the cards it makes a title.";
  if (
    draft.kind === "schedule" &&
    (draft.cron.trim().length === 0 || draft.timezone.trim().length === 0)
  ) {
    return "A schedule needs a cron expression and a time zone.";
  }
  const trigger: ProjectTrigger = {
    id,
    kind: draft.kind,
    enabled: draft.enabled,
    agentId: draft.agentId === NO_AGENT ? null : AgentId.make(draft.agentId),
    template: {
      title: draft.title.trim(),
      spec: draft.spec,
      criteria: draft.criteria
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((text, index) => ({ id: `c${index + 1}`, text, verification: "automated" as const })),
    },
    intake: draft.intake,
    schedule:
      draft.kind === "schedule"
        ? { cron: draft.cron.trim(), timezone: draft.timezone.trim() }
        : null,
    branch:
      draft.kind === "ciFailure" && draft.branch.trim().length > 0 ? draft.branch.trim() : null,
  };
  if (trigger.intake === "ready" && trigger.agentId === null) {
    return "Choose the agent that starts the work it makes ready.";
  }
  return triggerConfigRefusal(trigger) ?? trigger;
}

/**
 * Triggers turn outside events into cards: a failed CI run, a pull request comment from a
 * collaborator, or a schedule. The text that fired it goes into the card as untrusted input; the
 * criteria always come from here. Only a schedule with criteria may start work without triage.
 */
export function ProjectTriggersSettings(props: {
  readonly project: Project;
  readonly current: ProjectOrchestration;
  readonly saving: boolean;
  readonly onSave: (policy: ProjectOrchestration) => Promise<void>;
}) {
  const { project, current } = props;
  const allAgents = useEnvironmentAgents(project.environmentId);
  const agents = useMemo(
    () => allAgents.filter((agent) => agent.projectId === project.id),
    [allAgents, project.id],
  );
  const cards = useEnvironmentCards(project.environmentId);
  const [draft, setDraft] = useState<TriggerDraft | null>(null);
  const change = <K extends keyof TriggerDraft>(key: K, value: TriggerDraft[K]) =>
    setDraft((previous) => (previous === null ? previous : { ...previous, [key]: value }));
  const others = current.triggers.filter((trigger) => trigger.id !== draft?.original);
  const parsed = draft === null ? null : triggerOf(draft, others);
  const fires = project.recentTriggerFires ?? [];

  const saveTriggers = (triggers: ReadonlyArray<ProjectTrigger>) =>
    props.onSave({ ...current, triggers });

  return (
    <SettingsSection id="project-triggers" title="Triggers">
      <SettingsRow
        title="Triggers"
        description="Only comments from people with write access to the repository fire a trigger. Work a trigger starts on its own opens a draft pull request and always waits for you to merge."
      >
        <div className="flex flex-col gap-1.5 px-4 pb-3">
          {current.triggers.length === 0 && draft === null ? (
            <p className="text-xs text-muted-foreground">No triggers yet.</p>
          ) : null}
          <ul className="flex flex-col divide-y divide-border">
            {current.triggers.map((trigger) => (
              <li key={trigger.id} className="flex min-w-0 items-center gap-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{trigger.id}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {KIND_LABEL[trigger.kind]}
                    {trigger.schedule !== null
                      ? ` · ${trigger.schedule.cron} ${trigger.schedule.timezone}`
                      : ""}
                    {trigger.intake === "ready" ? " · starts work" : " · to triage"}
                  </span>
                </div>
                <Switch
                  aria-label={`${trigger.id} on`}
                  checked={trigger.enabled}
                  disabled={props.saving}
                  onCheckedChange={(enabled) =>
                    void saveTriggers(
                      current.triggers.map((entry) =>
                        entry.id === trigger.id ? { ...entry, enabled } : entry,
                      ),
                    )
                  }
                />
                <Button size="sm" variant="ghost-muted" onClick={() => setDraft(draftOf(trigger))}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={props.saving}
                  onClick={() =>
                    void saveTriggers(current.triggers.filter((entry) => entry.id !== trigger.id))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {draft === null ? (
            <Button
              size="sm"
              variant="ghost-muted"
              className="self-start"
              onClick={() => setDraft(NEW_DRAFT)}
            >
              Add trigger
            </Button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  size="sm"
                  className="w-40"
                  aria-label="Trigger id"
                  placeholder="nightly-deps"
                  value={draft.id}
                  onChange={(event) => change("id", event.target.value)}
                />
                <Select
                  value={draft.kind}
                  onValueChange={(value) => {
                    if (value !== null) change("kind", value);
                  }}
                >
                  <SelectTrigger aria-label="When it fires" className="w-auto min-w-48">
                    <SelectValue>
                      {(value: ProjectTrigger["kind"] | null) => KIND_LABEL[value ?? "schedule"]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(Object.keys(KIND_LABEL) as ProjectTrigger["kind"][]).map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {draft.kind === "schedule" ? (
                <div className="flex flex-wrap gap-1.5">
                  <Input
                    size="sm"
                    className="w-40"
                    aria-label="Cron expression"
                    placeholder="0 6 * * 1"
                    value={draft.cron}
                    onChange={(event) => change("cron", event.target.value)}
                  />
                  <Input
                    size="sm"
                    className="w-48"
                    aria-label="Time zone"
                    value={draft.timezone}
                    onChange={(event) => change("timezone", event.target.value)}
                  />
                </div>
              ) : draft.kind === "ciFailure" ? (
                <Input
                  size="sm"
                  aria-label="Branch"
                  placeholder="Branch to watch (blank watches the base branch)"
                  value={draft.branch}
                  onChange={(event) => change("branch", event.target.value)}
                />
              ) : null}
              <Input
                size="sm"
                aria-label="Card title"
                placeholder="Title of the cards it makes"
                value={draft.title}
                onChange={(event) => change("title", event.target.value)}
              />
              <Textarea
                aria-label="Card spec"
                placeholder="What the card asks for; what fired it is added below as untrusted input"
                value={draft.spec}
                onChange={(event) => change("spec", event.target.value)}
              />
              <Textarea
                aria-label="Acceptance criteria"
                placeholder="Acceptance criteria, one per line"
                value={draft.criteria}
                onChange={(event) => change("criteria", event.target.value)}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={draft.intake}
                  onValueChange={(value) => {
                    if (value !== null) change("intake", value);
                  }}
                >
                  <SelectTrigger aria-label="Intake" className="w-auto min-w-40">
                    <SelectValue>
                      {(value: ProjectTrigger["intake"] | null) =>
                        value === "ready" ? "Start work" : "Send to triage"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="triage">Send to triage</SelectItem>
                    <SelectItem value="ready">Start work</SelectItem>
                  </SelectPopup>
                </Select>
                <Select
                  value={draft.agentId}
                  onValueChange={(value) => change("agentId", value ?? NO_AGENT)}
                >
                  <SelectTrigger aria-label="Agent" className="w-auto min-w-40">
                    <SelectValue>
                      {(value: string | null) =>
                        value === null || value === NO_AGENT
                          ? "No agent"
                          : `@${agents.find((agent) => agent.id === value)?.name ?? "archived agent"}`
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_AGENT}>No agent</SelectItem>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        @{agent.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={props.saving || parsed === null || typeof parsed === "string"}
                  onClick={async () => {
                    if (parsed === null || typeof parsed === "string") return;
                    const triggers =
                      draft.original === null
                        ? [...current.triggers, parsed]
                        : current.triggers.map((entry) =>
                            entry.id === draft.original ? parsed : entry,
                          );
                    await saveTriggers(triggers);
                    setDraft(null);
                  }}
                >
                  Save trigger
                </Button>
                <Button size="sm" variant="ghost-muted" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                {typeof parsed === "string" ? (
                  <span className="text-xs text-muted-foreground">{parsed}</span>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Recent fires"
        description="The newest times a trigger fired, and what came of it."
      >
        <div className="px-4 pb-3">
          {fires.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing has fired yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {fires.map((fire) => {
                const card = cards.find((entry) => entry.id === fire.cardId);
                return (
                  <li
                    key={`${fire.triggerId}:${fire.sourceKey}`}
                    className="flex min-w-0 items-center gap-2 py-1.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">
                        {fire.triggerId}
                        {card !== undefined ? (
                          <>
                            {" · "}
                            <Link
                              to="/board/$environmentId/$projectId"
                              params={{
                                environmentId: project.environmentId,
                                projectId: project.id,
                              }}
                              search={{ card: card.id }}
                              className="hover:underline"
                            >
                              {card.title}
                            </Link>
                          </>
                        ) : null}
                      </span>
                      {fire.reason !== null ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {fire.reason.text}
                        </span>
                      ) : null}
                    </div>
                    <time
                      dateTime={fire.firedAt}
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {timeFormat.format(new Date(fire.firedAt))}
                    </time>
                    <StatusPill {...FIRE_PILL[fire.outcome]} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
