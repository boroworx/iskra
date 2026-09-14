import { CARD_PRIORITIES, CARD_PRIORITY_LABEL } from "@iskra/client-runtime/cards";
import {
  CardId,
  type CardPriority,
  type ChannelId,
  type EnvironmentId,
  type ProjectId,
} from "@iskra/contracts";
import { useId, useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastCommandFailure } from "../toastCommandFailure";

const NO_CHANNEL = "none";

/** A person's new card, straight to Triage; `onCreated` gets its id so the board can open it. */
export function NewCardDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onCreated: (cardId: CardId) => void;
}) {
  const create = useAtomCommand(cardEnvironment.create);
  const update = useAtomCommand(cardEnvironment.update);
  const allChannels = useEnvironmentChannels(props.environmentId);
  const channels = useMemo(
    () =>
      allChannels.filter(
        (channel) => channel.projectId === props.projectId && channel.kind === "channel",
      ),
    [allChannels, props.projectId],
  );
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [channelId, setChannelId] = useState<string>(NO_CHANNEL);
  const [priority, setPriority] = useState<CardPriority>(0);
  const [creating, setCreating] = useState(false);
  const formId = useId();
  const trimmedTitle = title.trim();

  const submit = async () => {
    if (trimmedTitle.length === 0 || creating) {
      return;
    }
    setCreating(true);
    const cardId = CardId.make(randomUUID());
    const result = await create({
      environmentId: props.environmentId,
      input: {
        cardId,
        projectId: props.projectId,
        title: trimmedTitle,
        spec,
        tags: [],
        channelId: channelId === NO_CHANNEL ? null : (channelId as ChannelId),
      },
    });
    if (result._tag === "Success" && priority !== 0) {
      toastCommandFailure(
        await update({ environmentId: props.environmentId, input: { cardId, priority } }),
        "The card was created without its priority",
        "Setting the priority was refused.",
      );
    }
    setCreating(false);
    toastCommandFailure(result, "The card was not created", "The request was refused.");
    if (result._tag !== "Success") {
      return;
    }
    setTitle("");
    setSpec("");
    setChannelId(NO_CHANNEL);
    setPriority(0);
    props.onOpenChange(false);
    props.onCreated(cardId);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>
            It starts in Triage. Approve it, then assign an agent to start the work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              aria-label="Title"
              placeholder="Title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              aria-label="Spec"
              placeholder="What should be built, and how you will know it is done (optional)"
              value={spec}
              onChange={(event) => setSpec(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Select
                value={channelId}
                onValueChange={(value) => setChannelId(value ?? NO_CHANNEL)}
              >
                <SelectTrigger aria-label="Channel" className="w-auto min-w-40">
                  <SelectValue>
                    {(value: string | null) =>
                      value === null || value === NO_CHANNEL
                        ? "No channel"
                        : `#${channels.find((channel) => channel.id === value)?.name ?? ""}`
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NO_CHANNEL}>No channel</SelectItem>
                  {channels.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={String(priority)}
                onValueChange={(value) => setPriority(Number(value ?? 0) as CardPriority)}
              >
                <SelectTrigger aria-label="Priority" className="w-auto min-w-32">
                  <SelectValue>
                    {(value: string | null) =>
                      CARD_PRIORITY_LABEL[Number(value ?? 0) as CardPriority]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {CARD_PRIORITIES.map((entry) => (
                    <SelectItem key={entry} value={String(entry)}>
                      {CARD_PRIORITY_LABEL[entry]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={trimmedTitle.length === 0 || creating}>
            Create card
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
