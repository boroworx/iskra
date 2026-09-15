import { type ResolvedKeybindingsConfig } from "@iskra/contracts";
import { ChevronRightIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { cn } from "~/lib/utils";

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function HighlightedSearchText(props: { text: string; query: string }) {
  const query = props.query.trim();
  if (query.length === 0) return props.text;

  const normalizedText = foldAsciiCase(props.text);
  const normalizedQuery = foldAsciiCase(query);
  const parts: Array<{
    readonly text: string;
    readonly highlighted: boolean;
    readonly start: number;
  }> = [];
  let cursor = 0;

  while (cursor < props.text.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
    if (matchIndex === -1) {
      parts.push({ text: props.text.slice(cursor), highlighted: false, start: cursor });
      break;
    }
    if (matchIndex > cursor) {
      parts.push({
        text: props.text.slice(cursor, matchIndex),
        highlighted: false,
        start: cursor,
      });
    }
    parts.push({
      text: props.text.slice(matchIndex, matchIndex + query.length),
      highlighted: true,
      start: matchIndex,
    });
    cursor = matchIndex + query.length;
  }

  return parts.map((part) =>
    part.highlighted ? (
      <mark className="bg-transparent font-semibold text-foreground" key={part.start}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

function ThreadContentMatch(props: {
  match: NonNullable<CommandPaletteActionItem["threadContentMatch"]>;
}) {
  const isUser = props.match.source === "user";
  return (
    <span className="truncate text-xs text-muted-foreground">
      <span className={isUser ? "text-blue-400" : "text-emerald-400"}>
        {isUser ? "You:" : "Agent:"}
      </span>{" "}
      <HighlightedSearchText text={props.match.snippet} query={props.match.query} />
    </span>
  );
}

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {props.emptyStateMessage ??
          (props.isActionsOnly
            ? "No matching actions."
            : "No matching commands, projects, or threads.")}
      </div>
    );
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel className="ps-[9px]">{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

/** A result on one 28px line: its title, then its project or path as trailing tertiary text. */
function CommandPaletteResultLabel(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  const { item } = props;
  const line = (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-foreground">
      {item.titleLeadingContent}
      <span className="truncate">{item.title}</span>
      {item.description ? (
        <span className="min-w-0 shrink-[2] truncate text-tertiary-label">{item.description}</span>
      ) : null}
    </span>
  );
  return item.threadContentMatch ? (
    <span className="flex min-w-0 flex-1 flex-col">
      {line}
      <ThreadContentMatch match={item.threadContentMatch} />
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 items-center">{line}</span>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  return (
    <div className="flex min-h-7 select-none items-center gap-2 rounded-[6px] px-2 py-1 text-[13px] opacity-64">
      {props.item.icon}
      <CommandPaletteResultLabel item={props.item} />
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      value={props.item.value}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      <CommandPaletteResultLabel item={props.item} />
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-tertiary-label">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-tertiary-label" />
      ) : null}
    </CommandItem>
  );
}
