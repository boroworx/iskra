import {
  AgentId,
  type EnvironmentId,
  type OrchestrationChannelShell,
} from "@iskra/contracts";
import { useId, useMemo, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentAgents } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { toastManager } from "../ui/toast";
import { agentListEntries, leadCandidates, toChannelName } from "./channels.logic";
import { PresenceBadge } from "./ChannelView";

const NO_LEAD = "none";

/**
 * A channel's name, topic, members and lead, plus archive. Opens from the
 * channel header and its sidebar row; on narrow screens it is where members
 * and the lead are seen.
 */
export function ChannelSettingsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly channel: OrchestrationChannelShell;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <ChannelSettingsForm
          key={props.channel.id}
          environmentId={props.environmentId}
          channel={props.channel}
          onClose={() => props.onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ChannelSettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: OrchestrationChannelShell;
  readonly onClose: () => void;
}) {
  const { environmentId, channel } = props;
  const agents = useEnvironmentAgents(environmentId);
  const projectAgents = useMemo(
    () => agentListEntries(agents, channel.projectId),
    [agents, channel.projectId],
  );
  const leadAgents = useMemo(
    () => leadCandidates(agents, channel.projectId, channel.leadAgentId),
    [agents, channel.projectId, channel.leadAgentId],
  );
  const update = useAtomCommand(channelEnvironment.update);
  const archive = useAtomCommand(channelEnvironment.archive);
  const unarchive = useAtomCommand(channelEnvironment.unarchive);
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [memberIds, setMemberIds] = useState<ReadonlyArray<AgentId>>(channel.memberAgentIds);
  const [leadId, setLeadId] = useState<AgentId | null>(channel.leadAgentId);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const channelName = toChannelName(name);

  const save = async () => {
    if (channelName.length === 0 || busy) {
      return;
    }
    setBusy(true);
    const result = await update({
      environmentId,
      input: {
        channelId: channel.id,
        name: channelName,
        topic: topic.trim(),
        memberAgentIds: [...memberIds],
        leadAgentId: leadId,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      props.onClose();
    }
  };

  const archiveChannel = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `Archive #${channel.name}?\nIt leaves the sidebar and takes no new messages. Undo right after, or unarchive it from its page.`,
        { variant: "destructive" },
      )) ?? true;
    if (!confirmed) {
      return;
    }
    setBusy(true);
    const result = await archive({ environmentId, input: { channelId: channel.id } });
    setBusy(false);
    if (result._tag !== "Success") {
      return;
    }
    toastManager.add({
      type: "success",
      title: `Archived #${channel.name}`,
      actionProps: {
        children: "Undo",
        onClick: () => void unarchive({ environmentId, input: { channelId: channel.id } }),
      },
    });
    props.onClose();
  };

  const leadName = (value: string | null) =>
    value === null || value === NO_LEAD
      ? "No lead"
      : `@${projectAgents.find((agent) => agent.id === value)?.name ?? value}`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>#{channel.name}</DialogTitle>
        <DialogDescription>Agents here reply when you @mention them.</DialogDescription>
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
          <label className="block space-y-1.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Topic</span>
            <Input
              placeholder="What this channel is for"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          </label>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-muted-foreground">Lead</span>
            <Select
              value={leadId ?? NO_LEAD}
              onValueChange={(value) =>
                setLeadId(value === null || value === NO_LEAD ? null : AgentId.make(value))
              }
            >
              <SelectTrigger aria-label="Channel lead">
                <SelectValue>{leadName}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_LEAD}>No lead</SelectItem>
                {leadAgents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    @{agent.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              The lead reads unaddressed messages and turns them into cards.
            </p>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">Members</legend>
            {projectAgents.length === 0 ? (
              <p className="text-sm text-muted-foreground">This project has no agents yet.</p>
            ) : (
              <ul role="list" className="flex flex-col gap-1">
                {projectAgents.map((agent) => (
                  <li key={agent.id}>
                    <label className="flex h-7 items-center gap-2 text-sm">
                      <Checkbox
                        checked={memberIds.includes(agent.id)}
                        onCheckedChange={(checked) =>
                          setMemberIds((current) =>
                            checked
                              ? [...current, agent.id]
                              : current.filter((id) => id !== agent.id),
                          )
                        }
                      />
                      <span className="truncate">@{agent.name}</span>
                      <PresenceBadge presence={agent.presence} className="ml-auto" />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter>
        <Button
          type="button"
          variant="destructive-outline"
          className="sm:mr-auto"
          disabled={busy}
          onClick={() => void archiveChannel()}
        >
          Archive
        </Button>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={channelName.length === 0 || busy}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
