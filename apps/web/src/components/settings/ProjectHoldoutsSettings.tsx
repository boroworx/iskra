import type { HoldoutScenario } from "@iskra/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import type { Project } from "~/types";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  SettingsAddButton,
  SettingsEmptyRow,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const KIND_LABEL: Record<HoldoutScenario["kind"], string> = {
  text: "Described",
  command: "Command",
};

const DEFAULT_TIMEOUT_MINUTES = 5;

interface ScenarioDraft {
  readonly scenarioId: string;
  readonly title: string;
  readonly kind: HoldoutScenario["kind"];
  readonly body: string;
  readonly command: string;
  readonly timeoutMinutes: string;
}

const draftOf = (scenario: HoldoutScenario): ScenarioDraft => ({
  scenarioId: scenario.scenarioId,
  title: scenario.title,
  kind: scenario.kind,
  body: scenario.body,
  command: scenario.command ?? "",
  timeoutMinutes: String(scenario.timeoutMinutes),
});

/** The scenario a draft describes, or why it can't be saved. */
function scenarioOf(draft: ScenarioDraft): HoldoutScenario | string {
  const title = draft.title.trim();
  const command = draft.command.trim();
  const timeoutMinutes = Number(draft.timeoutMinutes);
  if (title.length === 0) return "Give the scenario a title.";
  if (draft.kind === "text" && draft.body.trim().length === 0) {
    return "Describe what the verifier should check.";
  }
  if (draft.kind === "command" && command.length === 0) return "Give the command to run.";
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30) {
    return "The time limit is a whole number of minutes, from 1 to 30.";
  }
  return {
    scenarioId: draft.scenarioId,
    title,
    kind: draft.kind,
    body: draft.body,
    command: draft.kind === "command" ? command : null,
    timeoutMinutes,
  };
}

/**
 * A project's hidden scenarios: checks only the verifier reads, stored by the environment and
 * never in the repository. The list shows titles; a body loads only behind Edit, and a save
 * replaces the scenario without reading anything back.
 */
export function ProjectHoldoutsSettings(props: { readonly project: Project }) {
  const target = {
    environmentId: props.project.environmentId,
    input: { projectId: props.project.id },
  };
  const list = useEnvironmentQuery(channelEnvironment.projectHoldouts(target));
  const getScenario = useAtomCommand(channelEnvironment.getProjectHoldout, {
    reportFailure: false,
  });
  const setScenario = useAtomCommand(channelEnvironment.setProjectHoldout, {
    reportFailure: false,
  });
  const removeScenario = useAtomCommand(channelEnvironment.removeProjectHoldout, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<ScenarioDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = draft === null ? null : scenarioOf(draft);
  const change = <K extends keyof ScenarioDraft>(key: K, value: ScenarioDraft[K]) =>
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));

  const edit = async (scenarioId: string) => {
    setBusy(true);
    const result = await getScenario({
      environmentId: target.environmentId,
      input: { ...target.input, scenarioId },
    });
    setBusy(false);
    toastCommandFailure(result, "The scenario didn't load", "Try again.");
    if (result._tag === "Success") setDraft(draftOf(result.value.scenario));
  };

  const save = async (scenario: HoldoutScenario) => {
    setBusy(true);
    const result = await setScenario({
      environmentId: target.environmentId,
      input: { ...target.input, scenario },
    });
    setBusy(false);
    toastCommandFailure(result, "The scenario was not saved", "The request was refused.");
    if (result._tag === "Success") {
      setDraft(null);
      list.refresh();
    }
  };

  const remove = async (scenarioId: string) => {
    setBusy(true);
    const result = await removeScenario({
      environmentId: target.environmentId,
      input: { ...target.input, scenarioId },
    });
    setBusy(false);
    toastCommandFailure(result, "The scenario was not removed", "The request was refused.");
    if (result._tag === "Success") {
      if (draft?.scenarioId === scenarioId) setDraft(null);
      list.refresh();
    }
  };

  const scenarios = list.data?.scenarios ?? [];
  return (
    <SettingsSection id="project-holdouts" title="Hidden scenarios">
      <SettingsRow
        title="Scenarios"
        description="Checks only the verifier sees, never stored in the repository. They're kept on this machine, and a builder only learns how many failed. A command scenario runs in the verifier's copy of the card. Anyone who can open the verifier's session can read them."
        control={
          draft === null ? (
            <SettingsAddButton
              onClick={() =>
                setDraft({
                  scenarioId: randomUUID(),
                  title: "",
                  kind: "text",
                  body: "",
                  command: "",
                  timeoutMinutes: String(DEFAULT_TIMEOUT_MINUTES),
                })
              }
            >
              Add scenario
            </SettingsAddButton>
          ) : null
        }
      >
        {list.error === null && scenarios.length === 0 && draft === null ? null : (
          <div className="flex flex-col gap-1.5 pb-3">
            {list.error !== null ? (
              <p className="text-xs text-destructive-foreground">{list.error}</p>
            ) : null}
            <ul className="flex flex-col divide-y divide-border">
              {scenarios.map((scenario) => (
                <li key={scenario.scenarioId} className="flex min-w-0 items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{scenario.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {KIND_LABEL[scenario.kind]}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    disabled={busy}
                    onClick={() => void edit(scenario.scenarioId)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    disabled={busy}
                    onClick={() => void remove(scenario.scenarioId)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {draft === null ? null : (
              <div className="flex flex-col gap-2 rounded-lg bg-background p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label="Scenario title"
                    placeholder="Health is JSON"
                    value={draft.title}
                    onChange={(event) => change("title", event.target.value)}
                  />
                  <Select
                    value={draft.kind}
                    onValueChange={(value) => {
                      if (value === "text" || value === "command") change("kind", value);
                    }}
                  >
                    <SelectTrigger aria-label="Scenario kind" className="w-auto min-w-32">
                      <SelectValue>
                        {(value: HoldoutScenario["kind"] | null) => KIND_LABEL[value ?? "text"]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="text">{KIND_LABEL.text}</SelectItem>
                      <SelectItem value="command">{KIND_LABEL.command}</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                {draft.kind === "command" ? (
                  <Input
                    size="sm"
                    aria-label="Command"
                    placeholder="node holdout-status.js"
                    value={draft.command}
                    onChange={(event) => change("command", event.target.value)}
                  />
                ) : null}
                <Textarea
                  aria-label={draft.kind === "command" ? "What it proves" : "What to check"}
                  placeholder={
                    draft.kind === "command"
                      ? "What a passing run proves (optional)"
                      : "GET /health returns JSON with status ok"
                  }
                  value={draft.body}
                  onChange={(event) => change("body", event.target.value)}
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Time limit in minutes
                  <Input
                    size="sm"
                    className="w-16"
                    inputMode="numeric"
                    aria-label="Time limit in minutes"
                    value={draft.timeoutMinutes}
                    onChange={(event) => change("timeoutMinutes", event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {typeof parsed === "string" ? (
                    <span className="me-auto text-xs text-muted-foreground">{parsed}</span>
                  ) : null}
                  <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || typeof parsed === "string" || parsed === null}
                    onClick={() => {
                      if (parsed !== null && typeof parsed !== "string") void save(parsed);
                    }}
                  >
                    Save scenario
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </SettingsRow>
      {list.data !== null && scenarios.length === 0 && draft === null ? (
        <SettingsEmptyRow>No hidden scenarios yet.</SettingsEmptyRow>
      ) : null}
    </SettingsSection>
  );
}
