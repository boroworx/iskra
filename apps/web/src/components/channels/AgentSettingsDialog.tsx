import {
  DEFAULT_AGENT_BLUEPRINT,
  DEFAULT_AGENT_ROLES,
  type AgentBlueprint,
  type AgentDefinitionInput,
  type AgentId,
  type AgentRole,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RunCapability,
  projectOrchestrationOf,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { channelEnvironment } from "~/state/channels";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { DisabledReason } from "../cards/DisabledReason";
import { AgentModelPicker, AgentRunNote, useAgentRunRefusal } from "./AgentModelPicker";
import { toAgentName } from "./channels.logic";
import { SHEET_INPUT_CLASS, SHEET_TEXTAREA_CLASS, SheetGroup, SheetRow } from "./SheetList";

type SavedAgentDefinition = AgentDefinitionInput & { readonly id: AgentId };

const CAPABILITIES: ReadonlyArray<{ readonly value: RunCapability; readonly label: string }> = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "shell", label: "Shell" },
  { value: "network", label: "Network" },
];

/** The capabilities in their canonical order, as an agent file stores them. */
export const orderedCapabilities = (capabilities: ReadonlyArray<RunCapability>) =>
  CAPABILITIES.map((entry) => entry.value).filter((value) => capabilities.includes(value));

/** An agent's capability checkboxes. Shell needs write, so dropping write drops shell too. */
export function CapabilityFields(props: {
  readonly value: ReadonlyArray<RunCapability>;
  readonly onChange: (capabilities: ReadonlyArray<RunCapability>) => void;
  readonly disabled?: boolean;
}) {
  const toggle = (capability: RunCapability, checked: boolean) => {
    const next = checked
      ? [...props.value, capability]
      : props.value.filter((entry) => entry !== capability);
    props.onChange(next.includes("write") ? next : next.filter((entry) => entry !== "shell"));
  };
  return (
    <fieldset>
      <legend className="sr-only">Capabilities</legend>
      <SheetGroup
        title="Capabilities"
        footer="Card sessions only; conversations and DMs are always read-only. Shell needs write."
      >
        {CAPABILITIES.map((entry) => (
          <SheetRow key={entry.value} as="label" label={entry.label}>
            <Checkbox
              checked={props.value.includes(entry.value)}
              disabled={
                props.disabled === true ||
                (entry.value === "shell" && !props.value.includes("write"))
              }
              onCheckedChange={(checked) => toggle(entry.value, checked)}
            />
          </SheetRow>
        ))}
      </SheetGroup>
    </fieldset>
  );
}

/**
 * Network reaches only the project's allowed domains, so with none it reaches nothing; says so, and
 * where to add some, while the capability is on.
 */
export function NetworkReachNote(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly capabilities: ReadonlyArray<RunCapability>;
  readonly onNavigate?: () => void;
}) {
  const projects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const project = projects.find(
    (entry) => entry.environmentId === props.environmentId && entry.id === props.projectId,
  );
  if (project === undefined || !props.capabilities.includes("network")) return null;
  const { egress } = projectOrchestrationOf(project);
  if (egress.mode === "allowlist" && egress.allow.length > 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      This project allows no domains yet, so network reaches nothing. Agents can request access, or
      add domains in{" "}
      <Link
        to="/settings/projects"
        search={{ project: deriveLogicalProjectKeyFromSettings(project, grouping) }}
        hash="project-orchestration"
        className="text-primary hover:underline"
        {...(props.onNavigate === undefined ? {} : { onClick: props.onNavigate })}
      >
        Settings → Projects → {project.title} → Network for agent shells
      </Link>
      .
    </p>
  );
}

const ROLES: ReadonlyArray<{
  readonly value: AgentRole;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "builder", label: "Builder", hint: "Works on cards." },
  { value: "lead", label: "Lead", hint: "Turns channel requests into cards." },
  { value: "helper", label: "Helper", hint: "Answers a builder's questions." },
  { value: "critic", label: "Critic", hint: "Critiques specs and diffs." },
  { value: "verifier", label: "Verifier", hint: "Checks cards in review against their criteria." },
  {
    value: "coordinator",
    label: "Coordinator",
    hint: "Plans a plan card's children, read-only.",
  },
];

/** The roles in their canonical order, as an agent file stores them. */
const orderedRoles = (roles: ReadonlyArray<AgentRole>) =>
  ROLES.map((entry) => entry.value).filter((value) => roles.includes(value));

export const NO_ROLES_TEXT = "Give it at least one role.";

/** What an agent may run as. Each role is a separate run of the same agent. */
export function RoleFields(props: {
  readonly value: ReadonlyArray<AgentRole>;
  readonly onChange: (roles: ReadonlyArray<AgentRole>) => void;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Roles</legend>
      <SheetGroup title="Roles">
        {ROLES.map((entry) => (
          <SheetRow key={entry.value} as="label" label={entry.label} hint={entry.hint}>
            <Checkbox
              checked={props.value.includes(entry.value)}
              disabled={props.disabled === true}
              onCheckedChange={(checked) =>
                props.onChange(
                  orderedRoles(
                    checked
                      ? [...props.value, entry.value]
                      : props.value.filter((role) => role !== entry.value),
                  ),
                )
              }
            />
          </SheetRow>
        ))}
      </SheetGroup>
    </fieldset>
  );
}

const PREFLIGHT_LABEL: Record<AgentBlueprint["preflight"], string> = {
  none: "None",
  targeted: "Targeted checks first",
};
const UI_CAPTURE_LABEL: Record<AgentBlueprint["uiCapture"], string> = {
  auto: "When UI files change",
  always: "Always",
  never: "Never",
};
const VERIFY_LABEL: Record<AgentBlueprint["verify"], string> = {
  project: "As the project says",
  always: "Always",
};

function ChoiceField<K extends string>(props: {
  readonly label: string;
  readonly value: K;
  readonly labels: Record<K, string>;
  readonly onChange: (value: K) => void;
  readonly disabled?: boolean;
}) {
  const keys = Object.keys(props.labels) as K[];
  return (
    <SheetRow as="label" label={props.label}>
      <Select
        value={props.value}
        disabled={props.disabled === true}
        onValueChange={(value) => {
          const key = keys.find((entry) => entry === value);
          if (key !== undefined) props.onChange(key);
        }}
      >
        <SelectTrigger aria-label={props.label} className="w-auto min-w-44">
          <SelectValue>{(value: K | null) => props.labels[value ?? props.value]}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {keys.map((key) => (
            <SelectItem key={key} value={key}>
              {props.labels[key]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SheetRow>
  );
}

/** The steps this agent adds to its cards' blueprint. Each only adds work; none skips a check. */
function BlueprintFields(props: {
  readonly value: AgentBlueprint;
  readonly onChange: (blueprint: AgentBlueprint) => void;
  readonly disabled?: boolean;
}) {
  const set = <K extends keyof AgentBlueprint>(key: K, value: AgentBlueprint[K]) =>
    props.onChange({ ...props.value, [key]: value });
  const disabled = props.disabled === true;
  return (
    <fieldset>
      <legend className="sr-only">Blueprint</legend>
      <SheetGroup
        title="Blueprint"
        footer="These only add steps: checks, journeys and the scope judge always run."
      >
        <ChoiceField
          label="Preflight"
          value={props.value.preflight}
          labels={PREFLIGHT_LABEL}
          onChange={(value) => set("preflight", value)}
          disabled={disabled}
        />
        <ChoiceField
          label="Screenshots"
          value={props.value.uiCapture}
          labels={UI_CAPTURE_LABEL}
          onChange={(value) => set("uiCapture", value)}
          disabled={disabled}
        />
        <label className="flex flex-col gap-1 px-4 py-2 text-[13px] focus-within:bg-accent/40">
          <span>UI paths to screenshot, one per line</span>
          <Textarea
            unstyled
            className={SHEET_TEXTAREA_CLASS}
            rows={2}
            size="sm"
            disabled={disabled}
            placeholder="/settings"
            value={props.value.uiPaths.join("\n")}
            onChange={(event) =>
              set(
                "uiPaths",
                event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              )
            }
          />
        </label>
        <ChoiceField
          label="Verify its cards"
          value={props.value.verify}
          labels={VERIFY_LABEL}
          onChange={(value) => set("verify", value)}
          disabled={disabled}
        />
      </SheetGroup>
    </fieldset>
  );
}

const AUTOMATIC = "automatic";

/** Who verifies this agent's cards first: one of the project's verifiers, or Iskra's choice. */
function VerifyWithField(props: {
  readonly value: string | null;
  readonly verifiers: ReadonlyArray<string>;
  readonly onChange: (name: string | null) => void;
  readonly disabled?: boolean;
}) {
  // An agent file may name a verifier that no longer exists; keep it selectable so a save keeps it.
  const names =
    props.value !== null && !props.verifiers.includes(props.value)
      ? [...props.verifiers, props.value]
      : props.verifiers;
  return (
    <SheetGroup>
      <SheetRow
        as="label"
        label="Verified by"
        hint="Automatic prefers another provider, then another model."
      >
        <Select
          value={props.value ?? AUTOMATIC}
          disabled={props.disabled === true}
          onValueChange={(value) =>
            props.onChange(value === null || value === AUTOMATIC ? null : value)
          }
        >
          <SelectTrigger aria-label="Verified by" className="w-auto min-w-44">
            <SelectValue>
              {(value: string | null) =>
                value === null || value === AUTOMATIC ? "Automatic" : `@${value}`
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
            {names.map((name) => (
              <SelectItem key={name} value={name}>
                @{name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SheetRow>
    </SheetGroup>
  );
}

/** A project's agent definitions, archived ones included. Refresh after a save or archive. */
export function useAgentDefinitions(environmentId: EnvironmentId, projectId: ProjectId | null) {
  return useEnvironmentQuery(
    projectId === null
      ? null
      : channelEnvironment.agentDefinitions({ environmentId, input: { projectId } }),
  );
}

/**
 * Writes a definition back to its file: a save, an unarchive (saving an archived
 * agent's definition) or an archive's undo. Failures toast; resolves true on success.
 */
export function useSaveAgentDefinition(environmentId: EnvironmentId, projectId: ProjectId) {
  const save = useAtomCommand(channelEnvironment.saveAgentDefinition, { reportFailure: false });
  const definitions = useAgentDefinitions(environmentId, projectId);
  const refresh = definitions.refresh;
  return async (definition: AgentDefinitionInput, failureTitle: string) => {
    const result = await save({ environmentId, input: { projectId, definition } });
    toastCommandFailure(result, failureTitle, "Try again.");
    refresh();
    return result._tag === "Success";
  };
}

/**
 * An agent's settings as its `.iskra/agents` file holds them: name, model, role,
 * tags, capabilities, roles, verifier and blueprint, plus archive or unarchive.
 * Everything goes through the file, since the file sync reverts any other edit.
 */
export function AgentSettingsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
}) {
  const definitions = useAgentDefinitions(props.environmentId, props.open ? props.projectId : null);
  const agents = definitions.data?.agents;
  const entry = agents?.find((agent) => agent.definition.id === props.agentId);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        {entry === undefined ? (
          <DialogHeader>
            <DialogTitle>Agent settings</DialogTitle>
            <DialogDescription>
              {definitions.error ??
                (definitions.data === null ? "Loading…" : "This agent no longer exists.")}
            </DialogDescription>
          </DialogHeader>
        ) : (
          <AgentSettingsForm
            key={`${entry.definition.id}:${entry.archived}`}
            definition={entry.definition}
            archived={entry.archived}
            verifiers={(agents ?? [])
              .filter(
                (agent) =>
                  !agent.archived &&
                  agent.definition.id !== props.agentId &&
                  (agent.definition.roles ?? DEFAULT_AGENT_ROLES).includes("verifier"),
              )
              .map((agent) => agent.definition.name)}
            environmentId={props.environmentId}
            projectId={props.projectId}
            onClose={() => props.onOpenChange(false)}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function AgentSettingsForm(props: {
  readonly definition: SavedAgentDefinition;
  readonly archived: boolean;
  /** The project's other agents that can verify, by name. */
  readonly verifiers: ReadonlyArray<string>;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onClose: () => void;
}) {
  const saveDefinition = useSaveAgentDefinition(props.environmentId, props.projectId);
  const archiveDefinition = useAtomCommand(channelEnvironment.archiveAgentDefinition, {
    reportFailure: false,
  });
  const [name, setName] = useState(props.definition.name);
  const [model, setModel] = useState<ModelSelection>(props.definition.modelSelection);
  const [rolePrompt, setRolePrompt] = useState(props.definition.rolePrompt);
  const [tags, setTags] = useState(props.definition.tags.join(", "));
  const [capabilities, setCapabilities] = useState<ReadonlyArray<RunCapability>>(
    props.definition.capabilities,
  );
  const [roles, setRoles] = useState<ReadonlyArray<AgentRole>>(
    props.definition.roles ?? DEFAULT_AGENT_ROLES,
  );
  const [verifyWith, setVerifyWith] = useState(props.definition.verifyWith ?? null);
  const [blueprint, setBlueprint] = useState<AgentBlueprint>(
    props.definition.blueprint ?? DEFAULT_AGENT_BLUEPRINT,
  );
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const agentName = toAgentName(name);
  const run = useAgentRunRefusal(props.environmentId, model, capabilities);
  const blocked =
    agentName.length === 0 ? "Give it a name." : roles.length === 0 ? NO_ROLES_TEXT : run.refusal;

  const save = async () => {
    if (blocked !== null || busy) {
      return;
    }
    setBusy(true);
    const saved = await saveDefinition(
      {
        ...props.definition,
        name: agentName,
        modelSelection: model,
        rolePrompt: rolePrompt.trim(),
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0),
        capabilities: orderedCapabilities(capabilities),
        roles,
        verifyWith,
        blueprint,
      },
      "Agent not saved",
    );
    setBusy(false);
    if (saved) {
      props.onClose();
    }
  };

  const unarchive = async () => {
    setBusy(true);
    const saved = await saveDefinition(props.definition, "Agent not unarchived");
    setBusy(false);
    if (saved) {
      props.onClose();
    }
  };

  const archive = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `Archive @${props.definition.name}?\nIts file in .iskra/agents is deleted. You can unarchive it from Archived agents in the sidebar.`,
        { variant: "destructive" },
      )) ?? true;
    if (!confirmed) {
      return;
    }
    setBusy(true);
    const result = await archiveDefinition({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, agentId: props.definition.id },
    });
    setBusy(false);
    toastCommandFailure(result, "Agent not archived", "Try again.");
    if (result._tag !== "Success") {
      return;
    }
    // Undo writes the definition as it was before archiving.
    const captured = props.definition;
    toastManager.add({
      type: "success",
      title: `Archived @${captured.name}`,
      actionProps: {
        children: "Undo",
        onClick: () => void saveDefinition(captured, "Agent not unarchived"),
      },
    });
    props.onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>@{props.definition.name}</DialogTitle>
        <DialogDescription>
          {props.archived
            ? "This agent is archived. Unarchive it to message it, mention it or give it cards."
            : "Saved to its file in .iskra/agents."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={props.archived} className="flex flex-col gap-5">
            <SheetGroup>
              <SheetRow as="label" label="Name">
                <Input
                  unstyled
                  className={SHEET_INPUT_CLASS}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </SheetRow>
              <SheetRow label="Model">
                <AgentModelPicker
                  environmentId={props.environmentId}
                  value={model}
                  onChange={setModel}
                  disabled={props.archived}
                />
              </SheetRow>
              <SheetRow as="label" label="Tags">
                <Input
                  unstyled
                  className={SHEET_INPUT_CLASS}
                  placeholder="backend, api"
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                />
              </SheetRow>
            </SheetGroup>
            <SheetGroup title="Role">
              <label className="block px-4 py-2 focus-within:bg-accent/40">
                <span className="sr-only">Role</span>
                <Textarea
                  unstyled
                  className={SHEET_TEXTAREA_CLASS}
                  rows={4}
                  size="sm"
                  value={rolePrompt}
                  onChange={(event) => setRolePrompt(event.target.value)}
                />
              </label>
            </SheetGroup>
            <RoleFields value={roles} onChange={setRoles} disabled={props.archived} />
            <div className="flex flex-col gap-1.5 [&>p]:px-4">
              <CapabilityFields
                value={capabilities}
                onChange={setCapabilities}
                disabled={props.archived}
              />
              <AgentRunNote driver={run.driver} refusal={run.refusal} />
              <NetworkReachNote
                environmentId={props.environmentId}
                projectId={props.projectId}
                capabilities={capabilities}
                onNavigate={props.onClose}
              />
            </div>
            {roles.includes("builder") ? (
              <>
                <VerifyWithField
                  value={verifyWith}
                  verifiers={props.verifiers}
                  onChange={setVerifyWith}
                  disabled={props.archived}
                />
                <BlueprintFields
                  value={blueprint}
                  onChange={setBlueprint}
                  disabled={props.archived}
                />
              </>
            ) : null}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        {props.archived ? (
          <Button type="button" disabled={busy} onClick={() => void unarchive()}>
            Unarchive
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive-foreground sm:mr-auto"
              disabled={busy}
              onClick={() => void archive()}
            >
              Archive
            </Button>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <DisabledReason reason={blocked}>
              <Button type="submit" form={formId} disabled={blocked !== null || busy}>
                Save
              </Button>
            </DisabledReason>
          </>
        )}
      </DialogFooter>
    </>
  );
}
