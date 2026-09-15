import { CARD_PRIORITIES, CARD_PRIORITY_LABEL } from "@iskra/client-runtime/cards";
import {
  CardId,
  type CardKind,
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
import { DisabledReason } from "./DisabledReason";

const NO_CHANNEL = "none";

const KIND_LABEL: Record<CardKind, string> = {
  task: "Task",
  plan: "Plan",
  migration: "Migration",
};

const KIND_HINT: Record<CardKind, string> = {
  task: "It starts in Triage. Approve it, then assign an agent to start the work.",
  plan: "It starts in Triage. Once approved with a coordinator, the coordinator proposes child cards for you to approve.",
  migration:
    "It starts in Triage. Once approved, a script lists the items, a few are tried first, and you tune the instructions before the rest are swept.",
};

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
  const [kind, setKind] = useState<CardKind>("task");
  const [enumerateCommand, setEnumerateCommand] = useState("");
  const [instructions, setInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const formId = useId();
  const trimmedTitle = title.trim();
  const blocked =
    trimmedTitle.length === 0
      ? "Give the card a title."
      : kind === "migration" && enumerateCommand.trim().length === 0
        ? "A migration needs the command that lists its items."
        : null;

  const submit = async () => {
    if (blocked !== null || creating) {
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
        ...(kind === "task" ? {} : { kind }),
        ...(kind === "migration"
          ? { migration: { enumerateCommand: enumerateCommand.trim(), instructions } }
          : {}),
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
    setKind("task");
    setEnumerateCommand("");
    setInstructions("");
    props.onOpenChange(false);
    props.onCreated(cardId);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>{KIND_HINT[kind]}</DialogDescription>
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
            {kind === "migration" ? (
              <>
                <Input
                  aria-label="Command that lists the items"
                  placeholder="Command that prints one item per line, such as git ls-files 'src/**/*.test.js'"
                  value={enumerateCommand}
                  onChange={(event) => setEnumerateCommand(event.target.value)}
                />
                <Textarea
                  aria-label="Instructions for each item"
                  placeholder="What to do to each item"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value === "task" || value === "plan" || value === "migration") setKind(value);
                }}
              >
                <SelectTrigger aria-label="Kind" className="w-auto min-w-32">
                  <SelectValue>
                    {(value: CardKind | null) => KIND_LABEL[value ?? "task"]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(Object.keys(KIND_LABEL) as CardKind[]).map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {KIND_LABEL[entry]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
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
          <DisabledReason reason={trimmedTitle.length === 0 ? null : blocked}>
            <Button type="submit" form={formId} disabled={blocked !== null || creating}>
              Create card
            </Button>
          </DisabledReason>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
