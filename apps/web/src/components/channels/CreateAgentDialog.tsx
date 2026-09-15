import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import {
  DEFAULT_AGENT_ROLES,
  type AgentId,
  type AgentRole,
  type ModelSelection,
  type RunCapability,
} from "@iskra/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { channelEnvironment } from "~/state/channels";
import { useEnvironmentChannels } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { DisabledReason } from "../cards/DisabledReason";
import {
  AgentModelPicker,
  AgentRunNote,
  resolveAgentModelSelection,
  useAgentRunRefusal,
  useEnvironmentProviders,
} from "./AgentModelPicker";
import {
  CapabilityFields,
  NO_ROLES_TEXT,
  RoleFields,
  orderedCapabilities,
} from "./AgentSettingsDialog";
import { toAgentName } from "./channels.logic";
import { SHEET_INPUT_CLASS, SHEET_TEXTAREA_CLASS, SheetGroup, SheetRow } from "./SheetList";

const NO_PROVIDER_TEXT =
  "No provider that can run agents is on. Turn on Claude or OpenCode in Settings, Providers.";

// An agent is usually made to build, so card sessions can change files and run commands; network stays off.
const NEW_AGENT_CAPABILITIES: ReadonlyArray<RunCapability> = ["read", "write", "shell"];

/**
 * Creates an agent by writing its file to `.iskra/agents`, or imports agents
 * defined for Claude Code or Copilot, adds them to the project's channels, and
 * opens a new agent's DM.
 */
export function CreateAgentDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: EnvironmentProject;
}) {
  const { environmentId, id: projectId } = props.project;
  const providers = useEnvironmentProviders(environmentId);
  const channels = useEnvironmentChannels(environmentId);
  const saveAgentDefinition = useAtomCommand(channelEnvironment.saveAgentDefinition);
  const importAgentDefinitions = useAtomCommand(channelEnvironment.importAgentDefinitions);
  const updateChannel = useAtomCommand(channelEnvironment.update);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const agentName = toAgentName(name);
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(null);
  const [capabilities, setCapabilities] =
    useState<ReadonlyArray<RunCapability>>(NEW_AGENT_CAPABILITIES);
  const [roles, setRoles] = useState<ReadonlyArray<AgentRole>>(DEFAULT_AGENT_ROLES);
  const modelSelection =
    chosenModel ?? resolveAgentModelSelection(providers, props.project.defaultModelSelection);
  const run = useAgentRunRefusal(environmentId, modelSelection, capabilities);
  const blocked =
    agentName.length === 0
      ? "Give it a name."
      : modelSelection === null
        ? NO_PROVIDER_TEXT
        : roles.length === 0
          ? NO_ROLES_TEXT
          : run.refusal;

  const joinChannels = async (agentIds: ReadonlyArray<AgentId>) => {
    for (const channel of channels) {
      if (channel.projectId !== projectId || channel.kind !== "channel") {
        continue;
      }
      await updateChannel({
        environmentId,
        input: { channelId: channel.id, memberAgentIds: [...channel.memberAgentIds, ...agentIds] },
      });
    }
  };

  const submit = async () => {
    if (blocked !== null || modelSelection === null || busy) {
      return;
    }
    setBusy(true);
    const saved = await saveAgentDefinition({
      environmentId,
      input: {
        projectId,
        definition: {
          id: null,
          name: agentName,
          avatar: null,
          tags: [],
          modelSelection,
          capabilities: orderedCapabilities(capabilities),
          roles,
          rolePrompt: role.trim(),
        },
      },
    });
    if (saved._tag !== "Success") {
      setBusy(false);
      return;
    }
    const { agentId } = saved.value;
    await joinChannels([agentId]);
    setBusy(false);
    setName("");
    setRole("");
    setChosenModel(null);
    setCapabilities(NEW_AGENT_CAPABILITIES);
    setRoles(DEFAULT_AGENT_ROLES);
    props.onOpenChange(false);
    void navigate({ to: "/agents/$environmentId/$agentId", params: { environmentId, agentId } });
  };

  const importAgents = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    const result = await importAgentDefinitions({ environmentId, input: { projectId } });
    if (result._tag !== "Success") {
      setBusy(false);
      return;
    }
    const { imported, skipped } = result.value;
    await joinChannels(imported.map((agent) => agent.agentId));
    setBusy(false);
    toastManager.add({
      type: imported.length > 0 ? "success" : "warning",
      title:
        imported.length > 0
          ? `Imported ${imported.map((agent) => `@${agent.name}`).join(", ")}`
          : "No agents to import",
      description:
        skipped.length > 0
          ? skipped.map((entry) => `${entry.file}: ${entry.reason}`).join("\n")
          : "Looked in .claude/agents and .github/agents.",
    });
    if (imported.length > 0) {
      props.onOpenChange(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            It joins every channel in this project and answers there when you mention it. It is
            saved to .iskra/agents in the repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SheetGroup
              footer={
                agentName.length > 0
                  ? `Mention it as @${agentName}`
                  : "Lower-case letters, digits and dashes."
              }
            >
              <SheetRow as="label" label="Name">
                <Input
                  unstyled
                  aria-label="Agent name"
                  placeholder="backend"
                  autoFocus
                  className={SHEET_INPUT_CLASS}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </SheetRow>
              {modelSelection === null ? null : (
                <SheetRow label="Model">
                  <AgentModelPicker
                    environmentId={environmentId}
                    value={modelSelection}
                    onChange={setChosenModel}
                  />
                </SheetRow>
              )}
            </SheetGroup>
            {modelSelection === null ? (
              <p className="px-4 text-sm text-destructive-foreground">{NO_PROVIDER_TEXT}</p>
            ) : null}
            <SheetGroup title="Role">
              <div className="px-4 py-2 focus-within:bg-accent/40">
                <Textarea
                  unstyled
                  aria-label="Role"
                  placeholder="What it owns and how it should work, e.g. Owns the server. Answers API questions."
                  className={SHEET_TEXTAREA_CLASS}
                  rows={3}
                  size="sm"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                />
              </div>
            </SheetGroup>
            <RoleFields value={roles} onChange={setRoles} />
            <div className="flex flex-col gap-1.5 [&>p]:px-4">
              <CapabilityFields value={capabilities} onChange={setCapabilities} />
              <AgentRunNote driver={run.driver} refusal={run.refusal} />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            type="button"
            variant="ghost"
            className="sm:mr-auto"
            disabled={busy}
            onClick={() => void importAgents()}
          >
            Import existing agents
          </Button>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <DisabledReason reason={agentName.length === 0 ? null : blocked}>
            <Button type="submit" form={formId} disabled={blocked !== null || busy}>
              Create agent
            </Button>
          </DisabledReason>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
