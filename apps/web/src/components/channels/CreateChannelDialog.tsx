import { ChannelId, type AgentId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>
              Every agent in this project joins it. Agents only reply when you mention them.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Channel name"
              placeholder="general"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={channelName.length === 0 || creating}>
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
