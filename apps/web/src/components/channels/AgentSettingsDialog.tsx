import {
  type AgentDefinitionInput,
  type AgentId,
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { AgentModelPicker } from "./AgentModelPicker";
import { toAgentName } from "./channels.logic";

type SavedAgentDefinition = AgentDefinitionInput & { readonly id: AgentId };

const CAPABILITIES: ReadonlyArray<{ readonly value: RunCapability; readonly label: string }> = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "shell", label: "Shell" },
  { value: "network", label: "Network" },
];

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
 * tags and capabilities, plus archive or unarchive. Everything goes through the
 * file, since the file sync reverts any other edit.
 */
export function AgentSettingsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
}) {
  const definitions = useAgentDefinitions(props.environmentId, props.open ? props.projectId : null);
  const entry = definitions.data?.agents.find((agent) => agent.definition.id === props.agentId);
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
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const agentName = toAgentName(name);

  const toggleCapability = (capability: RunCapability, checked: boolean) =>
    setCapabilities((current) => {
      const next = checked
        ? [...current, capability]
        : current.filter((entry) => entry !== capability);
      // Shell needs write: dropping write drops shell too.
      return next.includes("write") ? next : next.filter((entry) => entry !== "shell");
    });

  const save = async () => {
    if (agentName.length === 0 || busy) {
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
        capabilities: CAPABILITIES.map((entry) => entry.value).filter((value) =>
          capabilities.includes(value),
        ),
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
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">Capabilities</span>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {CAPABILITIES.map((entry) => (
                  <label key={entry.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={capabilities.includes(entry.value)}
                      disabled={
                        props.archived || (entry.value === "shell" && !capabilities.includes("write"))
                      }
                      onCheckedChange={(checked) => toggleCapability(entry.value, checked)}
                    />
                    {entry.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Card sessions only; conversations and DMs are always read-only. Shell needs write.
              </p>
            </div>
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
            <Button type="submit" form={formId} disabled={agentName.length === 0 || busy}>
              Save
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
