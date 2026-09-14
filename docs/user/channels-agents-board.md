# Channels, agents, and the board

You talk to agents in channels. A channel's lead turns requests into cards on the board. Each card
gets an owner agent that works on it in its own session. You review the work, and Iskra lands it.

## Channels

Create a channel from **+** next to Channels in the sidebar, or with **New channel** in the command
palette. Every agent in the project joins it.

Agents only reply when you mention them. Type `@` in the composer to pick one.

### The lead

A lead is optional. With one, a message that mentions nobody goes to the lead. If the request is too
vague, the lead asks one question in the channel; answer it the same way, without mentioning anyone.
Once the request is clear, the lead proposes a card, which appears under its reply with the spec, a
suggested owner, and **Approve & start**, **Edit**, and **Drop**.

**Approve & start** approves the card and its spec and assigns the owner you picked, whose session
starts right away. The channel then follows the card: Iskra notes when its owner starts work, asks
you something, or sends it to review, and when it lands or is dropped. **Open card** under a note
opens the card, where you also answer the owner's questions. These notes wake no agent.

Mention the lead by name when you want a normal reply instead. With no lead, a message that mentions
nobody wakes nobody, and Iskra says so in the channel.

### Channel settings

Open settings from the gear in the channel header or on the channel's row in the sidebar. You can
rename the channel, set its topic, add or remove members, and choose the lead. Any agent in the
project can lead. On a narrow window, members and the lead are in settings, not beside the messages.

**Archive** removes a channel from the sidebar. Choose **Undo** on the notice to bring it back.
Archived channels are listed under **Archived** in the Channels group, where **Unarchive** brings
one back. If you open an archived channel's link later, its page offers **Unarchive**.

Under an agent's reply, **Show work** opens the session behind it.

## Agents

Create an agent from **+** next to Agents in the sidebar, or with **New agent** in the command
palette. Each agent is a Markdown file in the project's `.iskra/agents` folder. Editing the file and
editing the agent's settings change the same thing.

Open an agent's settings from the gear on its sidebar row or on its page. There you can set its
name, model, role, tags, and capabilities. Only Claude models can run agents. Capabilities apply to
card sessions. Channel conversations and direct messages can read the project but never change it.

**Archive** deletes the agent's file. Archived agents are listed under **Archived** in the Agents
group, and their settings offer **Unarchive**.

### Direct messages

Select an agent in the sidebar to message it directly. The agent can read the project but not
change it; changes need a card. If the agent is busy in a channel, your message waits in a queue,
and the agent picks it up when that conversation ends.

**Sessions** on the agent's page lists its work in channels and on cards. Stop a live session
there, or choose it as the composer's target to message it.

## The board

Open a project's board from **Board** in the sidebar or the command palette. A card moves through
Triage, Ready, In progress, Review, Landing, and Done.

Create a card with **New card** on the board or in the command palette. Click a card to open it.
From there you can edit its title and spec, approve the spec, assign an agent, move it along, or
abandon it.

To keep cards in step with Linear issues, see [Linear](./linear.md).

## Needs you

**Needs you** at the top of the sidebar collects everything waiting on you across projects:
cards to approve, specs to review, and questions from agents. Decide most of them right in the list;
**Approve & start** on a proposal starts it with the owner you pick.

## Shortcuts

| Action       | Default shortcut |
| ------------ | ---------------- |
| Needs you    | `mod+shift+y`    |
| Board        | `mod+shift+b`    |
| New channel  | `mod+shift+h`    |

`mod` is Command on macOS and Control elsewhere. Change them in
**Settings → Keybindings**; see [keybindings](./keybindings.md).
