import { CARD_PRIORITIES, CARD_PRIORITY_LABEL } from "@iskra/client-runtime/cards";
import {
  CardId,
  type CardKind,
  type CardPriority,
  type ChannelId,
  type EnvironmentId,
  type OrchestrationChannelShell,
  type ProjectId,
} from "@iskra/contracts";
import { useId, useMemo, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
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
import { channelTitle } from "../channels/channels.logic";
import {
  SHEET_INPUT_CLASS,
  SHEET_TEXTAREA_CLASS,
  SheetGroup,
  SheetRow,
} from "../channels/SheetList";
import { toastCommandFailure } from "../toastCommandFailure";
import { DisabledReason } from "./DisabledReason";

const NO_CHANNEL = "none";

const channelTitleById = (
  channels: ReadonlyArray<Pick<OrchestrationChannelShell, "id" | "kind" | "name">>,
  id: string,
) => {
  const channel = channels.find((entry) => entry.id === id);
  return channel === undefined ? "" : channelTitle(channel);
};

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
      // The project's Requests first, then its channels; DMs take no cards.
      allChannels
        .filter((channel) => channel.projectId === props.projectId && channel.kind !== "dm")
        .toSorted(
          (left, right) => Number(right.kind === "requests") - Number(left.kind === "requests"),
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
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SheetGroup>
              <SheetRow as="label" label="Title">
                <Input
                  unstyled
                  aria-label="Title"
                  placeholder="Required"
                  autoFocus
                  className={SHEET_INPUT_CLASS}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </SheetRow>
              <Textarea
                unstyled
                aria-label="Spec"
                placeholder="What should be built, and how you will know it is done (optional)"
                className={cn(SHEET_TEXTAREA_CLASS, "px-4 py-2.5")}
                value={spec}
                onChange={(event) => setSpec(event.target.value)}
              />
            </SheetGroup>
            {kind === "migration" ? (
              <SheetGroup title="Migration">
                <SheetRow as="label" label="Items">
                  <Input
                    unstyled
                    aria-label="Command that lists the items"
                    placeholder="git ls-files 'src/**/*.test.js'"
                    className={SHEET_INPUT_CLASS}
                    value={enumerateCommand}
                    onChange={(event) => setEnumerateCommand(event.target.value)}
                  />
                </SheetRow>
                <Textarea
                  unstyled
                  aria-label="Instructions for each item"
                  placeholder="What to do to each item"
                  className={cn(SHEET_TEXTAREA_CLASS, "px-4 py-2.5")}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </SheetGroup>
            ) : null}
            <SheetGroup>
              <SheetRow label="Type">
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (value === "task" || value === "plan" || value === "migration")
                      setKind(value);
                  }}
                >
                  <SelectTrigger aria-label="Kind" variant="ghost" className="w-auto min-w-0">
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
              </SheetRow>
              <SheetRow label="Channel">
                <Select
                  value={channelId}
                  onValueChange={(value) => setChannelId(value ?? NO_CHANNEL)}
                >
                  <SelectTrigger aria-label="Channel" variant="ghost" className="w-auto min-w-0">
                    <SelectValue>
                      {(value: string | null) =>
                        value === null || value === NO_CHANNEL
                          ? "No channel"
                          : channelTitleById(channels, value)
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_CHANNEL}>No channel</SelectItem>
                    {channels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {channelTitle(channel)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </SheetRow>
              <SheetRow label="Priority">
                <Select
                  value={String(priority)}
                  onValueChange={(value) => setPriority(Number(value ?? 0) as CardPriority)}
                >
                  <SelectTrigger aria-label="Priority" variant="ghost" className="w-auto min-w-0">
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
              </SheetRow>
            </SheetGroup>
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
