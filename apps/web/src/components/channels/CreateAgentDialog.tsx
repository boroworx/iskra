import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { AgentId, ChannelId, type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
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
import { toAgentName } from "./channels.logic";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/**
 * The model a new agent runs on. Agent runs are read-only and only the Claude
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

/** Creates an agent, adds it to the project's channels, and opens its DM. */
export function CreateAgentDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: EnvironmentProject;
}) {
  const { environmentId, id: projectId } = props.project;
  const navigate = useNavigate();
  const providers = useServerConfigs().get(environmentId)?.providers ?? EMPTY_PROVIDERS;
  const channels = useEnvironmentChannels(environmentId);
  const createAgent = useAtomCommand(channelEnvironment.createAgent);
  const createChannel = useAtomCommand(channelEnvironment.create);
  const updateChannel = useAtomCommand(channelEnvironment.update);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [creating, setCreating] = useState(false);
  const agentName = toAgentName(name);
  const modelSelection = resolveAgentModelSelection(providers, props.project.defaultModelSelection);

  const submit = async () => {
    if (agentName.length === 0 || modelSelection === null || creating) {
      return;
    }
    setCreating(true);
    const agentId = AgentId.make(randomUUID());
    const created = await createAgent({
      environmentId,
      input: {
        agentId,
        projectId,
        name: agentName,
        roleTags: [],
        rolePrompt: role.trim(),
        modelSelection,
        capabilities: ["read"],
      },
    });
    if (created._tag !== "Success") {
      setCreating(false);
      return;
    }
    for (const channel of channels) {
      if (channel.projectId !== projectId || channel.kind !== "channel") {
        continue;
      }
      await updateChannel({
        environmentId,
        input: { channelId: channel.id, memberAgentIds: [...channel.memberAgentIds, agentId] },
      });
    }
    const dmChannelId = ChannelId.make(randomUUID());
    const dm = await createChannel({
      environmentId,
      input: {
        channelId: dmChannelId,
        projectId,
        kind: "dm",
        name: `dm-${agentName}`,
        memberAgentIds: [agentId],
      },
    });
    setCreating(false);
    setName("");
    setRole("");
    props.onOpenChange(false);
    if (dm._tag === "Success") {
      void navigate({
        to: "/channels/$environmentId/$channelId",
        params: { environmentId, channelId: dmChannelId },
      });
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              It joins every channel in this project and replies when you mention it. For now,
              agents can read the code but not change it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
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
              placeholder="What it owns and how it should answer, e.g. Owns the server. Answers API questions."
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
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={agentName.length === 0 || modelSelection === null || creating}
            >
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
