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
} from "@iskra/contracts";
import { useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { channelEnvironment } from "~/state/channels";
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
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">Capabilities</span>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {CAPABILITIES.map((entry) => (
          <label key={entry.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={props.value.includes(entry.value)}
              disabled={
                props.disabled === true ||
                (entry.value === "shell" && !props.value.includes("write"))
              }
              onCheckedChange={(checked) => toggle(entry.value, checked)}
            />
            {entry.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Card sessions only; conversations and DMs are always read-only. Shell needs write.
      </p>
    </div>
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
    <fieldset className="space-y-1.5">
      <legend className="block text-xs font-medium text-muted-foreground">Roles</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {ROLES.map((entry) => (
          <label key={entry.value} className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
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
            <span className="flex flex-col">
              {entry.label}
              <span className="text-xs text-muted-foreground">{entry.hint}</span>
            </span>
          </label>
        ))}
      </div>
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
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
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
    </label>
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
    <fieldset className="space-y-2">
      <legend className="block text-xs font-medium text-muted-foreground">Blueprint</legend>
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
      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">
          UI paths to screenshot, one per line
        </span>
        <Textarea
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
      <p className="text-xs text-muted-foreground">
        These only add steps: checks, journeys and the scope judge always run.
      </p>
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
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="flex flex-col">
        <span className="text-xs font-medium text-muted-foreground">Verified by</span>
        <span className="text-xs text-muted-foreground">
          Automatic prefers another provider, then another model.
        </span>
      </span>
      <Select
        value={props.value ?? AUTOMATIC}
        disabled={props.disabled === true}
        onValueChange={(value) => props.onChange(value === null || value === AUTOMATIC ? null : value)}
      >
        <SelectTrigger aria-label="Verified by" className="w-auto min-w-44">
          <SelectValue>
            {(value: string | null) => (value === null || value === AUTOMATIC ? "Automatic" : `@${value}`)}
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
    </label>
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
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={props.archived} className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">Model</span>
              <AgentModelPicker
                environmentId={props.environmentId}
                value={model}
                onChange={setModel}
                disabled={props.archived}
              />
            </div>
            <label className="block space-y-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Role</span>
              <Textarea
                rows={4}
                size="sm"
                value={rolePrompt}
                onChange={(event) => setRolePrompt(event.target.value)}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Tags</span>
              <Input
                placeholder="backend, api"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </label>
            <RoleFields value={roles} onChange={setRoles} disabled={props.archived} />
            <div className="space-y-1.5">
              <CapabilityFields
                value={capabilities}
                onChange={setCapabilities}
                disabled={props.archived}
              />
              <AgentRunNote driver={run.driver} refusal={run.refusal} />
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
      <DialogFooter>
        {props.archived ? (
          <Button type="button" disabled={busy} onClick={() => void unarchive()}>
            Unarchive
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="destructive-outline"
              className="sm:mr-auto"
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
