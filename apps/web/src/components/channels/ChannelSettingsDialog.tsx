import { AgentId, type EnvironmentId, type OrchestrationChannelShell } from "@iskra/contracts";
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
import { AgentAvatar } from "../iskra/AgentAvatar";
import { PresenceBadge } from "./ChannelView";
import { SHEET_INPUT_CLASS, SheetGroup, SheetRow } from "./SheetList";

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
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <SheetGroup>
            <SheetRow as="label" label="Name">
              <Input
                unstyled
                className={SHEET_INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </SheetRow>
            <SheetRow as="label" label="Topic">
              <Input
                unstyled
                className={SHEET_INPUT_CLASS}
                placeholder="What this channel is for"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
              />
            </SheetRow>
          </SheetGroup>
          <SheetGroup footer="The lead reads unaddressed messages and turns them into cards.">
            <SheetRow label="Lead">
              <Select
                value={leadId ?? NO_LEAD}
                onValueChange={(value) =>
                  setLeadId(value === null || value === NO_LEAD ? null : AgentId.make(value))
                }
              >
                <SelectTrigger aria-label="Channel lead" className="w-auto min-w-40">
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
            </SheetRow>
          </SheetGroup>
          <fieldset>
            <legend className="sr-only">Members</legend>
            <SheetGroup title="Members">
              {projectAgents.length === 0 ? (
                <p className="flex min-h-11 items-center px-4 text-[13px] text-muted-foreground">
                  This project has no agents yet.
                </p>
              ) : (
                projectAgents.map((agent) => (
                  <SheetRow
                    key={agent.id}
                    as="label"
                    label={
                      <span className="flex min-w-0 items-center gap-2.5">
                        <AgentAvatar name={agent.name} size="md" />
                        <span className="truncate">@{agent.name}</span>
                      </span>
                    }
                  >
                    <PresenceBadge presence={agent.presence} />
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
                  </SheetRow>
                ))
              )}
            </SheetGroup>
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button
          type="button"
          variant="ghost"
          className="text-destructive-foreground sm:mr-auto"
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
