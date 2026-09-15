# Channels, agents, and the board

You talk to agents in channels. A channel's lead turns requests into cards on the board. Each card
gets an owner agent that works on it in its own session. You review the work, and Iskra lands it.

## What changed

- **Existing projects need their side-effect guard reviewed.** Agents don't start work on a
  project until someone goes through its [side-effect guard](#side-effect-guard).
- **Cards start on their own.** A ready card with an owner and confirmed acceptance criteria starts
  from the [queue](#the-queue) as soon as there is room. You no longer start sessions by hand.
- **Cards already in review have no evidence.** You can still approve their merge. To get evidence
  first, open the card and choose **Capture evidence** under Review: Iskra runs the checks on its
  current commit and records the result without moving the card.

## Channels

Create a channel from **+** next to Channels in the sidebar, or with **New channel** in the command
palette. Every agent in the project joins it.

Agents only reply when you mention them. Type `@` in the composer to pick one.

### The lead

A lead is optional. With one, a message that mentions nobody goes to the lead. If the request is too
vague, the lead asks one question in the channel, usually with two or three answers and one it
recommends. Pick one, or answer in your own words without mentioning anyone. Once the request is
clear, the lead proposes a card with acceptance criteria, an estimate, and a suggested owner. The
proposal appears under its reply with **Approve & start**, **Edit**, and **Drop**.

**Approve & start** first shows what you are starting: the criteria to confirm or edit, and the
lead's estimate of size, likely areas, and risks. If the lead thinks the work should be several
cards, the preview says **Too big, split?** with its reasons. Starting confirms the criteria,
approves the spec, and assigns the owner you picked. The card then joins the queue.

The channel follows the card: Iskra notes when its owner starts work, asks you something, or sends
it to review, and when it lands or is dropped. **Open card** under a note opens the card. These
notes wake no agent.

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
name, model, role, tags, and capabilities. Only Claude models can run agents on cards. Capabilities
apply to card sessions. Channel conversations and direct messages can read the project but never
change it.

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
From there you can edit its title, spec, and acceptance criteria, assign an agent, move it along, or
abandon it.

To keep cards in step with Linear issues, see [Linear](./linear.md).

### Acceptance criteria

Every card is held to its acceptance criteria. Work doesn't start until a person confirms them,
with **Approve & start** or by approving the card. Mark a criterion **Needs your check** when Iskra
can't verify it for you, such as behavior in a mobile app; review then asks you to check it yourself.

### The queue

A card starts when it is ready, has an owner, and its criteria are confirmed. Cards start by
priority, then by how long they have waited. The board, the card, and Needs you say why a card
waits:

- **Waiting for a session slot**: this machine, or the project's **Session cap**, has no free agent
  session. An owner whose card is in review, or that has waited a while for your answer, gives its
  slot back.
- **Waiting for machine capacity**: checks, setup, and evidence capture run a few at a time across
  the machine, and only while load and free memory allow.
- **Waiting on a blocker**: a card it is blocked by has not landed.
- **Waiting for agent pull requests to be reviewed**: the project has as many open agent pull
  requests as it allows.
- **Waiting for the side-effect guard**: see [Side-effect guard](#side-effect-guard).

**Pause** on a card holds it out of the queue until you **Resume** it. Iskra pauses a card itself
when its session keeps failing, it seems stuck, it runs too long, it spends well past its budget, or
it uses up its fix rounds. The card says why.

If an owner's session is lost, for example when the server restarts, Iskra starts a new one from the
card's worklog: its criteria, plan, decisions, questions and answers, messages, and latest evidence.
Messages the old session never read are delivered to the new one. After repeated losses within an
hour, the card pauses instead.

### Questions and checkpoints

An owner that is stuck asks on the card, usually with a few answers and one it recommends. Answer on
the card or in Needs you, with one click or in your own words.

Before a costly direction, an owner can ask for a checkpoint. Iskra captures evidence of the work so
far, and you choose **Continue**, **Redirect** with a note, or **Stop**, which pauses the card.

### Review

Agents can't move their own cards into review. When an owner asks for review, Iskra commits what it
left, rebases it onto the base branch, and runs the project's checks. It also flags changes a person
should see, such as deleted or skipped tests, dependency downgrades, changes to `.iskra/` or CI
workflows, and files outside the estimate's likely areas. When UI files changed, it screenshots the
app from the project's run script. The card enters review only when the checks pass on its latest
commit.

Review shows the evidence for each criterion, the full check logs, and the agent's risk claims,
which are labelled as its own assessment. Screenshots need the desktop app open and connected;
without it, the screenshot shows as not captured, and review goes ahead. Acknowledge flagged changes
such as deleted tests before approving the merge.

A project without checks can't send cards to review. Add check scripts, or turn on **Review without
checks** in [project orchestration](#project-orchestration) for a project with nothing to run.

### Fix rounds

Failing checks, failing CI, and review comments send a card back to its owner on their own. By
default that happens twice for CI and twice for review; change it under **Fix rounds**. After that
the card pauses as **Fix rounds used up**, and **Give it more rounds** in Needs you resets them.

### Landing

Only a person approves a merge. How a card lands depends on its project:

- **By pull request**, when the repository has a remote and you are signed in to its host, or when
  **Landing** is set to **Pull request**. Iskra pushes the card's branch and opens the pull request
  against the base branch when the card enters review. Failing CI goes back to the owner, and so do
  comments from collaborators with write access. **Approve merge** makes Iskra merge on the host. If
  the host refuses, Needs you offers to retry. A pull request you merge on the host lands the card
  too.
- **Locally**, without a remote. **Approve merge** rebases the card, runs the checks again, and
  fast-forwards the base branch.

Comments on the pull request from people without write access wait in Needs you. **Forward** sends
one to the agent as a suggestion, and **Dismiss** sets it aside. If the host can't say who has write
access, only the account Iskra is signed in as is trusted.

Checks that only run in CI need a pull request. A card enters review with those checks still
pending, and its merge waits until CI reports on its latest commit. Without a remote, such a
project's cards can't enter review.

### Branches or tags changed outside a card

An agent's shell can reach the repository's other branches. If a branch or tag other than the card's
own changes while an agent works, Iskra pauses the card and lists the changes. It never puts them
back on its own, since you may have made them yourself. Choose **Restore** to put the refs back
(a ref that changed again since is left alone), or **Keep**, then **Resume** the card.

## Needs you

**Needs you** at the top of the sidebar collects everything waiting on you across projects:
cards to approve, specs to review, questions from agents, comments on a card's pull request from
people outside the repository, merges the host refused, and branches or tags that changed outside a
card while its agent worked. Decide most of them right in the list: answer a question in one click,
forward a comment to the agent or dismiss it, retry a landing, or restore or keep changed refs and
then resume the card. **Approve & start** on a proposal starts it with the owner you pick.

## Project orchestration

Choose the project in the Settings breadcrumb (see [settings](./project-settings.md)) to find its
**Agent orchestration** section. It sets the base branch cards
start from and land into, how cards land, the project's session cap, how many agent pull requests may
wait for review, fix rounds, **Review without checks**, and the sections below.

### Side-effect guard

Agents don't start work on a project until someone goes through its side-effect guard checklist:
check the project's scheduled jobs and workers for anything that could act on real accounts, check
which outbound APIs it calls (publishing, email, payments) and deny the risky ones, and optionally
name the environment variable that turns those actions off, after verifying that the code reads it.
Projects created before this update need it too.

### Network for agent shells

**None**, the default, gives agents' shells no network. **Allowlist** allows only the domains under
**Allowed domains**, and web fetches follow the same list. A domain listed as both allowed and
denied stops agent runs from starting.

### Heavy commands

Commands listed under **Heavy commands**, such as full test suites, are refused in an agent's shell.
The agent runs them through Iskra instead, so they wait for machine capacity. A single test file is
still fine.

### Exclusive paths

List paths, one per line as `glob => command`, where only one card at a time may land changes, such
as database migrations. When one lands, other open cards touching the same path go back to their
agents, which rebase and run the command before asking for review again.

## Per-card services and environment

Each card works in its own worktree with a block of 10 ports. Its setup, run, archive, and check
scripts receive:

| Variable                                  | Value                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| `ISKRA_CARD_ID`                           | The card's id.                                                 |
| `ISKRA_CARD_SLUG`                         | `c` and the last 6 letters or digits of the id.                |
| `ISKRA_PORT_BASE`, `ISKRA_PORT`           | The first port of the card's block.                            |
| `ISKRA_PORT_COUNT`                        | `10`.                                                          |
| `ISKRA_PORT_<NAME>`                       | A named port, such as `ISKRA_PORT_PUBLIC_API` for `publicApi`. |
| `TURBO_CONCURRENCY`, `VITEST_MAX_WORKERS` | Worker counts sized to this machine.                           |
| `NODE_OPTIONS`, `CI`                      | A capped Node heap, and `CI=1`.                                |

Use the setup script to create what a card needs, such as a test database named after
`ISKRA_CARD_SLUG`, and the archive script to remove it when the card lands or is dropped.

Describe the rest in `.iskra/project.json`. Iskra reads it from the base branch on the remote, so a
change an agent makes to it on its own branch has no effect until it is merged:

```json
{
  "ports": { "web": 0, "server": 1 },
  "envFiles": [{ "template": "apps/web/.env.template", "target": "apps/web/.env.local" }],
  "services": [
    {
      "name": "server",
      "port": "server",
      "start": "pnpm dev:server",
      "ready": { "kind": "http", "path": "/health" }
    }
  ],
  "checks": [
    { "id": "typecheck", "name": "Typecheck", "command": "pnpm typecheck" },
    {
      "id": "test",
      "name": "Tests",
      "command": "pnpm test",
      "targetedCommand": "pnpm test {filter}"
    },
    { "id": "e2e", "name": "E2E", "command": "pnpm e2e", "source": "ci", "ciName": "e2e" }
  ]
}
```

- **Ports** are offsets from 0 to 9 in the card's block. Previews use the `web` port.
- **Env files** are rendered before the agent starts. Templates can use `${port:NAME}`,
  `${card:slug}`, `${card:id}`, and `${secret:NAME}`. A target must be gitignored.
- **Services** start in order after setup, each waiting until its port answers, and stop when the
  card lands or is dropped.
- **Checks** run in order, one at a time, at lower CPU priority, and stop at the first failure. Each
  gets 10 minutes by default and 60 at most, and a timeout keeps the end of its output. `source` is
  `local`, `ci` (read from the pull request's checks), or `both`. Without a checks list, the
  project's scripts with the check role run instead.

## Secrets

Add secrets under **Card secrets** in the project's settings. A value is stored on this machine and
never shown again. Each secret has an exposure:

- **Setup only**: available to the setup script's environment and nothing else.
- **Workspace**: may also be written into env files, where the card's agent can read it.

The archive script and checks get no secrets, because they run code the agent may have changed.
Tear down per-card resources with local, non-secret credentials.

## Shortcuts

| Action      | Default shortcut |
| ----------- | ---------------- |
| Needs you   | `mod+shift+y`    |
| Board       | `mod+shift+b`    |
| New channel | `mod+shift+h`    |

`mod` is Command on macOS and Control elsewhere. Change them in
**Settings → Keybindings**; see [keybindings](./keybindings.md).
