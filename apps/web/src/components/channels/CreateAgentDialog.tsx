import type { EnvironmentProject } from "@iskra/client-runtime/state/models";
import type { AgentId, ModelSelection, RunCapability } from "@iskra/contracts";
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
import {
  AgentModelPicker,
  resolveAgentModelSelection,
  useEnvironmentProviders,
} from "./AgentModelPicker";
import { CapabilityFields, orderedCapabilities } from "./AgentSettingsDialog";
import { toAgentName } from "./channels.logic";

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
  const modelSelection =
    chosenModel ?? resolveAgentModelSelection(providers, props.project.defaultModelSelection);

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
    if (agentName.length === 0 || modelSelection === null || busy) {
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
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1.5">
              <Input
                aria-label="Agent name"
                placeholder="backend"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {agentName.length > 0
                  ? `Mention it as @${agentName}`
                  : "Lower-case letters, digits and dashes."}
              </p>
            </div>
            <Textarea
              aria-label="Role"
              placeholder="What it owns and how it should work, e.g. Owns the server. Answers API questions."
              rows={3}
              size="sm"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
            {modelSelection === null ? (
              <p className="text-sm text-destructive-foreground">
                Agents need Claude. Turn on a Claude provider in Settings, Providers.
              </p>
            ) : (
              <AgentModelPicker
                environmentId={environmentId}
                value={modelSelection}
                onChange={setChosenModel}
              />
            )}
            <CapabilityFields value={capabilities} onChange={setCapabilities} />
          </form>
        </DialogPanel>
        <DialogFooter>
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
          <Button
            type="submit"
            form={formId}
            disabled={agentName.length === 0 || modelSelection === null || busy}
          >
            Create agent
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
