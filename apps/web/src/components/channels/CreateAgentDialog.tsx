import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { AgentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import { useId, useState } from "react";

import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
} from "~/providerInstances";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentChannels, useServerConfigs } from "~/state/entities";
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
import { toAgentName } from "./channels.logic";
import { useOpenAgentDm } from "./useOpenAgentDm";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * The model a new agent runs on. Channel runs are read-only and only the Claude
 * adapter enforces that, so agents use Claude: the project's default model when
 * it is a Claude one, otherwise the first available Claude instance's default.
 */
function resolveAgentModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  projectDefault: ModelSelection | null,
): ModelSelection | null {
  const claudeEntries = deriveProviderInstanceEntries(providers).filter(
    (entry) => entry.driverKind === "claudeAgent" && entry.enabled && entry.installed,
  );
  if (
    projectDefault !== null &&
    claudeEntries.some((entry) => entry.instanceId === projectDefault.instanceId)
  ) {
    return projectDefault;
  }
  for (const entry of claudeEntries) {
    const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
    if (model !== undefined) {
      return { instanceId: entry.instanceId, model };
    }
  }
  return null;
}

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
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_PROVIDERS;
  const channels = useEnvironmentChannels(environmentId);
  const saveAgentDefinition = useAtomCommand(channelEnvironment.saveAgentDefinition);
  const importAgentDefinitions = useAtomCommand(channelEnvironment.importAgentDefinitions);
  const updateChannel = useAtomCommand(channelEnvironment.update);
  const openAgentDm = useOpenAgentDm();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const agentName = toAgentName(name);
  const modelSelection = resolveAgentModelSelection(providers, props.project.defaultModelSelection);

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
          capabilities: ["read"],
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
    props.onOpenChange(false);
    void openAgentDm(environmentId, { id: agentId, projectId, name: agentName, modelSelection });
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
              <p className="text-xs text-muted-foreground">Runs on {modelSelection.model}</p>
            )}
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
