# Linear

Iskra keeps cards and Linear issues in sync both ways. It polls Linear once a minute, so a server
on your own machine works without a public URL.

## Set it up

1. In Linear, create an OAuth application under Settings → API, and turn on client credentials.
2. In Settings → Integrations, enter the app's **Linear client ID** and **Linear client secret**.
   The secret stays on the server. On a server you start yourself, `ISKRA_LINEAR_CLIENT_ID` and
   `ISKRA_LINEAR_CLIENT_SECRET` work too.
3. Set **Linear team** to the team's ID, for all projects or for each project. To also bring in
   issues that aren't delegated to Iskra, set **Linear label**: open issues in the team with that
   label become cards waiting in triage.

## What syncs

- **Delegating an issue to Iskra** in Linear turns it into a card that is ready for work.
- **Approving a card** in Iskra creates an issue in the project's team.
- **Title and description** sync both ways with the card's title and spec. If both sides changed,
  the later edit wins. Editing the description in Linear sends the spec back for approval.
- **Comments** sync both ways. A comment from Linear reaches the card's agent. If the agent has
  asked a question, your next comment on the issue answers it.
- **Status** follows the card. In Linear you can approve a card by moving a triage issue to a to-do
  state, and abandon it by canceling the issue. Any other status change is moved back, and Iskra
  leaves a comment explaining why.
