import { ChannelId, type AgentId, type EnvironmentId, type ProjectId } from "@iskra/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
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
import { toChannelName } from "./channels.logic";
import { SHEET_INPUT_CLASS, SheetGroup, SheetRow } from "./SheetList";

/** Creates a channel every agent of the project joins, then opens it. */
export function CreateChannelDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly memberAgentIds: ReadonlyArray<AgentId>;
}) {
  const navigate = useNavigate();
  const createChannel = useAtomCommand(channelEnvironment.create);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const formId = useId();
  const channelName = toChannelName(name);

  const submit = async () => {
    if (channelName.length === 0 || creating) {
      return;
    }
    setCreating(true);
    const channelId = ChannelId.make(randomUUID());
    const result = await createChannel({
      environmentId: props.environmentId,
      input: {
        channelId,
        projectId: props.projectId,
        kind: "channel",
        name: channelName,
        memberAgentIds: [...props.memberAgentIds],
      },
    });
    setCreating(false);
    if (result._tag !== "Success") {
      return;
    }
    setName("");
    props.onOpenChange(false);
    void navigate({
      to: "/channels/$environmentId/$channelId",
      params: { environmentId: props.environmentId, channelId },
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
          <DialogDescription>
            A separate topic with its own lead, or a room for several agents. Most projects only
            need Requests.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SheetGroup
              footer={
                channelName.length > 0
                  ? `Shows as #${channelName}`
                  : "Lower case, words joined by dashes."
              }
            >
              <SheetRow as="label" label="Name">
                <Input
                  unstyled
                  aria-label="Channel name"
                  placeholder="general"
                  autoFocus
                  className={SHEET_INPUT_CLASS}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </SheetRow>
            </SheetGroup>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={channelName.length === 0 || creating}>
            Create channel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
