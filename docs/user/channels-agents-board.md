# Channels, agents, and the board

You ask for work in a project's Requests. Its lead turns requests into cards on the board. Each card
gets an owner agent that works on it in its own session. You review the work, and Iskra lands it.

## What changed

- **Existing projects need their side-effect guard reviewed.** Agents don't start work on a
  project until someone goes through its [side-effect guard](#side-effect-guard).
- **Cards start on their own.** A ready card with an owner and confirmed acceptance criteria starts
  from the [queue](#the-queue) as soon as there is room. You no longer start sessions by hand.
- **Cards already in review have no evidence.** You can still approve their merge. To get evidence
  first, open the card and choose **Capture evidence** under Review: Iskra runs the checks on its
  current commit and records the result without moving the card.

## Guided first run

To see the whole loop before using your own project, choose **Guided first run** in the command
palette. It creates a small sample app with a failing test, its checks, and three agents, and walks
you through reviewing its side-effect guard, approving and starting its card, watching it reach
review, and approving the merge. Each step ticks off as it happens.

## Requests

Every project has **Requests**, below **Board** in the sidebar. Ask for work there, or choose **Ask
for something** on an empty board or in the command palette.

The first time, Requests asks you to choose who turns requests into cards. Pick an agent with the
lead role, or choose **Create a lead agent** to make one; the new agent dialog opens with the lead
role filled in. Until a lead is chosen, you can't send a message in Requests. The mobile app shows
Requests too, but the lead is chosen on a computer.

A message that mentions nobody goes to the lead. If the request is too vague, the lead asks one
question, usually with two or three answers and one it recommends. Pick one, or answer in your own
words without mentioning anyone. Once the request is clear, the lead proposes a card with acceptance
criteria, an estimate, and a suggested owner. The proposal appears under its reply with **Approve &
Start**, **Edit**, and **Drop**.

**Approve & Start** first shows what you are starting: the criteria to confirm or edit, and the
lead's estimate of size, likely areas, and risks. If the lead thinks the work should be several
cards, the preview says **Too big, split?** with its reasons. Starting confirms the criteria,
approves the spec, and assigns the owner you picked. The card then joins the queue.

Requests follows the card: Iskra notes when its owner starts work, asks you something, or sends it
to review, and when it lands or is dropped. **Open card** under a note opens the card. These notes
wake no agent.

Type `@` to mention an agent when you want a normal reply from it instead. Change or clear the lead
in Requests' settings. Requests can't be archived or renamed; it's the project's built-in
conversation.

## Channels

Most projects only need Requests. Create a channel when you want a separate topic with its own lead,
or a room for several agents: choose **+** on the Requests row in the sidebar, or **New channel** in
the command palette. Every agent in the project joins it.

Agents only reply when you mention them. Type `@` in the composer to pick one.

### The lead

A channel's lead is optional. With one, it works like the lead in [Requests](#requests): a message
that mentions nobody goes to it, and the cards it proposes leave their notes in the channel. With no
lead, a message that mentions nobody wakes nobody, and Iskra says so in the channel.

### Channel settings

Open settings from the gear in the channel header or on the channel's row in the sidebar. You can
rename the channel, set its topic, add or remove members, and choose the lead. Any agent with the
lead role can lead. On a narrow window, members and the lead are in settings, not beside the
messages.

**Archive** removes a channel from the sidebar. Choose **Undo** on the notice to bring it back.
Archived channels are listed under **Archived** in the sidebar, where **Unarchive** brings one back.
If you open an archived channel's link later, its page offers **Unarchive**.

Under an agent's reply, **Show work** opens the session behind it.

## Agents

Create an agent from **+** next to Agents in the sidebar, or with **New agent** in the command
palette. Each agent is a Markdown file in the project's `.iskra/agents` folder. Editing the file and
editing the agent's settings change the same thing.

Open an agent's settings from the gear on its sidebar row or on its page. There you can set its
name, model, role, tags, roles, and capabilities. Capabilities apply to card sessions. A new agent
can read, write, and run shell commands; network is off. An agent without write can't work on cards,
so its cards wait until you give it write. Channel conversations and direct messages can read the
project but never change it.

**Archive** deletes the agent's file. Archived agents are listed under **Archived** in the Agents
group, and their settings offer **Unarchive**.

### Models and providers

An agent's model can be on any provider that can enforce what the agent may do. Under
**Capabilities**, the settings say what the chosen provider's runs can do, or why they can't run,
and **Save** stays off until the two agree:

- **Claude** runs can read, edit, use a shell, and reach the domains the project allows.
- **OpenCode** runs can read and edit files but can't use a shell or the network. That suits
  verifiers, helpers, and critics; an agent that builds with shell commands stays on Claude. An
  OpenCode instance set to use an external server can't run agents.
- **Codex** models are listed but can't run agents yet.

### Roles

Roles say what an agent may be asked to do. Each piece of work is its own session of the agent, so
one agent can work on a card, answer in two channels, and verify another card at once.

- **Builder** works on cards.
- **Lead** turns requests into cards, from Requests or a channel.
- **Helper** answers a builder's question.
- **Critic** critiques a card's spec or diff.
- **Verifier** checks cards in review against their criteria.

Agents made before roles keep builder, lead, helper, and critic. Verifying is something you turn on
for an agent.

For a builder, **Verified by** names the agent that checks its cards first; **Automatic** lets Iskra
choose (see [Verifier](#verifier)). **Blueprint** adds steps to its cards: **Preflight** runs
targeted checks before the full checks, **Screenshots** chooses when review captures the preview,
**UI paths** lists pages to capture, and **Verify its cards** can require the verifier even when the
project doesn't. A blueprint only adds steps; checks, journeys, and the scope judge always run.

### Direct messages

Select an agent in the sidebar to message it directly. The agent can read the project but not
change it; changes need a card. A message starts its own session right away, even while the agent
works somewhere else. When every session slot on this machine is taken, it waits for one.

**Live now** on the agent's page lists what it is doing at the moment and where. **Sessions** lists
its work in channels and on cards. Stop a live session there, or choose it as the composer's target
to message it.

## The board

Open a project's board from **Board** in the sidebar or the command palette. A card moves through
Triage, Ready, In progress, Review, Landing, and Done.

Create a card with **New card** on the board or in the command palette. Click a card to open it.
From there you can edit its title, spec, and acceptance criteria, assign an agent, move it along, or
abandon it.

To keep cards in step with Linear issues, see [Linear](./linear.md).

### Acceptance criteria

Every card is held to its acceptance criteria. Work doesn't start until a person confirms them,
with **Approve & Start** or by approving the card. Mark a criterion **Needs your check** when Iskra
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
- **Waiting for a safety check**: see [Side-effect guard](#side-effect-guard).
- **Its agent can only read**: give the agent write in its settings. Needs you lists this too.

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

### Helpers and critics

While it works, an owner can ask a helper a question or ask a critic to look at its spec or its
diff. The answer comes back to the owner as its next message, and shows on the card's activity. A
card has at most two helper or critic sessions open at once. Only agents with the helper or critic
role are asked, and they can read the project but not change it.

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

### Verifier

Turn on **Verifier** in [project orchestration](#project-orchestration), or set a builder's
blueprint to always verify its cards. A card entering review is then checked by a second agent before
you can approve its merge. The verifier sees the criteria, the evidence, and the diff, but not the
owner's plan, decisions, or messages.

Iskra picks the verifier in this order: the builder's **Verified by** agent, an agent with the
verifier role on another provider that can run it, another model on the builder's provider, and
last the builder's own model in a fresh session. Review names the verifier and says which of these
it is.

Review then shows each criterion as passed or failed with the verifier's note, its concerns about
the diff, and how many [hidden scenarios](#hidden-scenarios) held. A failed verdict sends the card
back to its owner with the notes, which counts as a review fix round. **Approve merge** stays off,
saying so, until the verifier passes the card's latest commit.

- **Rerun verifier** checks the latest commit again once the current check has finished; while a
  verifier is still at work, Iskra refuses it. It is also in the command palette for cards in review.
- **Override** lets the card merge without a passing verdict. Say why; the reason stays on the card.

If the verifier's session fails twice, Needs you shows **The verifier didn't finish** with **Rerun
verifier**.

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

### Plan cards

For work too big for one card, create a card with kind **Plan** and give it acceptance criteria.
Assign it an agent with the coordinator role and approve it. The coordinator reads the project and
proposes child cards, grouped into slices, with what each depends on. It can't change anything or
approve its own plan.

Needs you shows **Plan to approve**. The card's **Plan** section lists the children by slice, with
their criteria and suggested agent. **Approve plan** creates them all, ready to start, or
**Redirect** tells the coordinator what to change and it proposes a new revision to approve.

Children land into the plan's own branch, never the base branch. A child waits on the children it
depends on, and children in a later slice show **Held for slice checkpoint** until you continue:
when a slice lands, Needs you asks **A plan slice landed; continue?** with **Continue**,
**Redirect**, or **Stop**. When every child has landed, the plan card goes to review with one pull
request for the whole plan, and you approve its merge. Children spend from the plan's budget.

### Migration cards

To make one change across many files, create a card with kind **Migration**, with the command that
prints one item per line and the instructions for each item. Iskra runs the command, starts a sample
of three items as child cards, and then waits: check the sample's cards, change the instructions if
they need it with **Save instructions**, and choose **Sweep the rest**. Items then start in batches as
session slots allow. Each item lands into the migration's own branch once its checks pass. An item
that keeps failing is marked blocked and the rest carry on. When every item has landed or is blocked,
the migration card goes to review with one pull request, and you approve its merge. A migration lists
at most 1000 items; split a longer one.

### Undo, revert, and restore

- **Undo**: pausing, abandoning, sending a card back to triage, snoozing, and adding a relation each
  show a toast with **Undo** for a few seconds.
- **Revert**: on a landed card, **Revert…** under Outcome makes a new card that reverts its commit,
  runs the checks, and goes straight to review without an agent. You approve its merge like any
  other. If the revert conflicts, Needs you offers **Assign an agent** to resolve it.
- **Restore**: on a paused card, choose a turn and **Restore** to put its worktree back to how it was
  before that turn of its agent. Pause the card first; Iskra refuses while its agent is working.

### Outcomes

A week after a card lands, Iskra labels how it turned out: **Success**, **Flawed** if it was reverted
or broke CI on the base branch, or **Manual** if a person changed its branch outside Iskra. A card
abandoned after its fix rounds ran out or its session failed is **Blocked** at once. These are
heuristics; set the outcome yourself under **Outcome** with a note saying why.

A flawed card shows in Needs you with **Add hidden scenario**, prefilled from its criteria, so the
verifier checks future cards for the same mistake.

The same records show as a hint in **Before it starts** and on an agent's page, for example
"@builder: 8/10 merged, 1 flawed, $3.40 per merged card" over the last 30 days.

### Branches or tags changed outside a card

An agent's shell can reach the repository's other branches. If a branch or tag other than the card's
own changes while an agent works, Iskra pauses the card and lists the changes. It never puts them
back on its own, since you may have made them yourself. Choose **Restore** to put the refs back
(a ref that changed again since is left alone), or **Keep**, then **Resume** the card.

## Needs you

**Needs you** at the top of the sidebar collects everything waiting on you across projects:
cards to approve, specs to review, open cards with no agent or no acceptance criteria, cards whose
agent can only read, questions from agents, comments on a card's pull request from
people outside the repository, merges the host refused, verifiers that didn't finish, card services
or previews that went down, branches or tags that changed outside a card while its agent worked,
plans to approve, plan slices that landed, lessons agents proposed, flawed outcomes, conflicting
reverts, network access agents request, and monthly budgets that hold work. Decide most of them right in the list: answer a question in one click,
approve or dismiss a lesson,
forward a comment to the agent or dismiss it, retry a landing, rerun a verifier, restart a card's
services, allow an agent's network access for the project, or restore or keep changed refs and then
resume the card. **Approve & Start** on a proposal starts it with the owner you pick.

## Project orchestration

Open **Settings → Projects** and choose the project (see [settings](./project-settings.md)) to find
its **Agent orchestration** section. It sets the base branch cards
start from and land into, how cards land, the project's session cap, how many agent pull requests may
wait for review, fix rounds, **Review without checks**, the [verifier](#verifier), and the sections
below.

### Side-effect guard

Agents run your project's code, so before they start on a project, someone confirms that nothing in
it posts, emails or charges real accounts on its own. **Open the checklist** in Needs you, or open the
project in **Settings → Projects**, where the checklist leads the page until it's reviewed:

- Nothing runs on a schedule or in the background (crons, queues, workers) that posts, sends or
  charges on its own, or you've turned it off.
- You know which outside services the code calls (publishing, email, payments), and you've denied the
  risky ones under **Network for agent shells**.
- Optionally, name the environment variable that turns those actions off, once you've checked that
  the code reads it. Cards then run with it set.

For a small or local-only project with no such integrations, tick both boxes and choose
**Acknowledge**. **Review again** takes it back.

### Hidden scenarios

**Hidden scenarios** are checks only the verifier knows about, so an owner can't write its work to
pass them. Add one with a title and either a description of what to check or a command to run, with
a time limit of up to 30 minutes. A command runs in the verifier's copy of the card, and passes when
it exits 0.

Scenarios are stored on the machine running Iskra, never in the repository. The list shows titles;
open **Edit** to see or change one. Owners only learn how many scenarios failed. The limits: the
verifier's session keeps them in its history on this machine, so anyone who opens that session can
read them, and a provider that can't keep an agent out of
Iskra's data folder, like Codex, can't run agents here for that reason.

### Auto-merge

**Auto-merge**, off by default, lands cards without a click. It needs the [verifier](#verifier) on,
so Iskra refuses to turn it on otherwise. A card then lands on its own only when its checks and
evidence pass, the verifier passed its latest commit, at least one hidden scenario ran, and at least
the share set under **Scenarios held** passed. A card still waits for you when it has flagged changes
to acknowledge, when a person overrode its verifier, or when a trigger started it. Its activity says
why it waits.

### Triggers

**Triggers** turn outside events into cards:

- **CI fails on a branch**: a failed CI run on the base branch, or the branch you name.
- **A pull request comment mentions @iskra**: on a pull request no card owns. Only comments from
  people with write access to the repository count; others are refused and listed under **Recent
  fires**.
- **On a schedule**: a cron expression in a time zone.

Each trigger has the title, spec, and acceptance criteria of the cards it makes. The text that
fired it, such as the comment, is added to the spec as untrusted input for the agent to read, never
as instructions. Criteria always come from the trigger. Cards go to triage, except that a schedule
trigger with criteria and an agent may **Start work** on its own. That work opens a draft pull request
and always waits for a person to merge it. The same event never makes two cards.

### Budgets

**Budgets** shows what the project spent this month, by agent, counting cards, leads, and
conversations. Set a monthly cap for the project and for each agent, and the budget new cards start
with. At a cap, new work waits with **Budget reached**, messages to agents are refused with the reason,
and Needs you links here to raise it. A turn that runs well past a cap is interrupted and its card
paused. The whole machine's monthly budget across projects is under **Card runtime** in **Settings →
Agents & Providers**. A new month starts from zero.

### Knowledge

While they work, agents can propose lessons about the project, such as a command that must run before
the tests. Lessons wait in Needs you and under **Knowledge** until you **Approve** or **Dismiss** them.
An approved lesson goes into the brief of every card that touches its paths, or every card when it
names none. **Remove** takes one back.

### Network for agent shells

**None**, the default, gives agents' shells no network. **Allowlist** allows only the domains under
**Allowed domains**, and web fetches follow the same list. A domain listed as both allowed and
denied stops agent runs from starting.

An agent's **Network** capability only reaches the domains on this list. When the sandbox blocks a
domain an agent needs, it requests access instead of asking you to run commands. The request shows
in Needs you and on the card with the agent's reason: **Allow for this project** switches the list to
**Allowlist**, adds the domains, and the agent continues with them on its next turn; **Dismiss** tells
the agent to work without them.

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
- **Journeys** run after the checks against the card's running services, such as
  `{ "id": "health", "name": "Health", "command": "node journey.js" }`, with the card's ports in
  `ISKRA_PORT_<NAME>`. Each gets 10 minutes by default and 60 at most.
  A failing journey sends the card back to its owner. Review lists each journey with its output,
  and a local landing runs them again after rebasing.

If the server restarts, Iskra starts a card's services again when the card next needs them. When a
service or the preview stops answering for a minute while a card is in review, Iskra restarts it and
Needs you shows **Service down** or **Preview down**. **Restart** there starts the card's services and
preview again yourself.

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
